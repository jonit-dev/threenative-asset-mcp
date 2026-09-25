import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  assertAllowedFabApiUrl,
  assertAllowedFabDownloadUrl,
  FabClientError,
  type FabDownloadFormat,
  type FabDownloadRequest,
  type FabDownloadResult,
} from "./direct-transport.js";
import { storeDownload } from "./download-store.js";
import { nullFabLogger, type FabLogger } from "./errors.js";

const FAB_ORIGIN = "https://www.fab.com";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fab exposes most MCP formats under a same-named asset-format code. GLB and
 * OBJ are usually served from the auto-conversion pool (`converted-files`)
 * and are selected by file extension there.
 */
const DIRECT_FORMAT_CODES: Record<FabDownloadFormat, string[]> = {
  blender: ["blender"],
  fbx: ["fbx"],
  glb: ["glb", "converted-files"],
  gltf: ["gltf"],
  maya: ["maya"],
  obj: ["obj", "converted-files"],
  unity: ["unity"],
};

export interface ApiDownloadOptions {
  request: FabDownloadRequest;
  /** Allow-listed anonymous JSON read (direct transport). */
  fetchJson: (url: URL) => Promise<unknown>;
  /** Streams a validated download URL to the given path. */
  downloader: (url: URL, destinationPath: string) => Promise<void>;
  downloadDir: string;
  maxBytes: number;
  logger?: FabLogger;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function listingFormatCodes(detail: Record<string, unknown>): string[] {
  const formats = Array.isArray(detail.assetFormats) ? detail.assetFormats : [];
  const codes: string[] = [];
  for (const entry of formats) {
    const code = asRecord(asRecord(entry)?.assetFormatType)?.code;
    if (typeof code === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(code)) {
      codes.push(code.toLowerCase());
    }
  }
  return [...new Set(codes)];
}

interface FormatFile {
  uid: string;
  name: string;
  size: number;
  fileType?: string;
}

function readyFiles(payload: unknown): FormatFile[] {
  const files = asRecord(payload)?.files;
  if (!Array.isArray(files)) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's asset-format response no longer matches the expected contract.",
    );
  }
  const ready: FormatFile[] = [];
  for (const entry of files) {
    const record = asRecord(entry);
    const uid = typeof record?.uid === "string" ? record.uid : "";
    const name = typeof record?.name === "string" ? record.name : "";
    const size = typeof record?.size === "number" ? record.size : 0;
    if (
      record?.status !== "ready" ||
      !UUID_PATTERN.test(uid) ||
      !name ||
      name.length > 180 ||
      size < 0
    ) {
      continue;
    }
    const fileType =
      typeof record.fileType === "string" ? record.fileType : undefined;
    ready.push({ uid, name, size, ...(fileType ? { fileType } : {}) });
  }
  return ready;
}

function selectFile(
  files: FormatFile[],
  format: FabDownloadFormat,
  code: string,
): FormatFile | undefined {
  if (code === "converted-files") {
    const extension = `.${format}`;
    return files.find((file) => file.name.toLowerCase().endsWith(extension));
  }
  const source = files.filter((file) => file.fileType === "source");
  const pool = source.length > 0 ? source : files;
  return pool.reduce<FormatFile | undefined>(
    (largest, file) => (file.size > (largest?.size ?? -1) ? file : largest),
    undefined,
  );
}

function signedDownloadUrl(payload: unknown, now: number): URL {
  const entries = asRecord(payload)?.downloadInfo;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's download-info response no longer matches the expected contract.",
    );
  }
  for (const entry of entries) {
    const record = asRecord(entry);
    const raw = record?.downloadUrl;
    if (typeof raw !== "string" || raw.length > 4_096) continue;
    const expires = record?.expires;
    if (
      typeof expires === "string" &&
      Number.isFinite(Date.parse(expires)) &&
      Date.parse(expires) <= now
    ) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    assertAllowedFabDownloadUrl(url);
    return url;
  }
  throw new FabClientError(
    "FAB_UPSTREAM_CHANGED",
    "Fab returned no usable download URL for this file.",
  );
}

/**
 * Resolves a free listing's file through Fab's anonymous JSON contract and
 * stores it. Throws FAB_CHALLENGE (via fetchJson) so the caller can fall
 * back to the browser click flow.
 */
export async function downloadFreeAssetViaApi(
  options: ApiDownloadOptions,
): Promise<FabDownloadResult> {
  const logger = options.logger ?? nullFabLogger;
  const { listingId, format } = options.request;

  const detailUrl = new URL(
    `/i/listings/${encodeURIComponent(listingId)}`,
    FAB_ORIGIN,
  );
  detailUrl.searchParams.set("currency", "USD");
  const detail = asRecord(await options.fetchJson(detailUrl));
  if (!detail) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's listing detail no longer matches the expected contract.",
    );
  }
  // Fab's own `isFree` flag lies for sponsored free listings ("add to library" at $0): the
  // flag stays false while every license's priceTier prices 0. The tiers are the truth users
  // see, so free is either the flag or all-zero tiers — not the flag alone.
  const licenses = Array.isArray(detail.licenses) ? detail.licenses : [];
  const freeByPriceTier =
    licenses.length > 0 &&
    licenses.every((license) => {
      const tier = asRecord(asRecord(license)?.priceTier);
      if (!tier) return false;
      const price = typeof tier.price === "number" ? tier.price : undefined;
      const amount = typeof tier.amount === "number" ? tier.amount : undefined;
      return price === 0 || amount === 0;
    });
  if (detail.isFree !== true && !freeByPriceTier) {
    // "Not free" is not "not yours". A paid listing the signed-in account already owns
    // downloads through the FabCLI path (fab_import_asset), which sees the library this
    // anonymous API call cannot. Route rather than dead-end.
    throw new FabClientError(
      "FAB_ACQUISITION_REQUIRED",
      "This listing is not fully free, so the anonymous download path stops here. If you already own it, call fab_import_asset with this listing — it downloads through your signed-in FabCLI library (run the FabCLI login once if it reports unauthenticated). The MCP did not start a purchase flow.",
    );
  }

  const available = listingFormatCodes(detail);
  const code = DIRECT_FORMAT_CODES[format].find((candidate) =>
    available.includes(candidate),
  );
  if (!code) {
    throw new FabClientError(
      "FAB_FORMAT_UNAVAILABLE",
      `Fab does not expose the requested ${format.toUpperCase()} file for this listing.`,
    );
  }

  const formatsUrl = new URL(
    `/i/listings/${encodeURIComponent(listingId)}/asset-formats/${code}`,
    FAB_ORIGIN,
  );
  const files = readyFiles(await options.fetchJson(formatsUrl));
  const file = selectFile(files, format, code);
  if (!file) {
    throw new FabClientError(
      "FAB_FORMAT_UNAVAILABLE",
      `Fab does not expose the requested ${format.toUpperCase()} file for this listing.`,
    );
  }
  if (file.size > options.maxBytes) {
    throw new FabClientError(
      "FAB_DOWNLOAD_TOO_LARGE",
      "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
    );
  }

  const infoUrl = new URL(
    `/i/listings/${encodeURIComponent(listingId)}/asset-formats/${code}/files/${encodeURIComponent(file.uid)}/download-info`,
    FAB_ORIGIN,
  );
  let infoPayload: unknown;
  try {
    infoPayload = await options.fetchJson(infoUrl);
  } catch (error) {
    if (error instanceof FabClientError && error.code === "FAB_ACCESS_DENIED") {
      throw new FabClientError(
        "FAB_ACQUISITION_REQUIRED",
        "Fab requires an account before this file can be downloaded. The MCP did not start that flow.",
      );
    }
    throw error;
  }
  const downloadUrl = signedDownloadUrl(infoPayload, Date.now());
  logger.log("debug", "fab_api_download_resolved", {
    listingId,
    format,
    code,
    fileName: file.name,
    sizeBytes: file.size,
  });

  return storeDownload({
    downloadDir: options.downloadDir,
    listingId,
    format,
    fileName: file.name,
    maxBytes: options.maxBytes,
    materialize: (temporaryPath) =>
      options.downloader(downloadUrl, temporaryPath),
  });
}

export interface NodeDownloadOptions {
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Fallback CDN downloader for hosts without curl-impersonate. Signed
 * distribution URLs are self-authorizing, so a plain TLS client is
 * acceptable for this hop.
 */
export async function nodeDownloadToFile(
  url: URL,
  destinationPath: string,
  options: NodeDownloadOptions,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "Fab could not complete the requested file download.",
      true,
    );
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "Fab could not complete the requested file download.",
      response.status >= 500,
    );
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > options.maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new FabClientError(
      "FAB_DOWNLOAD_TOO_LARGE",
      "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
    );
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("stream/web").ReadableStream),
      createWriteStream(destinationPath),
    );
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    if (error instanceof FabClientError) throw error;
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "The downloaded file could not be saved safely.",
      true,
    );
  }
  const metadata = await stat(destinationPath);
  if (metadata.size > options.maxBytes) {
    await unlink(destinationPath).catch(() => undefined);
    throw new FabClientError(
      "FAB_DOWNLOAD_TOO_LARGE",
      "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
    );
  }
}

export { assertAllowedFabApiUrl };
