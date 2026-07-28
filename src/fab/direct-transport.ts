import { FabClientError, nullFabLogger, type FabLogger } from "./errors.js";

const FAB_ORIGIN = "https://www.fab.com";
const LISTING_ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LISTING_DETAIL_PATH = new RegExp(`^/i/listings/${LISTING_ID}$`, "i");
const ASSET_FORMAT_CODE = "[a-z0-9][a-z0-9-]{0,39}";
const ASSET_FORMATS_PATH = new RegExp(
  `^/i/listings/${LISTING_ID}/asset-formats/${ASSET_FORMAT_CODE}$`,
  "i",
);
const DOWNLOAD_INFO_PATH = new RegExp(
  `^/i/listings/${LISTING_ID}/asset-formats/${ASSET_FORMAT_CODE}/files/${LISTING_ID}/download-info$`,
  "i",
);
const ALLOWED_PUBLIC_API_PATHS = new Set([
  "/i/listings/search",
  "/i/public/taxonomy",
  "/i/public/limited-time-free",
]);

export { FabClientError, type FabErrorCode } from "./errors.js";

export type FabDownloadFormat =
  | "blender"
  | "fbx"
  | "glb"
  | "gltf"
  | "maya"
  | "obj"
  | "unity";

export interface FabDownloadRequest {
  listingId: string;
  format: FabDownloadFormat;
}

export interface FabDownloadResult {
  listingId: string;
  format: FabDownloadFormat;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  alreadyExisted: boolean;
  authentication: "not-required";
}

export interface FabTransport {
  readonly name: "direct" | "browser";
  search(url: URL): Promise<unknown>;
  /**
   * Optional only to preserve the small Phase 1 fixture transport seam.
   * Production transports implement this operation.
   */
  getListing?(id: string, currency: string): Promise<unknown>;
  /**
   * Generic read operation used by later public Fab resources.
   * Production transports implement this operation.
   */
  request?(url: URL): Promise<unknown>;
  getLimitedTimeFreeIds?(limit: number): Promise<string[]>;
  downloadFreeAsset?(
    request: FabDownloadRequest,
  ): Promise<FabDownloadResult>;
  prepare?(): Promise<void>;
  close(): Promise<void>;
}

export interface DirectFabTransportOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  minimumIntervalMs?: number;
  maxRetries?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: FabLogger;
}

export function assertAllowedFabApiUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.origin !== FAB_ORIGIN ||
    (!ALLOWED_PUBLIC_API_PATHS.has(url.pathname) &&
      !LISTING_DETAIL_PATH.test(url.pathname) &&
      !ASSET_FORMATS_PATH.test(url.pathname) &&
      !DOWNLOAD_INFO_PATH.test(url.pathname))
  ) {
    throw new FabClientError("FAB_INTERNAL", "Refused a non-Fab upstream URL.");
  }
}

/**
 * Signed download URLs are self-authorizing (token in the query string) but
 * must still point at an Epic-controlled distribution domain over TLS. The
 * observed pool rotates across providers (for example
 * `content-download-emp.distro.on.epicgames.com` and
 * `emp-fastly-stitched.epicgamescdn.com`), so the allowlist matches the
 * registrable Epic/Fab domain families rather than exact hosts.
 */
const ALLOWED_DOWNLOAD_DOMAIN_FAMILIES = [
  "fab.com",
  "epicgames.com",
  "epicgamescdn.com",
  "unrealengine.com",
];

export function assertAllowedFabDownloadUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const allowed =
    url.protocol === "https:" &&
    ALLOWED_DOWNLOAD_DOMAIN_FAMILIES.some(
      (family) => hostname === family || hostname.endsWith(`.${family}`),
    );
  if (!allowed) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab returned a download URL outside the approved distribution hosts.",
    );
  }
}

function retryAfterSeconds(
  response: Response,
  now: () => number,
): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now()) / 1_000))
    : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort and must not expose an upstream body.
  }
}

export class DirectFabTransport implements FabTransport {
  readonly name = "direct" as const;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly minimumIntervalMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: FabLogger;
  private pacingQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(options: DirectFabTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 750);
    this.maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? nullFabLogger;
  }

  async search(url: URL): Promise<unknown> {
    return this.request(url);
  }

  async getListing(id: string, currency: string): Promise<unknown> {
    const url = new URL(`/i/listings/${encodeURIComponent(id)}`, FAB_ORIGIN);
    url.searchParams.set("currency", currency);
    return this.request(url);
  }

  async request(url: URL): Promise<unknown> {
    assertAllowedFabApiUrl(url);

    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const response = await this.fetchOnce(url);
      const retryableStatus = [429, 502, 503, 504].includes(response.status);
      const retryAfter = retryAfterSeconds(response, this.now);
      this.logger.log("debug", "fab_upstream_response", {
        transport: this.name,
        status: response.status,
        attempt,
      });
      if (retryableStatus && attempt < this.maxRetries) {
        await cancelBody(response);
        const exponentialMs = 500 * 2 ** attempt;
        const jitterMs = Math.floor(this.random() * 250);
        const retryAfterMs = (retryAfter ?? 0) * 1_000;
        await this.sleep(Math.max(retryAfterMs, exponentialMs + jitterMs));
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const challenged =
        response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
        contentType.toLowerCase().includes("text/html");
      if (challenged) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_CHALLENGE",
          "Fab requested browser verification for this public request.",
        );
      }
      if (response.status === 404) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_NOT_FOUND",
          "The Fab resource was not found.",
        );
      }
      if (response.status === 429) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_RATE_LIMITED",
          "Fab rate-limited the request.",
          true,
          retryAfter,
        );
      }
      if (response.status === 401 || response.status === 403) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_ACCESS_DENIED",
          "Fab denied this anonymous public request.",
        );
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "Fab returned an unavailable response.",
          retryableStatus,
        );
      }
      if (!contentType.toLowerCase().includes("application/json")) {
        await cancelBody(response);
        throw new FabClientError(
          "FAB_UPSTREAM_CHANGED",
          "Fab returned an unexpected response format.",
        );
      }

      try {
        return await response.json();
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_CHANGED",
          "Fab returned invalid JSON.",
        );
      }
    }
  }

  private async pace(): Promise<void> {
    const wait = this.pacingQueue.then(async () => {
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) await this.sleep(delay);
      this.nextRequestAt = this.now() + this.minimumIntervalMs;
    });
    this.pacingQueue = wait.catch(() => undefined);
    await wait;
  }

  private async fetchOnce(url: URL): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": "fab-mcp/0.1.0 (read-only public search)",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === "TimeoutError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new FabClientError(
          "FAB_TIMEOUT",
          "Fab did not respond before the request timeout.",
          true,
        );
      }
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "Fab could not be reached.",
        true,
      );
    }
  }

  async close(): Promise<void> {}
}
