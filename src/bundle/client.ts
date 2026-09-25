import { Document, NodeIO, type Accessor } from "@gltf-transform/core";
import {
  HttpRangeReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
} from "@zip.js/zip.js";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { sizeMeters, type SizeMeters } from "../gltf-size.js";
import type { ItchPackId } from "../itch/catalog.js";
import type { ResolvedItchUpload } from "../itch/client.js";

export interface BundleItchResolver {
  resolveUpload(
    packId: ItchPackId,
    uploadId: string,
  ): Promise<ResolvedItchUpload>;
}

export interface BundleAssetClientOptions {
  itch: BundleItchResolver;
  fetch?: typeof globalThis.fetch;
  downloadDir?: string;
  timeoutMs?: number;
  maxEntryBytes?: number;
}

export interface BundleEntryInfo {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
}

export class BundleAssetError extends Error {
  constructor(
    public readonly code:
      | "BUNDLE_ENTRY_NOT_FOUND"
      | "BUNDLE_ENTRY_TOO_LARGE"
      | "BUNDLE_UNSAFE_PATH"
      | "BUNDLE_UPSTREAM_DENIED"
      | "BUNDLE_ANIMATION_NOT_FOUND"
      | "BUNDLE_INVALID_GLTF",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BundleAssetError";
  }
}

interface EntryBytesResult {
  bytes: Uint8Array;
  path: string;
  alreadyCached: boolean;
  rangeBytesTransferred: number;
  /** Bounding-box size for a written glTF entry, so a game can place it unopened. */
  sizeMeters?: SizeMeters;
}

interface TrackedArchive {
  reader: ZipReader<unknown>;
  transferred: () => number;
}

function sourceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new BundleAssetError(
      "BUNDLE_UNSAFE_PATH",
      "The selected bundle entry does not have a safe filename.",
    );
  }
  return cleaned;
}

function contained(root: string, ...parts: string[]): string {
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, ...parts);
  if (
    destination !== absoluteRoot &&
    !destination.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new BundleAssetError(
      "BUNDLE_UNSAFE_PATH",
      "The selected destination escapes guarded bundle storage.",
    );
  }
  return destination;
}

async function writeAll(file: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await file.write(value, offset, value.byteLength - offset);
    if (result.bytesWritten <= 0) throw new Error("Unable to write bundle output.");
    offset += result.bytesWritten;
  }
}

async function publishBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    const existing = await stat(path);
    if (existing.isFile()) {
      const existingBytes = new Uint8Array(await readFile(path));
      if (sha256(existingBytes) !== sha256(bytes)) {
        throw new BundleAssetError(
          "BUNDLE_UNSAFE_PATH",
          "The bundle destination already contains different bytes.",
        );
      }
      return true;
    }
    throw new BundleAssetError(
      "BUNDLE_UNSAFE_PATH",
      "The bundle destination already exists and is not a regular file.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${path}.part-${process.pid}-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existingBytes = new Uint8Array(await readFile(path));
        if (sha256(existingBytes) !== sha256(bytes)) {
          throw new BundleAssetError(
            "BUNDLE_UNSAFE_PATH",
            "A concurrent bundle write published different bytes.",
          );
        }
        return true;
      }
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export class BundleAssetClient {
  private readonly itch: BundleItchResolver;
  private readonly fetch: typeof globalThis.fetch;
  private readonly downloadDir: string;
  private readonly timeoutMs: number;
  private readonly maxEntryBytes: number;
  private readonly io = new NodeIO();

  constructor(options: BundleAssetClientOptions) {
    this.itch = options.itch;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.downloadDir =
      options.downloadDir ??
      process.env.ASSET_DOWNLOAD_DIR ??
      join(process.env.HOME ?? process.cwd(), "Downloads", "threenative-asset-mcp", "assets");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxEntryBytes = options.maxEntryBytes ?? 512 * 1024 * 1024;
  }

  async listEntries(packId: ItchPackId, uploadId: string) {
    const resolved = await this.itch.resolveUpload(packId, uploadId);
    const archive = this.openArchive(resolved.signedFileUrl);
    try {
      const entries = await archive.reader.getEntries();
      return {
        pack: resolved.pack,
        upload: resolved.upload,
        entries: entries.map((entry) => this.entryInfo(entry)),
        rangeBytesTransferred: archive.transferred(),
      };
    } finally {
      await archive.reader.close();
    }
  }

  async downloadEntry(input: {
    packId: ItchPackId;
    uploadId: string;
    entryPath: string;
  }) {
    const result = await this.readEntry(input);
    return {
      path: result.path,
      entryPath: input.entryPath,
      sizeBytes: result.bytes.byteLength,
      sha256: sha256(result.bytes),
      alreadyCached: result.alreadyCached,
      rangeBytesTransferred: result.rangeBytesTransferred,
      ...(result.sizeMeters ? { sizeMeters: result.sizeMeters } : {}),
    };
  }

  async listAnimations(input: {
    packId: ItchPackId;
    uploadId: string;
    entryPath?: string;
  }) {
    const selectedPath =
      input.entryPath ?? (await this.selectAggregateGlb(input.packId, input.uploadId));
    const aggregate = await this.readEntry({ ...input, entryPath: selectedPath });
    const document = await this.readGlb(aggregate.bytes);
    return {
      entryPath: selectedPath,
      aggregateEntryBytes: aggregate.bytes.byteLength,
      alreadyCached: aggregate.alreadyCached,
      rangeBytesTransferred: aggregate.rangeBytesTransferred,
      animations: document
        .getRoot()
        .listAnimations()
        .map((animation, index) => ({
          index,
          name: animation.getName() || `animation-${index}`,
          channels: animation.listChannels().length,
          samplers: animation.listSamplers().length,
        })),
    };
  }

  async downloadAnimation(input: {
    packId: ItchPackId;
    uploadId: string;
    entryPath?: string;
    animationName: string;
  }) {
    const selectedPath =
      input.entryPath ?? (await this.selectAggregateGlb(input.packId, input.uploadId));
    const aggregate = await this.readEntry({ ...input, entryPath: selectedPath });
    const document = await this.readGlb(aggregate.bytes);
    const animations = document.getRoot().listAnimations();
    const selected = animations.find(
      (animation, index) =>
        animation.getName() === input.animationName ||
        String(index) === input.animationName,
    );
    if (!selected) {
      throw new BundleAssetError(
        "BUNDLE_ANIMATION_NOT_FOUND",
        `Animation ${input.animationName} is not present in ${selectedPath}.`,
      );
    }

    this.retainAnimationOnly(document, selected);
    const output = await this.io.writeBinary(document);
    const outputPath = contained(
      this.downloadDir,
      "bundles",
      input.packId,
      input.uploadId,
      "animations",
      sourceHash(selectedPath),
      `${safeFileName(selected.getName() || `animation-${animations.indexOf(selected)}`)}.glb`,
    );
    const alreadyExisted = await publishBytes(outputPath, output);
    return {
      path: outputPath,
      animationName: selected.getName() || input.animationName,
      entryPath: selectedPath,
      sizeBytes: output.byteLength,
      aggregateEntryBytes: aggregate.bytes.byteLength,
      sha256: sha256(output),
      alreadyExisted,
      aggregateAlreadyCached: aggregate.alreadyCached,
      rangeBytesTransferred: aggregate.rangeBytesTransferred,
    };
  }

  private openArchive(signedFileUrl: string): TrackedArchive {
    let transferred = 0;
    const trackedFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await this.fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          "user-agent": "threenative-asset-mcp/0.4.0",
        },
      });
      if (!response.ok) {
        throw new BundleAssetError(
          "BUNDLE_UPSTREAM_DENIED",
          `Bundle range request returned HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
        );
      }
      if (init?.method !== "HEAD") {
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > 0) transferred += length;
      }
      return response;
    };
    const source = new HttpRangeReader(signedFileUrl, {
      fetch: trackedFetch,
    });
    return {
      reader: new ZipReader(source),
      transferred: () => transferred,
    };
  }

  private async readEntry(input: {
    packId: ItchPackId;
    uploadId: string;
    entryPath: string;
  }): Promise<EntryBytesResult> {
    const outputPath = contained(
      this.downloadDir,
      "bundles",
      input.packId,
      input.uploadId,
      "entries",
      sourceHash(input.entryPath),
      safeFileName(basename(input.entryPath)),
    );
    try {
      const bytes = new Uint8Array(await readFile(outputPath));
      if (bytes.byteLength > this.maxEntryBytes) {
        throw new BundleAssetError(
          "BUNDLE_ENTRY_TOO_LARGE",
          "The cached bundle entry exceeds the configured byte limit.",
        );
      }
      const expectedHash = await readFile(`${outputPath}.sha256`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (expectedHash?.trim() === sha256(bytes)) {
        const size = await sizeMeters(outputPath);
        return {
          bytes,
          path: outputPath,
          alreadyCached: true,
          rangeBytesTransferred: 0,
          ...(size ? { sizeMeters: size } : {}),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const resolved = await this.itch.resolveUpload(input.packId, input.uploadId);
    const archive = this.openArchive(resolved.signedFileUrl);
    try {
      const entries = await archive.reader.getEntries();
      const entry = entries.find(
        (candidate) => !candidate.directory && candidate.filename === input.entryPath,
      );
      if (!entry || entry.directory) {
        throw new BundleAssetError(
          "BUNDLE_ENTRY_NOT_FOUND",
          `Bundle entry ${input.entryPath} was not found.`,
        );
      }
      const expectedSize = entry.uncompressedSize ?? 0;
      if (expectedSize > this.maxEntryBytes) {
        throw new BundleAssetError(
          "BUNDLE_ENTRY_TOO_LARGE",
          `Bundle entry requires ${expectedSize} bytes, above the configured limit.`,
        );
      }
      const bytes = await entry.getData(new Uint8ArrayWriter());
      if (bytes.byteLength > this.maxEntryBytes) {
        throw new BundleAssetError(
          "BUNDLE_ENTRY_TOO_LARGE",
          "The extracted bundle entry exceeds the configured byte limit.",
        );
      }
      const alreadyCached = await publishBytes(outputPath, bytes);
      await publishBytes(
        `${outputPath}.sha256`,
        new TextEncoder().encode(`${sha256(bytes)}\n`),
      );
      const size = await sizeMeters(outputPath);
      return {
        bytes,
        path: outputPath,
        alreadyCached,
        rangeBytesTransferred: archive.transferred(),
        ...(size ? { sizeMeters: size } : {}),
      };
    } finally {
      await archive.reader.close();
    }
  }

  private async selectAggregateGlb(
    packId: ItchPackId,
    uploadId: string,
  ): Promise<string> {
    const result = await this.listEntries(packId, uploadId);
    const candidates = result.entries.filter(
      (entry) => !entry.directory && entry.path.toLowerCase().endsWith(".glb"),
    );
    const preferred =
      candidates.find(
        (entry) =>
          /standard\.glb$/i.test(entry.path) && !/_rm\.glb$/i.test(entry.path),
      ) ?? candidates.find((entry) => !/_rm\.glb$/i.test(entry.path));
    if (!preferred) {
      throw new BundleAssetError(
        "BUNDLE_ENTRY_NOT_FOUND",
        "The selected bundle does not contain a GLB animation library.",
      );
    }
    return preferred.path;
  }

  private async readGlb(bytes: Uint8Array): Promise<Document> {
    try {
      return await this.io.readBinary(bytes);
    } catch {
      throw new BundleAssetError(
        "BUNDLE_INVALID_GLTF",
        "The selected bundle entry is not a readable GLB asset.",
      );
    }
  }

  private retainAnimationOnly(
    document: Document,
    selected: ReturnType<Document["createAnimation"]>,
  ): void {
    const retainedAccessors = new Set<Accessor>(
      selected
        .listSamplers()
        .flatMap((sampler) => [sampler.getInput(), sampler.getOutput()])
        .filter((accessor): accessor is Accessor => Boolean(accessor)),
    );
    for (const animation of document.getRoot().listAnimations()) {
      if (animation !== selected) animation.dispose();
    }
    for (const node of document.getRoot().listNodes()) {
      node.setMesh(null);
      node.setSkin(null);
    }
    for (const accessor of document.getRoot().listAccessors()) {
      if (!retainedAccessors.has(accessor)) accessor.dispose();
    }
    for (const mesh of document.getRoot().listMeshes()) mesh.dispose();
    for (const material of document.getRoot().listMaterials()) material.dispose();
    for (const texture of document.getRoot().listTextures()) texture.dispose();
    for (const skin of document.getRoot().listSkins()) skin.dispose();
    for (const camera of document.getRoot().listCameras()) camera.dispose();
  }

  private entryInfo(entry: Entry): BundleEntryInfo {
    return {
      path: entry.filename,
      compressedBytes: entry.compressedSize ?? 0,
      uncompressedBytes: entry.uncompressedSize ?? 0,
      directory: entry.directory,
    };
  }
}
