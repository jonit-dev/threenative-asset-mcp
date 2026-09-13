import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { RigAssetError } from "./inspect.js";

function canonicalPath(input: string): string {
  let candidate = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...missing);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(input);
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset, value.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("Unable to write rig output.");
    offset += result.bytesWritten;
  }
}

export interface PublishedOutput {
  path: string;
  bytes: number;
  sha256: string;
  alreadyExisted: boolean;
  replaced: boolean;
}

/**
 * Publish a rig/retarget output under the project root. Concurrent creators are
 * serialized by an atomic link; an existing different output is only replaced
 * when the caller supplies its prior digest. Existing bytes survive any failure.
 */
export async function publishOutput(options: {
  projectRoot: string;
  outputPath: string;
  bytes: Uint8Array;
  priorDigest?: string;
}): Promise<PublishedOutput> {
  const root = canonicalPath(options.projectRoot);
  const target = canonicalPath(options.outputPath);
  if (target === root || !isInside(target, root)) {
    throw new RigAssetError(
      "RIG_UNSAFE_PATH",
      `The output ${options.outputPath} escapes the project root ${options.projectRoot}.`,
    );
  }
  if (!target.toLowerCase().endsWith(".glb")) {
    throw new RigAssetError("RIG_INVALID_INPUT", "The rig output must be a .glb path.");
  }
  const digest = createHash("sha256").update(options.bytes).digest("hex");
  await mkdir(dirname(target), { recursive: true });

  const existing = await stat(target).catch(() => null);
  if (existing?.isFile()) {
    const existingDigest = createHash("sha256")
      .update(new Uint8Array(await readFile(target)))
      .digest("hex");
    if (existingDigest === digest) {
      return { path: target, bytes: options.bytes.byteLength, sha256: digest, alreadyExisted: true, replaced: false };
    }
    if (options.priorDigest && existingDigest === options.priorDigest) {
      const temporary = `${target}.part-${process.pid}-${randomUUID()}`;
      let handle: FileHandle | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await writeAll(handle, options.bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        return { path: target, bytes: options.bytes.byteLength, sha256: digest, alreadyExisted: false, replaced: true };
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    }
    throw new RigAssetError(
      "RIG_OUTPUT_CONFLICT",
      `The output already exists with different bytes; pass its priorDigest to replace it.`,
    );
  }

  const temporary = `${target}.part-${process.pid}-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeAll(handle, options.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
      return { path: target, bytes: options.bytes.byteLength, sha256: digest, alreadyExisted: false, replaced: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingDigest = createHash("sha256")
        .update(new Uint8Array(await readFile(target)))
        .digest("hex");
      if (existingDigest !== digest) {
        throw new RigAssetError(
          "RIG_OUTPUT_CONFLICT",
          "A concurrent writer published different bytes.",
        );
      }
      return { path: target, bytes: options.bytes.byteLength, sha256: digest, alreadyExisted: true, replaced: false };
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function containedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new RigAssetError("RIG_UNSAFE_PATH", "The output path escapes its root.");
  }
  return candidate;
}
