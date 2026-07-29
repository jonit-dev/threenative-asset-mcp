import { DirectAssetDownloader } from "../download/direct-asset-downloader.js";
import { ITCH_PACKS, type ItchPack, type ItchPackId } from "./catalog.js";

export interface ItchDownloadEntry {
  uploadId: string;
  name: string;
  sizeLabel?: string;
  suggestedFileName: string;
}

export interface ItchPackDownloads {
  pack: ItchPack;
  downloads: ItchDownloadEntry[];
}

export interface ResolvedItchUpload {
  pack: ItchPack;
  upload: ItchDownloadEntry;
  signedFileUrl: string;
}

export class ItchAssetError extends Error {
  constructor(
    public readonly code:
      | "ITCH_PACK_NOT_FOUND"
      | "ITCH_UPLOAD_NOT_FOUND"
      | "ITCH_UPSTREAM_DENIED"
      | "ITCH_UPSTREAM_CHANGED"
      | "ITCH_UNSAFE_URL",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ItchAssetError";
  }
}

export interface ItchAssetClientOptions {
  fetch?: typeof globalThis.fetch;
  downloader?: DirectAssetDownloader;
  timeoutMs?: number;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function safeSuggestedFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 200);
  return /\.[A-Za-z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned}.zip`;
}

function parseDownloads(html: string): ItchDownloadEntry[] {
  const entries: ItchDownloadEntry[] = [];
  const uploadPattern = /data-upload_id="(\d+)"/g;
  for (const match of html.matchAll(uploadPattern)) {
    const uploadId = match[1];
    if (!uploadId || match.index === undefined) continue;
    const window = html.slice(match.index, match.index + 2_000);
    const nameMatch = window.match(/<strong[^>]*title="([^"]+)"[^>]*>/i);
    if (!nameMatch?.[1]) continue;
    const sizeMatch = window.match(
      /class="file_size"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i,
    );
    const name = decodeHtml(nameMatch[1]).trim();
    entries.push({
      uploadId,
      name,
      ...(sizeMatch?.[1] ? { sizeLabel: decodeHtml(sizeMatch[1]).trim() } : {}),
      suggestedFileName: safeSuggestedFileName(name),
    });
  }
  return entries;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ItchAssetClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly downloader: DirectAssetDownloader;
  private readonly timeoutMs: number;

  constructor(options: ItchAssetClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.downloader = options.downloader ?? new DirectAssetDownloader();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  getPack(packId: ItchPackId): ItchPack {
    const pack = ITCH_PACKS.find((candidate) => candidate.id === packId);
    if (!pack) {
      throw new ItchAssetError(
        "ITCH_PACK_NOT_FOUND",
        "The requested itch.io pack is not in the curated catalog.",
      );
    }
    return pack;
  }

  async listDownloads(packId: ItchPackId): Promise<ItchPackDownloads> {
    const { pack, downloads } = await this.resolveDownloadPage(packId);
    return { pack, downloads };
  }

  async download(packId: ItchPackId, uploadId: string) {
    const { pack, upload: selected, signedFileUrl } = await this.resolveUpload(
      packId,
      uploadId,
    );
    const result = await this.downloader.download({
      provider: "itch",
      url: signedFileUrl,
      fileName: selected.suggestedFileName,
      identity: `${pack.id}:${selected.uploadId}`,
      reportedSourceUrl: pack.pageUrl,
    });
    return { pack, upload: selected, result };
  }

  async resolveUpload(
    packId: ItchPackId,
    uploadId: string,
  ): Promise<ResolvedItchUpload> {
    const { pack, downloads, signedPageUrl } =
      await this.resolveDownloadPage(packId);
    const selected = downloads.find((entry) => entry.uploadId === uploadId);
    if (!selected) {
      throw new ItchAssetError(
        "ITCH_UPLOAD_NOT_FOUND",
        "The requested upload ID is not present on the freshly resolved itch.io download page.",
      );
    }

    const fileResponse = await this.requestJson(
      `${pack.pageUrl}/file/${encodeURIComponent(uploadId)}?source=game_download`,
      signedPageUrl,
    );
    const signedFileUrl = fileResponse.url;
    if (typeof signedFileUrl !== "string") {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_CHANGED",
        "itch.io did not return a signed file URL.",
      );
    }
    this.validateSignedFileUrl(signedFileUrl);
    return { pack, upload: selected, signedFileUrl };
  }

  private async resolveDownloadPage(packId: ItchPackId): Promise<{
    pack: ItchPack;
    downloads: ItchDownloadEntry[];
    signedPageUrl: string;
  }> {
    const pack = this.getPack(packId);
    const response = await this.requestJson(`${pack.pageUrl}/download_url`);
    const signedPageUrl = response.url;
    if (typeof signedPageUrl !== "string") {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_CHANGED",
        "itch.io did not return a signed download page URL.",
      );
    }
    this.validateSignedPageUrl(pack, signedPageUrl);

    const page = await this.fetch(signedPageUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "user-agent": "threenative-asset-mcp/0.4.0" },
    });
    if (!page.ok) {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_DENIED",
        `itch.io returned HTTP ${page.status} for the signed download page.`,
        page.status === 429 || page.status >= 500,
      );
    }
    const html = await page.text();
    const downloads = parseDownloads(html);
    if (downloads.length === 0) {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_CHANGED",
        "itch.io returned a download page without recognizable uploads.",
      );
    }
    return { pack, downloads, signedPageUrl };
  }

  private async requestJson(
    url: string,
    referer?: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": "threenative-asset-mcp/0.4.0",
        ...(referer ? { referer } : {}),
      },
    });
    if (!response.ok) {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_DENIED",
        `itch.io returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      const parsed = object(await response.json());
      if (!parsed) throw new Error("not an object");
      return parsed;
    } catch {
      throw new ItchAssetError(
        "ITCH_UPSTREAM_CHANGED",
        "itch.io returned invalid JSON.",
      );
    }
  }

  private validateSignedPageUrl(pack: ItchPack, value: string): void {
    let signed: URL;
    const page = new URL(pack.pageUrl);
    try {
      signed = new URL(value);
    } catch {
      throw new ItchAssetError("ITCH_UNSAFE_URL", "itch.io returned an invalid URL.");
    }
    if (
      signed.protocol !== "https:" ||
      signed.origin !== page.origin ||
      !signed.pathname.startsWith(`${page.pathname}/download/`)
    ) {
      throw new ItchAssetError(
        "ITCH_UNSAFE_URL",
        "itch.io returned a signed page URL outside the curated pack origin.",
      );
    }
  }

  private validateSignedFileUrl(value: string): void {
    let signed: URL;
    try {
      signed = new URL(value);
    } catch {
      throw new ItchAssetError(
        "ITCH_UNSAFE_URL",
        "itch.io returned an invalid file URL.",
      );
    }
    if (
      signed.protocol !== "https:" ||
      !/^itchio-mirror\.[0-9a-f]+\.r2\.cloudflarestorage\.com$/i.test(
        signed.hostname,
      ) ||
      !/^\/upload2\/game\/\d+\/\d+$/.test(signed.pathname) ||
      !signed.searchParams.has("X-Amz-Signature")
    ) {
      throw new ItchAssetError(
        "ITCH_UNSAFE_URL",
        "itch.io returned a signed file URL outside its official mirror contract.",
      );
    }
  }
}
