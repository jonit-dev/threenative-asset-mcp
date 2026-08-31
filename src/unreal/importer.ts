import { createHash } from "node:crypto";
import { readdir, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, statfs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { NodeIO, VertexLayout, type Material, type Texture } from "@gltf-transform/core";

import {
  type MaterialTextureBinding,
  type ResolvedMaterial,
  type TextureTransform,
  resolveMaterial,
} from "./materials.js";
import { ensureUmodel } from "./provision.js";
import { type ExternalTool, ToolchainError, assertSupportedHost, runBounded } from "./toolchain.js";

const statfsAsync = promisify(statfs);

/** Bumped whenever the conversion contract changes; it participates in the reuse cache key. */
export const IMPORTER_VERSION = 1;

export type ImportErrorCode =
  | "UNREAL_SOURCE_NOT_FOUND"
  | "UNREAL_SOURCE_EMPTY"
  | "UNREAL_OUTPUT_INVALID"
  | "UNREAL_OUTPUT_COLLISION"
  | "UNREAL_DISK_SPACE"
  | "UNREAL_EXPORT_EMPTY"
  | "UNREAL_GLB_INVALID";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportedMaterialSection {
  readonly name: string;
  /** False when UE Viewer could not resolve a material for the section at all. */
  readonly resolved: boolean;
  readonly bindings: readonly {
    readonly slot: string;
    readonly texture: string;
    readonly source: string;
    readonly confidence: string;
    readonly transform: TextureTransform;
  }[];
  readonly unsupported: readonly { readonly texture: string; readonly reason: string }[];
  readonly alphaMode: string;
  readonly doubleSided: boolean;
  readonly textured: boolean;
}

export interface ImportedModel {
  readonly name: string;
  readonly package: string;
  /** Path relative to the promoted output directory. */
  readonly glb: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly vertices: number;
  readonly primitives: number;
  readonly boundsMetres: readonly [number, number, number];
  readonly materials: readonly ImportedMaterialSection[];
}

export interface ImportReport {
  readonly importer: { readonly name: string; readonly version: number };
  readonly source: {
    readonly kind: "local-directory" | "fab-listing";
    readonly path: string;
    readonly listingId: string | undefined;
    readonly engine: string | undefined;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sourceHash: string;
  };
  readonly entitlement: {
    readonly provider: string;
    /** Whether an authenticated entitlement was used. Never a token, cookie, or account name. */
    readonly authenticatedDownload: boolean;
    readonly acquisition: "none";
    /** The licence the listing is offered under, and why it was accepted. */
    readonly license:
      | { readonly verdict: string; readonly slugs: readonly string[]; readonly reason: string }
      | undefined;
  };
  readonly toolchain: { readonly umodel: string; readonly fabcli: string | undefined };
  readonly cacheKey: string;
  readonly reused: boolean;
  readonly materials: "complete" | "degraded";
  readonly counts: {
    readonly packages: number;
    readonly exported: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly models: readonly ImportedModel[];
  readonly skipped: readonly { readonly package: string; readonly reason: string }[];
  readonly failed: readonly { readonly package: string; readonly reason: string }[];
  readonly materialCoverage: {
    readonly sections: number;
    readonly textured: number;
    readonly exact: number;
    readonly heuristic: number;
    readonly unsupported: number;
    /** Sections UE Viewer left as `dummy_material_*`; renamed on output and never called textured. */
    readonly unresolved: number;
  };
  readonly transforms: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

export interface ImportUnrealRequest {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly listingId?: string | undefined;
  readonly engine?: string | undefined;
  readonly sourceKind?: "local-directory" | "fab-listing";
  readonly authenticatedDownload?: boolean;
  readonly fabcliVersion?: string | undefined;
  /** Longest edge for embedded textures. Undefined keeps UE Viewer's own resolution. */
  readonly maxTextureSize?: number | undefined;
  /** Limits the run to packages whose name is in this set. Used by tests and partial imports. */
  readonly onlyPackages?: readonly string[] | undefined;
  /** Warnings raised before the import started, carried into the report the caller keeps. */
  readonly extraWarnings?: readonly string[] | undefined;
  readonly license?:
    | { readonly verdict: string; readonly slugs: readonly string[]; readonly reason: string }
    | undefined;
  readonly concurrency?: number;
  readonly keepStaging?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly umodel?: ExternalTool;
}

const UNSUPPORTED_EXTENSIONS = new Map<string, string>([
  [".umap", "Unreal level (.umap): placement, landscape, foliage instancing, and lighting are level data with no glTF equivalent"],
]);

const UNSUPPORTED_CLASSES = new Map<string, string>([
  ["Blueprint", "Blueprint graph"],
  ["BlueprintGeneratedClass", "Blueprint class"],
  ["NiagaraSystem", "Niagara system"],
  ["NiagaraEmitter", "Niagara emitter"],
  ["ParticleSystem", "Cascade particle system"],
  ["LandscapeComponent", "landscape component"],
  ["FoliageType_InstancedStaticMesh", "foliage placement type"],
  ["World", "level"],
  ["MapBuildDataRegistry", "baked level lighting"],
]);

/** A material package lists hundreds of expression classes; the reason names a few and counts the rest. */
export function summarizeClasses(classes: readonly string[], keep = 4): string {
  const unique = [...new Set(classes)];
  if (unique.length <= keep) return unique.join(", ");
  return `${unique.slice(0, keep).join(", ")} and ${unique.length - keep} more`;
}

function cacheRoot(environment: NodeJS.ProcessEnv): string {
  return (
    environment.THREENATIVE_UNREAL_CACHE_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "unreal-import",
    )
  );
}

async function listFiles(root: string): Promise<{ path: string; size: number }[]> {
  const found: { path: string; size: number }[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      // Symlinks are never followed: a link inside the pack could otherwise read or, after
      // promotion, write outside the directory the caller named.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      found.push({ path: full, size: (await stat(full)).size });
    }
  };
  await walk(root);
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return found;
}

/** Identity of the input tree: every relative path and its size, in a stable order. */
export function hashSourceTree(
  root: string,
  files: readonly { path: string; size: number }[],
): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file.path).split(sep).join("/"));
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Rejects any generated name that would escape the directory it is written into. */
export function assertContained(root: string, candidate: string): string {
  const full = resolve(root, candidate);
  const inside = relative(root, full);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new ImportError(
      "UNREAL_OUTPUT_INVALID",
      `Refusing to write "${candidate}": it resolves outside the import output directory.`,
    );
  }
  return full;
}

interface PackageClassification {
  readonly package: string;
  readonly file: string;
  readonly classes: readonly string[];
  readonly hasStaticMesh: boolean;
  readonly error: string | undefined;
}

const LIST_LINE = /^\s*\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)\s+(\S+)\s*$/;

export function parseUmodelList(stdout: string): { classes: string[]; objects: string[] } {
  const classes: string[] = [];
  const objects: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LIST_LINE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    classes.push(match[1]);
    objects.push(match[2]);
  }
  return { classes, objects };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

interface ExportedAssets {
  readonly gltf: Map<string, string>;
  readonly mat: Map<string, string>;
  readonly props: Map<string, string>;
  readonly png: Map<string, string>;
}

async function indexExported(root: string): Promise<ExportedAssets> {
  const gltf = new Map<string, string>();
  const mat = new Map<string, string>();
  const props = new Map<string, string>();
  const png = new Map<string, string>();
  for (const file of await listFiles(root).catch(() => [])) {
    const name = basename(file.path);
    if (name.endsWith(".props.txt")) props.set(name.slice(0, -".props.txt".length), file.path);
    else if (name.endsWith(".mat")) mat.set(name.slice(0, -".mat".length), file.path);
    else if (name.endsWith(".gltf")) gltf.set(name.slice(0, -".gltf".length), file.path);
    else if (name.endsWith(".png")) png.set(name.slice(0, -".png".length), file.path);
  }
  return { gltf, mat, props, png };
}

/**
 * Rebuilds one Unreal texture into the channel layout the target glTF slot expects. Every branch
 * is a named transform declared by `materials.ts` and asserted over synthetic pixels in the tests;
 * nothing here guesses at runtime.
 */
export async function applyTextureTransform(
  input: Buffer,
  transform: TextureTransform,
  maxTextureSize: number | undefined,
): Promise<{ data: Buffer; mimeType: string }> {
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  const base = () => {
    const pipeline = sharp(input, { limitInputPixels: 268_435_456, unlimited: true });
    return maxTextureSize
      ? pipeline.resize({
          width: maxTextureSize,
          height: maxTextureSize,
          fit: "inside",
          withoutEnlargement: true,
        })
      : pipeline;
  };

  if (transform === "none") {
    // Re-encoding an untouched image would cost minutes across a full pack and change nothing.
    if (maxTextureSize === undefined) return { data: input, mimeType: "image/png" };
    return { data: await base().png({ compressionLevel: 6 }).toBuffer(), mimeType: "image/png" };
  }

  const { data, info } = await base()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const output = Buffer.alloc(pixels * 3);
  for (let index = 0; index < pixels; index += 1) {
    const source = index * 4;
    const target = index * 3;
    const red = data[source] ?? 0;
    const alpha = data[source + 3] ?? 255;
    // glTF metallicRoughness: R is free, G is roughness, B is metalness. Nothing in an Unreal
    // photoscan pack is a metal, so B stays 0 rather than inheriting an unrelated channel.
    const roughness =
      transform === "alphaToRoughness"
        ? alpha
        : transform === "redToRoughness"
          ? red
          : 255 - red;
    output[target] = 255;
    output[target + 1] = roughness;
    output[target + 2] = 0;
  }
  return {
    data: await sharp(output, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer(),
    mimeType: "image/png",
  };
}

const SLOT_ORDER = ["baseColor", "normal", "metallicRoughness", "emissive", "occlusion"] as const;

/**
 * Transformed images, shared across every mesh in one import. A ground-tile texture is bound by
 * dozens of meshes and an 8K resize costs seconds, so without this the full pack pays for the same
 * decode over and over. Bounded by bytes rather than entries: one 8K image is worth thousands of
 * small ones.
 */
const TRANSFORMED_IMAGE_BUDGET_BYTES = 1_500_000_000;

export class TransformedImageCache {
  readonly #entries = new Map<string, { data: Buffer; mimeType: string }>();
  #bytes = 0;

  async get(
    key: string,
    produce: () => Promise<{ data: Buffer; mimeType: string }>,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const cached = this.#entries.get(key);
    if (cached) return cached;
    const produced = await produce();
    while (this.#bytes + produced.data.length > TRANSFORMED_IMAGE_BUDGET_BYTES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#bytes -= this.#entries.get(oldest.value)?.data.length ?? 0;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, produced);
    this.#bytes += produced.data.length;
    return produced;
  }
}

function attachTexture(
  material: Material,
  binding: MaterialTextureBinding,
  texture: Texture,
): void {
  switch (binding.slot) {
    case "baseColor":
      material.setBaseColorTexture(texture);
      material.setBaseColorFactor([1, 1, 1, 1]);
      return;
    case "normal":
      material.setNormalTexture(texture);
      return;
    case "emissive":
      material.setEmissiveTexture(texture);
      material.setEmissiveFactor([1, 1, 1]);
      return;
    case "metallicRoughness":
      material.setMetallicRoughnessTexture(texture);
      material.setMetallicFactor(0);
      material.setRoughnessFactor(1);
      return;
    case "occlusion":
      material.setOcclusionTexture(texture);
      return;
  }
}

export interface PackagedModel {
  readonly vertices: number;
  readonly primitives: number;
  readonly bounds: [number, number, number];
  readonly sections: ImportedMaterialSection[];
  readonly prunedUvSets: number;
  readonly droppedTangents: number;
}

/**
 * Reads one UE Viewer glTF, replaces its debug-colour materials with the reconstructed PBR ones,
 * embeds every bound image, and writes a self-contained GLB.
 */
/**
 * glTF-Transform interleaves vertex attributes by default. ThreeNative's native host rejects an
 * interleaved buffer view outright — `createRenderPipeline` fails on every mesh that uses one — so
 * an interleaved GLB is a source asset that renders on the web and cannot be packaged for desktop
 * or mobile at all. Separate is the only layout this importer writes.
 */
function separateLayoutIO(): NodeIO {
  return new NodeIO().setVertexLayout(VertexLayout.SEPARATE);
}

export async function packageGlb(options: {
  readonly gltfPath: string;
  readonly glbPath: string;
  readonly assets: ExportedAssets;
  readonly maxTextureSize: number | undefined;
  readonly keepAllUvSets: boolean;
  readonly imageCache?: TransformedImageCache;
  /** Written into the glTF `asset.copyright`, so the entitlement travels with the file. */
  readonly copyright?: string | undefined;
}): Promise<PackagedModel> {
  const io = separateLayoutIO();
  const document = await io.read(options.gltfPath);
  const root = document.getRoot();
  // A provenance record that lives only in a sibling report is one `cp` away from being lost.
  // ThreeNative's own asset health check reads this field, so an imported asset that cannot say
  // where it came from is reported as unknown rather than quietly assumed fine.
  // glTF-Transform owns `generator` on write, so the provenance rides in `copyright` alone.
  if (options.copyright) root.getAsset().copyright = options.copyright;
  const availableTextures = new Set(options.assets.png.keys());
  const sections: ImportedMaterialSection[] = [];
  const cache = new Map<string, Texture>();
  let prunedUvSets = 0;
  let droppedTangents = 0;

  for (const [index, material] of root.listMaterials().entries()) {
    const name = material.getName();
    // UE Viewer names a section it could not resolve `dummy_material_<n>` and paints it a debug
    // colour. Shipping that name would put a placeholder into a game asset and let a reader
    // mistake it for a real material, so it is renamed to something that says what it is.
    const unresolvedSection = /^dummy_material(_\d+)?$/i.test(name);
    if (unresolvedSection) {
      material.setName(`${basename(options.glbPath, ".glb")}_unresolved_section_${index}`);
    }
    const resolved: ResolvedMaterial = resolveMaterial({
      name,
      readMat: (materialName) => {
        const path = options.assets.mat.get(materialName);
        return path === undefined ? undefined : readMaterialSidecar(path);
      },
      readProps: (materialName) => {
        const path = options.assets.props.get(materialName);
        return path === undefined ? undefined : readMaterialSidecar(path);
      },
      availableTextures,
    });

    // UE Viewer's exporter writes a per-section debug colour. Whether or not a texture replaces
    // it, it never survives into the output: a red/green/blue tint reported as a material is the
    // exact false success this importer exists to prevent.
    material.setBaseColorFactor([1, 1, 1, 1]);
    material.setMetallicFactor(0);
    material.setRoughnessFactor(0.8);
    material.setAlphaMode(resolved.alphaMode);
    if (resolved.alphaMode === "MASK") material.setAlphaCutoff(resolved.alphaCutoff ?? 0.333);
    material.setDoubleSided(resolved.doubleSided);

    const ordered = [...resolved.bindings].sort(
      (left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot),
    );
    for (const binding of ordered) {
      const source = options.assets.png.get(binding.texture);
      if (!source) continue;
      const key = `${binding.texture}|${binding.transform}`;
      let texture = cache.get(key);
      if (!texture) {
        const image = options.imageCache
          ? await options.imageCache.get(`${source}|${binding.transform}`, async () =>
              applyTextureTransform(
                await readFile(source),
                binding.transform,
                options.maxTextureSize,
              ),
            )
          : await applyTextureTransform(
              await readFile(source),
              binding.transform,
              options.maxTextureSize,
            );
        texture = document
          .createTexture(`${binding.texture}${binding.transform === "none" ? "" : `_${binding.transform}`}`)
          .setImage(new Uint8Array(image.data))
          .setMimeType(image.mimeType);
        cache.set(key, texture);
      }
      attachTexture(material, binding, texture);
    }

    if (!ordered.some((binding) => binding.slot === "baseColor")) {
      // Explicit neutral fallback, never the exporter's debug colour.
      material.setBaseColorFactor([0.8, 0.8, 0.8, 1]);
    }

    sections.push({
      name: material.getName(),
      resolved: !unresolvedSection,
      bindings: ordered.map((binding) => ({
        slot: binding.slot,
        texture: binding.texture,
        source: binding.source,
        confidence: binding.confidence,
        transform: binding.transform,
      })),
      unsupported: resolved.unsupported.map((entry) => ({ ...entry })),
      alphaMode: resolved.alphaMode,
      doubleSided: resolved.doubleSided,
      textured: ordered.some((binding) => binding.slot === "baseColor"),
    });
  }

  let vertices = 0;
  let primitives = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      vertices += position.getCount();
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] ?? Infinity, position.getMin([0, 0, 0])[axis] ?? 0);
        max[axis] = Math.max(max[axis] ?? -Infinity, position.getMax([0, 0, 0])[axis] ?? 0);
      }
      // UE Viewer writes a TANGENT accessor for these UE4 static meshes whose every element is
      // (0,0,0,1). glTF requires unit-length tangents, and a renderer handed a zero tangent
      // produces NaN under any normal map — the failure looks like a broken material, not a
      // broken attribute. Dropping the attribute is correct rather than lossy: three.js derives
      // the tangent frame from UV derivatives when none is supplied.
      const tangent = primitive.getAttribute("TANGENT");
      if (tangent) {
        const element = [0, 0, 0, 0];
        let degenerate = 0;
        for (let index = 0; index < tangent.getCount(); index += 1) {
          tangent.getElement(index, element);
          if (Math.hypot(element[0] ?? 0, element[1] ?? 0, element[2] ?? 0) < 1e-6) degenerate += 1;
        }
        if (degenerate > 0) {
          primitive.setAttribute("TANGENT", null);
          tangent.dispose();
          droppedTangents += degenerate;
        }
      }

      if (options.keepAllUvSets) continue;
      // UE Viewer emits every Unreal UV channel, including lightmap sets no runtime material
      // reads. They are pure size in a source asset that a compiler will copy again.
      for (let set = 1; set < 8; set += 1) {
        const semantic = `TEXCOORD_${set}`;
        const attribute = primitive.getAttribute(semantic);
        if (!attribute) continue;
        primitive.setAttribute(semantic, null);
        attribute.dispose();
        prunedUvSets += 1;
      }
    }
  }

  await mkdir(dirname(options.glbPath), { recursive: true });
  await io.write(options.glbPath, document);

  return {
    vertices,
    primitives,
    bounds: [
      Number.isFinite(max[0]) ? max[0] - (min[0] ?? 0) : 0,
      Number.isFinite(max[1]) ? max[1] - (min[1] ?? 0) : 0,
      Number.isFinite(max[2]) ? max[2] - (min[2] ?? 0) : 0,
    ],
    sections,
    prunedUvSets,
    droppedTangents,
  };
}

/** The material sidecars are a few kilobytes each and `resolveMaterial` is synchronous by design:
 * the parent chain it walks is only known one file at a time. */
const textCache = new Map<string, string>();
function readMaterialSidecar(path: string): string | undefined {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(path, "utf8");
    textCache.set(path, text);
    return text;
  } catch {
    return undefined;
  }
}

/**
 * A buffer view is interleaved when more than one attribute semantic reads from it — the same
 * definition ThreeNative's own native asset preflight uses. Byte stride alone is not the defect:
 * a one-attribute view may carry a stride and packages fine.
 */
export function interleavedBufferViews(glb: Buffer): number {
  const json = JSON.parse(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"),
  ) as {
    accessors?: { bufferView?: number }[];
    meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  };
  const semanticsPerView = new Map<number, Set<string>>();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
        const view = json.accessors?.[accessorIndex]?.bufferView;
        if (view === undefined) continue;
        const seen = semanticsPerView.get(view) ?? new Set<string>();
        seen.add(semantic);
        semanticsPerView.set(view, seen);
      }
    }
  }
  let interleaved = 0;
  for (const seen of semanticsPerView.values()) if (seen.size > 1) interleaved += 1;
  return interleaved;
}

/** Re-reads a written GLB and fails the model when the artifact does not hold up. */
export async function validateGlb(path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} is not a glTF binary container.`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new ImportError(
      "UNREAL_GLB_INVALID",
      `${basename(path)} declares ${bytes.readUInt32LE(8)} bytes but is ${bytes.length}.`,
    );
  }
  const io = separateLayoutIO();
  const document = await io.readBinary(new Uint8Array(bytes));
  const root = document.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length === 0) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} contains no mesh.`);
  }
  const hasVertices = meshes.some((mesh) =>
    mesh.listPrimitives().some((primitive) => (primitive.getAttribute("POSITION")?.getCount() ?? 0) > 0),
  );
  if (!hasVertices) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} contains no vertices.`);
  }
  const interleaved = interleavedBufferViews(bytes);
  if (interleaved > 0) {
    throw new ImportError(
      "UNREAL_GLB_INVALID",
      `${basename(path)} holds ${interleaved} interleaved buffer view${interleaved === 1 ? "" : "s"}; ThreeNative's native host fails createRenderPipeline on every mesh that uses one.`,
    );
  }
  for (const texture of root.listTextures()) {
    if ((texture.getImage()?.byteLength ?? 0) === 0) {
      throw new ImportError(
        "UNREAL_GLB_INVALID",
        `${basename(path)} references texture "${texture.getName()}" with no embedded image.`,
      );
    }
  }
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function freeBytes(path: string): Promise<number> {
  try {
    const info = await statfsAsync(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Converts a local Unreal asset directory into self-contained source GLBs plus a provenance
 * report. Provider-independent: a pack downloaded by FabCLI and one unzipped by hand take the
 * same path, which is what makes an already-downloaded pack re-runnable.
 */
export async function importUnrealDirectory(
  request: ImportUnrealRequest,
): Promise<ImportReport> {
  const started = Date.now();
  assertSupportedHost();
  const environment = request.environment ?? process.env;
  const log = request.log ?? (() => {});
  const warnings: string[] = [...(request.extraWarnings ?? [])];

  let sourceDir: string;
  try {
    sourceDir = await realpath(resolve(request.sourceDir));
    if (!(await stat(sourceDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ImportError(
      "UNREAL_SOURCE_NOT_FOUND",
      `"${request.sourceDir}" is not a readable directory of Unreal assets.`,
    );
  }
  const outputDir = resolve(request.outputDir);
  if (!isAbsolute(outputDir)) {
    throw new ImportError("UNREAL_OUTPUT_INVALID", "The import output directory must be absolute.");
  }

  const files = await listFiles(sourceDir);
  const packages = files.filter((file) => [".uasset", ".umap"].includes(extname(file.path).toLowerCase()));
  if (packages.length === 0) {
    throw new ImportError(
      "UNREAL_SOURCE_EMPTY",
      `"${sourceDir}" contains no .uasset or .umap files.`,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const sourceHash = hashSourceTree(sourceDir, files);

  const umodel = request.umodel ?? (await ensureUmodel(environment, log));
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        sourceHash,
        umodel: umodel.version,
        fabcli: request.fabcliVersion ?? null,
        importer: IMPORTER_VERSION,
        engine: request.engine ?? null,
        listingId: request.listingId ?? null,
        maxTextureSize: request.maxTextureSize ?? null,
        only: request.onlyPackages ? [...request.onlyPackages].sort() : null,
      }),
    )
    .digest("hex");

  const existingReportPath = join(outputDir, "import-report.json");
  const existing = await readFile(existingReportPath, "utf8").catch(() => undefined);
  if (existing !== undefined) {
    const parsed = JSON.parse(existing) as ImportReport;
    if (parsed.cacheKey === cacheKey) {
      log(`Reusing the existing import at ${outputDir}.`);
      return { ...parsed, reused: true };
    }
    throw new ImportError(
      "UNREAL_OUTPUT_COLLISION",
      `${outputDir} already holds a different import (cache key ${parsed.cacheKey.slice(0, 12)}…). Choose a new output directory; this importer never overwrites one.`,
    );
  }
  if (await stat(outputDir).then(() => true, () => false)) {
    const entries = await readdir(outputDir);
    if (entries.length > 0) {
      throw new ImportError(
        "UNREAL_OUTPUT_COLLISION",
        `${outputDir} is not empty and holds no import report. Choose a new output directory.`,
      );
    }
  }

  const staging = join(cacheRoot(environment), cacheKey);
  const raw = join(staging, "raw");
  await mkdir(raw, { recursive: true });
  const required = Math.max(totalBytes, 2 * 1024 ** 3);
  const available = await freeBytes(staging);
  if (available < required) {
    throw new ImportError(
      "UNREAL_DISK_SPACE",
      `The import needs about ${Math.round(required / 1024 ** 3)} GiB of staging space; ${Math.round(available / 1024 ** 3)} GiB is free at ${staging}.`,
    );
  }

  const wanted = request.onlyPackages ? new Set(request.onlyPackages) : undefined;
  const candidates = packages
    .map((file) => ({
      file: file.path,
      package: basename(file.path, extname(file.path)),
      relative: relative(sourceDir, file.path).split(sep).join("/"),
      extension: extname(file.path).toLowerCase(),
    }))
    .filter((entry) => !wanted || wanted.has(entry.package));

  log(`Classifying ${candidates.length} Unreal packages…`);
  const concurrency = request.concurrency ?? Math.min(8, Math.max(2, candidates.length));
  const classified = await mapWithConcurrency<
    (typeof candidates)[number],
    PackageClassification
  >(candidates, concurrency, async (entry) => {
    const unsupported = UNSUPPORTED_EXTENSIONS.get(entry.extension);
    if (unsupported) {
      return {
        package: entry.relative,
        file: entry.file,
        classes: [],
        hasStaticMesh: false,
        error: unsupported,
      };
    }
    try {
      const run = await runBounded(
        umodel.path,
        [`-path=${sourceDir}`, "-list", entry.package],
        { timeoutMs: 300_000, maxOutputBytes: 16 * 1024 * 1024 },
      );
      const { classes } = parseUmodelList(run.stdout);
      return {
        package: entry.relative,
        file: entry.file,
        classes,
        hasStaticMesh: classes.includes("StaticMesh"),
        error:
          run.code === 0
            ? undefined
            : `UE Viewer could not list the package (exit ${run.code}).`,
      };
    } catch (error) {
      return {
        package: entry.relative,
        file: entry.file,
        classes: [],
        hasStaticMesh: false,
        error: error instanceof ToolchainError ? error.message : "UE Viewer failed to list the package.",
      };
    }
  });

  const meshPackages = classified.filter((entry) => entry.hasStaticMesh && !entry.error);
  const skipped: { package: string; reason: string }[] = [];
  const failed: { package: string; reason: string }[] = [];
  for (const entry of classified) {
    if (entry.hasStaticMesh && !entry.error) continue;
    if (entry.error && !UNSUPPORTED_EXTENSIONS.has(extname(entry.file).toLowerCase())) {
      failed.push({ package: entry.package, reason: entry.error });
      continue;
    }
    const unsupportedClass = entry.classes.find((className) => UNSUPPORTED_CLASSES.has(className));
    skipped.push({
      package: entry.package,
      reason:
        entry.error ??
        (unsupportedClass
          ? `unsupported Unreal-only content: ${UNSUPPORTED_CLASSES.get(unsupportedClass)}`
          : entry.classes.length === 0
            ? "no exportable object"
            : `carries no StaticMesh (${summarizeClasses(entry.classes)})`),
    });
  }

  if (meshPackages.length === 0) {
    throw new ImportError(
      "UNREAL_EXPORT_EMPTY",
      `No package under "${sourceDir}" contains a StaticMesh, so there is nothing to convert.`,
    );
  }

  // Packages share textures, so two exporters can write the same PNG at once and `-nooverwrite`
  // would see a half-written file as done. Listing is read-only and parallel; exporting is not.
  log(`Exporting ${meshPackages.length} static-mesh packages with UE Viewer…`);
  const exportFailures = await mapWithConcurrency(meshPackages, 1, async (entry) => {
    const name = basename(entry.package, extname(entry.package));
    try {
      const run = await runBounded(
        umodel.path,
        [
          `-path=${sourceDir}`,
          "-export",
          "-gltf",
          "-png",
          "-nooverwrite",
          `-out=${raw}`,
          name,
        ],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (run.code !== 0) {
        return { package: entry.package, reason: `UE Viewer export exited ${run.code}.` };
      }
      return undefined;
    } catch (error) {
      return {
        package: entry.package,
        reason: error instanceof ToolchainError ? error.message : "UE Viewer export failed.",
      };
    }
  });
  for (const failure of exportFailures) if (failure) failed.push(failure);

  const assets = await indexExported(raw);
  log(`UE Viewer wrote ${assets.gltf.size} glTF meshes and ${assets.png.size} textures.`);

  const promotionParent = dirname(outputDir);
  await mkdir(promotionParent, { recursive: true });
  const promotion = await mkdtemp(join(promotionParent, ".threenative-import-"));

  // Only a verified entitlement earns a copyright line. A local pack whose licence nobody
  // checked stays blank so the game's asset health check keeps saying "unknown".
  const copyright =
    request.license && request.license.verdict === "allowed"
      ? `${request.license.slugs.join(", ")} (Fab listing ${request.listingId ?? "unknown"}) via threenative-asset-mcp`
      : undefined;
  const models: ImportedModel[] = [];
  const imageCache = new TransformedImageCache();
  const transforms: Record<string, number> = {};
  let prunedUvSets = 0;
  let droppedTangents = 0;

  try {
    for (const entry of meshPackages) {
      const name = basename(entry.package, extname(entry.package));
      const gltfPath = assets.gltf.get(name);
      if (!gltfPath) {
        failed.push({ package: entry.package, reason: "UE Viewer produced no glTF for this package." });
        continue;
      }
      const relativeGlb = `${relative(raw, gltfPath).split(sep).join("/").slice(0, -".gltf".length)}.glb`;
      const glbPath = assertContained(promotion, relativeGlb);
      try {
        const packaged = await packageGlb({
          gltfPath,
          glbPath,
          assets,
          maxTextureSize: request.maxTextureSize,
          keepAllUvSets: false,
          imageCache,
          copyright,
        });
        prunedUvSets += packaged.prunedUvSets;
        droppedTangents += packaged.droppedTangents;
        const validated = await validateGlb(glbPath);
        for (const section of packaged.sections) {
          for (const binding of section.bindings) {
            transforms[binding.transform] = (transforms[binding.transform] ?? 0) + 1;
          }
        }
        models.push({
          name,
          package: entry.package,
          glb: relativeGlb,
          bytes: validated.bytes,
          sha256: validated.sha256,
          vertices: packaged.vertices,
          primitives: packaged.primitives,
          boundsMetres: packaged.bounds,
          materials: packaged.sections,
        });
        log(`Packaged ${relativeGlb} (${(validated.bytes / 1024 ** 2).toFixed(1)} MiB).`);
      } catch (error) {
        await rm(glbPath, { force: true });
        failed.push({
          package: entry.package,
          reason: error instanceof Error ? error.message : "GLB packaging failed.",
        });
      }
    }

    if (models.length === 0) {
      throw new ImportError(
        "UNREAL_EXPORT_EMPTY",
        "No package produced a valid GLB; nothing was promoted.",
      );
    }

    const sections = models.flatMap((model) => model.materials);
    const coverage = {
      sections: sections.length,
      textured: sections.filter((section) => section.textured).length,
      exact: sections.reduce(
        (sum, section) => sum + section.bindings.filter((binding) => binding.confidence === "exact").length,
        0,
      ),
      heuristic: sections.reduce(
        (sum, section) => sum + section.bindings.filter((binding) => binding.confidence === "heuristic").length,
        0,
      ),
      unsupported: sections.reduce((sum, section) => sum + section.unsupported.length, 0),
      unresolved: sections.filter((section) => !section.resolved).length,
    };
    if (droppedTangents > 0) {
      warnings.push(
        `Dropped ${droppedTangents} zero-length TANGENT vectors UE Viewer wrote for these meshes; the runtime derives the tangent frame from UVs instead.`,
      );
    }
    if (prunedUvSets > 0) {
      warnings.push(
        `Dropped ${prunedUvSets} extra UV channels (TEXCOORD_1 and above); Unreal lightmap UVs have no runtime consumer here.`,
      );
    }
    if (coverage.unresolved > 0) {
      warnings.push(
        `${coverage.unresolved} mesh sections had no material UE Viewer could resolve; they are named "<mesh>_unresolved_section_<n>" and carry a neutral grey, not a debug colour.`,
      );
    }
    if (coverage.textured < coverage.sections) {
      warnings.push(
        `${coverage.sections - coverage.textured} material sections have no base colour texture and use an explicit neutral fallback.`,
      );
    }

    const report: ImportReport = {
      importer: { name: "threenative-asset-mcp", version: IMPORTER_VERSION },
      source: {
        kind: request.sourceKind ?? "local-directory",
        path: sourceDir,
        listingId: request.listingId,
        engine: request.engine,
        fileCount: files.length,
        totalBytes,
        sourceHash,
      },
      entitlement: {
        provider: request.listingId ? "fab" : "local",
        authenticatedDownload: request.authenticatedDownload ?? false,
        acquisition: "none",
        license: request.license,
      },
      toolchain: { umodel: umodel.version, fabcli: request.fabcliVersion },
      cacheKey,
      reused: false,
      materials: coverage.textured === coverage.sections ? "complete" : "degraded",
      counts: {
        packages: candidates.length,
        exported: models.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      models,
      skipped,
      failed,
      materialCoverage: coverage,
      transforms,
      warnings,
      durationMs: Date.now() - started,
    };

    await writeFile(join(promotion, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rename(promotion, outputDir);
    log(`Promoted ${models.length} GLBs to ${outputDir}.`);
    return report;
  } catch (error) {
    await rm(promotion, { recursive: true, force: true });
    throw error;
  } finally {
    if (!request.keepStaging) await rm(staging, { recursive: true, force: true });
  }
}
