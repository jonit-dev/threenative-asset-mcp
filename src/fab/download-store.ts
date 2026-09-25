import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { FabClientError, type FabDownloadResult } from "./direct-transport.js";
import { sizeMeters } from "../gltf-size.js";

export function safeDownloadName(input: string): string {
  const leaf = basename(input).slice(0, 180);
  const safe = leaf.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") {
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "Fab returned an unsafe download filename.",
    );
  }
  return safe;
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function ensureCanonicalDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

export interface StoreDownloadOptions {
  downloadDir: string;
  listingId: string;
  format: string;
  fileName: string;
  maxBytes: number;
  /**
   * Writes the download to the given temporary path. Implementations: a
   * browser download's saveAs, or the validated CDN downloader.
   */
  materialize: (temporaryPath: string) => Promise<void>;
}

/**
 * Shared guarded persistence for Fab files: dedicated per-listing directory,
 * no symlink/overwrite, size cap, atomic-ish exclusive copy from a temporary
 * file, and a sha256 for integrity reporting.
 */
export async function storeDownload(
  options: StoreDownloadOptions,
): Promise<FabDownloadResult> {
  const fileName = safeDownloadName(options.fileName);
  const root = await ensureCanonicalDirectory(resolve(options.downloadDir));
  const directory = await ensureCanonicalDirectory(
    join(root, options.listingId, options.format),
  );
  if (!isInside(directory, root)) {
    throw new FabClientError(
      "FAB_INTERNAL",
      "Refused a download path outside the configured Fab download directory.",
    );
  }
  const outputPath = join(directory, fileName);
  const existing = await lstat(outputPath).catch(() => undefined);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new FabClientError(
        "FAB_DOWNLOAD_FAILED",
        "The destination is not a safe regular file.",
      );
    }
    const metadata = await stat(outputPath);
    // A glTF download also reports how big the asset is, so a game can place it unopened.
    const size = await sizeMeters(outputPath);
    return {
      listingId: options.listingId,
      format: options.format as FabDownloadResult["format"],
      fileName,
      path: outputPath,
      sizeBytes: metadata.size,
      sha256: await sha256File(outputPath),
      alreadyExisted: true,
      authentication: "not-required",
      ...(size ? { sizeMeters: size } : {}),
    };
  }

  const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.part`);
  try {
    await options.materialize(temporaryPath);
    const temporaryMetadata = await stat(temporaryPath);
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.size > options.maxBytes
    ) {
      throw new FabClientError(
        "FAB_DOWNLOAD_TOO_LARGE",
        "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
      );
    }
    await copyFile(temporaryPath, outputPath, constants.COPYFILE_EXCL);
    const metadata = await stat(outputPath);
    const size = await sizeMeters(outputPath);
    return {
      listingId: options.listingId,
      format: options.format as FabDownloadResult["format"],
      fileName,
      path: outputPath,
      sizeBytes: metadata.size,
      sha256: await sha256File(outputPath),
      alreadyExisted: false,
      authentication: "not-required",
      ...(size ? { sizeMeters: size } : {}),
    };
  } catch (error) {
    if (error instanceof FabClientError) throw error;
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "The downloaded file could not be saved safely.",
      true,
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
