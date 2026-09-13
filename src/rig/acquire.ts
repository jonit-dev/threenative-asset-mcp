import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RigConfig } from "../config.js";
import { RIG_CATALOG_SOURCES, pinnedDonorFor, type RigLibraryVariant } from "./catalog.js";
import { RigAssetError, sha256 } from "./inspect.js";

export interface AcquiredSample {
  path: string;
  bytes: number;
  sha256: string;
  alreadyCached: boolean;
  sourceUrl: string;
}

const ALLOWED_HOSTS = new Set([
  "raw.githubusercontent.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function assertAllowedHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new RigAssetError("RIG_ACQUISITION_FAILED", `The pinned source URL is not valid: ${url}.`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new RigAssetError(
      "RIG_ACQUISITION_FAILED",
      `The pinned source redirected to a disallowed host: ${host}.`,
    );
  }
}

/**
 * Explicitly acquire one pinned sample into the development cache and verify its
 * digest. Cache hits work offline; a corrupt cache entry is discarded and refetched.
 */
export async function acquirePinnedSample(options: {
  sourceId: string;
  config: RigConfig;
  fetchImpl?: typeof fetch;
}): Promise<AcquiredSample> {
  const source = RIG_CATALOG_SOURCES.find(
    (candidate) => candidate.id === options.sourceId && candidate.kind === "sample",
  );
  if (!source || !source.sha256) {
    throw new RigAssetError(
      "RIG_INVALID_INPUT",
      `Unknown pinned sample "${options.sourceId}".`,
    );
  }
  return acquireVerifiedSource({
    id: source.id,
    sourceUrl: source.sourceUrl,
    sha256: source.sha256,
    config: options.config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export async function acquireVerifiedSource(options: {
  id: string;
  sourceUrl: string;
  sha256: string;
  config: RigConfig;
  fetchImpl?: typeof fetch;
}): Promise<AcquiredSample> {
  const digest = options.sha256;
  const source = { id: options.id, sourceUrl: options.sourceUrl };

  const directory = join(options.config.cacheDir, "samples");
  const target = join(directory, `${source.id}-${digest}.glb`);

  const cached = await stat(target).catch(() => null);
  if (cached?.isFile()) {
    const bytes = await readFile(target);
    if (sha256(bytes) === digest) {
      return {
        path: target,
        bytes: bytes.byteLength,
        sha256: digest,
        alreadyCached: true,
        sourceUrl: source.sourceUrl,
      };
    }
    await rm(target, { force: true });
  }

  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${source.id}-${randomUUID()}.tmp`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.config.downloadTimeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(source.sourceUrl, {
      redirect: "follow",
      signal: controller.signal,
    });
    assertAllowedHost(response.url || source.sourceUrl);
    if (!response.ok || !response.body) {
      throw new RigAssetError(
        "RIG_ACQUISITION_FAILED",
        `Fetching ${source.sourceUrl} failed with status ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > options.config.maxDownloadBytes) {
      throw new RigAssetError(
        "RIG_INPUT_TOO_LARGE",
        `The pinned source declares ${declared} bytes, over the ${options.config.maxDownloadBytes} byte limit.`,
      );
    }

    handle = await open(temporary, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > options.config.maxDownloadBytes) {
        throw new RigAssetError(
          "RIG_INPUT_TOO_LARGE",
          `The pinned source exceeded the ${options.config.maxDownloadBytes} byte limit mid-transfer.`,
        );
      }
      hash.update(value);
      await handle.write(value);
    }
    await handle.close();
    handle = undefined;

    const actual = hash.digest("hex");
    if (actual !== digest) {
      throw new RigAssetError(
        "RIG_DIGEST_MISMATCH",
        `The pinned source digest is ${actual}, expected ${digest}.`,
      );
    }
    await rename(temporary, target);
    return {
      path: target,
      bytes,
      sha256: digest,
      alreadyCached: false,
      sourceUrl: source.sourceUrl,
    };
  } catch (error) {
    if (error instanceof RigAssetError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new RigAssetError(
        "RIG_ACQUISITION_FAILED",
        `Fetching ${source.sourceUrl} timed out.`,
        true,
      );
    }
    throw new RigAssetError(
      "RIG_ACQUISITION_FAILED",
      `Fetching ${source.sourceUrl} failed.`,
      true,
    );
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Acquire one selected release donor (mesh-free, rig-bearing) by clip id and variant. */
export async function acquireDonor(options: {
  clipId: string;
  variant: RigLibraryVariant;
  config: RigConfig;
  fetchImpl?: typeof fetch;
}): Promise<AcquiredSample> {
  const clip = pinnedDonorFor(options.clipId, options.variant);
  if (!clip) {
    throw new RigAssetError(
      "RIG_INVALID_INPUT",
      `No pinned donor for clip "${options.clipId}" (${options.variant}).`,
    );
  }
  if (clip.calibration) {
    throw new RigAssetError(
      "RIG_INVALID_INPUT",
      `Clip "${options.clipId}" is T-pose calibration data, not a selectable motion.`,
    );
  }
  return acquireVerifiedSource({
    id: slug(`${options.clipId}-${options.variant}`),
    sourceUrl: clip.donor.url,
    sha256: clip.donor.sha256,
    config: options.config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
