import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";

export interface RigLimits {
  maxGlbBytes: number;
  maxArchiveBytes: number;
  maxJoints: number;
  maxClips: number;
  maxMeshes: number;
  maxVertices: number;
  maxEntries: number;
  maxTextures: number;
}

export const RIG_LIMITS: RigLimits = Object.freeze({
  maxGlbBytes: 128 * 1024 * 1024,
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxJoints: 2_048,
  maxClips: 1_024,
  maxMeshes: 4_096,
  maxVertices: 8_000_000,
  maxEntries: 2_048,
  maxTextures: 4_096,
});

export type RigErrorCode =
  | "RIG_INVALID_INPUT"
  | "RIG_UNSAFE_PATH"
  | "RIG_INPUT_TOO_LARGE"
  | "RIG_INVALID_GLTF"
  | "RIG_LIMIT_EXCEEDED"
  | "RIG_ENTRY_NOT_FOUND"
  | "RIG_ACQUISITION_FAILED"
  | "RIG_DIGEST_MISMATCH"
  | "RIG_OUTPUT_CONFLICT";

export class RigAssetError extends Error {
  constructor(
    public readonly code: RigErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "RigAssetError";
  }
}

export interface MeshReport {
  name: string;
  primitives: number;
  vertices: number;
  attributes: string[];
  skinned: boolean;
}

export interface SkinReport {
  name: string;
  joints: number;
  jointNames: string[];
  hasInverseBindMatrices: boolean;
}

export interface AnimationReport {
  index: number;
  name: string;
  channels: number;
  samplers: number;
  durationSeconds: number | null;
}

export interface MaterialReport {
  name: string;
  doubleSided: boolean;
  alphaMode: string;
}

export interface BoneRoleSuggestion {
  role: string;
  side: "left" | "right" | null;
  joint: string | null;
  candidates: string[];
  ambiguous: boolean;
}

export interface RigReport {
  meshes: MeshReport[];
  skins: SkinReport[];
  animations: AnimationReport[];
  materials: MaterialReport[];
  textures: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  boneRoles: BoneRoleSuggestion[];
  attachmentCandidates: string[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ROLE_SYNONYMS: Record<string, readonly string[]> = {
  root: ["root"],
  hips: ["hips", "pelvis", "hip"],
  spine: ["spine", "spine01", "spine1", "spine02", "spine2"],
  chest: ["chest", "upperchest", "spine03", "spine3", "torso"],
  neck: ["neck", "neck1"],
  head: ["head"],
  shoulder: ["shoulder", "clavicle", "collar"],
  upper_arm: ["upperarm", "arm", "upperarmtwist", "shoulderarm"],
  forearm: ["forearm", "lowerarm", "elbow", "forearmtwist"],
  hand: ["hand", "wrist"],
  thigh: ["thigh", "upperleg", "upleg", "leg"],
  shin: ["shin", "calf", "lowerleg", "knee", "shintwist"],
  foot: ["foot", "ankle"],
  toe: ["toe", "toes", "ball", "toebase"],
};

const FINGER_PREFIXES = ["thumb", "index", "middle", "ring", "pinky", "little"];

const SIDE_SUFFIX = /(?:[._\-\s]?(left|right|[lr]))$/i;

function splitSide(name: string): { base: string; side: "left" | "right" | null } {
  const match = SIDE_SUFFIX.exec(name);
  if (!match) return { base: name, side: null };
  const token = match[1]!.toLowerCase();
  const side = token === "l" || token === "left" ? "left" : "right";
  return { base: name.slice(0, match.index), side };
}

function normalizeBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function roleForJoint(fallbackName: string): { role: string; side: "left" | "right" | null } | null {
  const { base, side } = splitSide(fallbackName);
  const normalized = normalizeBase(base);
  if (!normalized) return null;
  for (const [role, synonyms] of Object.entries(ROLE_SYNONYMS)) {
    if (synonyms.some((synonym) => normalizeBase(synonym) === normalized)) {
      return { role, side };
    }
  }
  for (const prefix of FINGER_PREFIXES) {
    if (normalized.includes(prefix)) return { role: "finger", side };
  }
  return null;
}

const CENTRAL_ROLES = new Set(["root", "hips", "spine", "chest", "neck", "head"]);

export function suggestBoneRoles(jointNames: readonly string[]): BoneRoleSuggestion[] {
  const result: BoneRoleSuggestion[] = [];
  const roles = [...Object.keys(ROLE_SYNONYMS), "finger"];
  for (const role of roles) {
    const sides: Array<"left" | "right" | "none"> = CENTRAL_ROLES.has(role)
      ? ["none"]
      : ["left", "right", "none"];
    for (const side of sides) {
      const candidates = jointNames.filter((name) => {
        const info = roleForJoint(name);
        if (!info || info.role !== role) return false;
        return side === "none" ? info.side === null : info.side === side;
      });
      if (candidates.length === 0) continue;
      result.push({
        role,
        side: side === "none" ? null : side,
        joint: candidates[0]!,
        candidates,
        ambiguous: candidates.length > 1,
      });
    }
  }
  return result;
}

function readGlbJson(bytes: Uint8Array): { extensionsUsed: string[]; extensionsRequired: string[] } {
  if (bytes.byteLength < 12) {
    throw new RigAssetError("RIG_INVALID_GLTF", "The GLB header is truncated.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new RigAssetError("RIG_INVALID_GLTF", "The file is not a glTF 2.0 binary.");
  }
  if (totalLength !== bytes.byteLength) {
    throw new RigAssetError(
      "RIG_INVALID_GLTF",
      "The GLB length header does not match the file size.",
    );
  }
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) {
      throw new RigAssetError("RIG_INVALID_GLTF", "A GLB chunk extends past the file end.");
    }
    if (chunkType === 0x4e4f534a) {
      const json = JSON.parse(
        new TextDecoder().decode(bytes.subarray(chunkStart, chunkEnd)).trim(),
      ) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
      return {
        extensionsUsed: Array.isArray(json.extensionsUsed)
          ? json.extensionsUsed.filter((value): value is string => typeof value === "string")
          : [],
        extensionsRequired: Array.isArray(json.extensionsRequired)
          ? json.extensionsRequired.filter((value): value is string => typeof value === "string")
          : [],
      };
    }
    offset = chunkEnd;
  }
  throw new RigAssetError("RIG_INVALID_GLTF", "The GLB has no JSON chunk.");
}

export function inspectGltfDocument(document: Document, limits: RigLimits): RigReport {
  const root = document.getRoot();
  const joints = root
    .listSkins()
    .flatMap((skin) => skin.listJoints())
    .map((joint) => joint.getName());
  if (joints.length > limits.maxJoints) {
    throw new RigAssetError(
      "RIG_LIMIT_EXCEEDED",
      `The rig has ${joints.length} joints, over the ${limits.maxJoints} joint limit.`,
    );
  }

  const meshes: MeshReport[] = [];
  let vertices = 0;
  const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    const attributes = new Set<string>();
    let meshVertices = 0;
    let skinned = false;
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) attributes.add(semantic);
      const position = primitive.getAttribute("POSITION");
      if (position) {
        meshVertices += position.getCount();
        const min = position.getMinNormalized([]);
        const max = position.getMaxNormalized([]);
        for (let axis = 0; axis < 3; axis += 1) {
          boundsMin[axis] = Math.min(boundsMin[axis]!, min[axis]!);
          boundsMax[axis] = Math.max(boundsMax[axis]!, max[axis]!);
        }
      }
      if (primitive.getAttribute("JOINTS_0")) skinned = true;
    }
    vertices += meshVertices;
    meshes.push({
      name: mesh.getName() || `mesh-${meshes.length}`,
      primitives: mesh.listPrimitives().length,
      vertices: meshVertices,
      attributes: [...attributes].sort(),
      skinned,
    });
  }
  if (vertices > limits.maxVertices) {
    throw new RigAssetError(
      "RIG_LIMIT_EXCEEDED",
      `The model has ${vertices} vertices, over the ${limits.maxVertices} vertex limit.`,
    );
  }
  if (meshes.length > limits.maxMeshes) {
    throw new RigAssetError(
      "RIG_LIMIT_EXCEEDED",
      `The model has ${meshes.length} meshes, over the ${limits.maxMeshes} mesh limit.`,
    );
  }

  const skins: SkinReport[] = root.listSkins().map((skin, index) => ({
    name: skin.getName() || `skin-${index}`,
    joints: skin.listJoints().length,
    jointNames: skin.listJoints().map((joint) => joint.getName()),
    hasInverseBindMatrices: Boolean(skin.getInverseBindMatrices()),
  }));

  const animations: AnimationReport[] = root.listAnimations().map((animation, index) => {
    let duration: number | null = null;
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (!input) continue;
      const times = input.getArray();
      if (!times || times.length === 0) continue;
      let max = -Infinity;
      for (let i = 0; i < times.length; i += 1) {
        const value = Number(times[i]);
        if (Number.isFinite(value) && value > max) max = value;
      }
      if (max >= 0) duration = duration === null ? max : Math.max(duration, max);
    }
    return {
      index,
      name: animation.getName() || `animation-${index}`,
      channels: animation.listChannels().length,
      samplers: animation.listSamplers().length,
      durationSeconds: duration,
    };
  });
  if (animations.length > limits.maxClips) {
    throw new RigAssetError(
      "RIG_LIMIT_EXCEEDED",
      `The model has ${animations.length} clips, over the ${limits.maxClips} clip limit.`,
    );
  }

  const textures = root.listTextures().length;
  if (textures > limits.maxTextures) {
    throw new RigAssetError(
      "RIG_LIMIT_EXCEEDED",
      `The model has ${textures} textures, over the ${limits.maxTextures} texture limit.`,
    );
  }

  const nonLeafJoints = new Set<string>();
  for (const node of root.listNodes()) {
    if (node.listChildren().length > 0) nonLeafJoints.add(node.getName());
  }
  const allJointNames = skins.flatMap((skin) => skin.jointNames);
  const attachmentCandidates = allJointNames.filter((name) => !nonLeafJoints.has(name));

  return {
    meshes,
    skins,
    animations,
    materials: root.listMaterials().map((material) => ({
      name: material.getName() || "material",
      doubleSided: material.getDoubleSided(),
      alphaMode: material.getAlphaMode(),
    })),
    textures,
    extensionsUsed: [],
    extensionsRequired: [],
    bounds:
      Number.isFinite(boundsMin[0]) && Number.isFinite(boundsMax[0])
        ? { min: boundsMin, max: boundsMax }
        : null,
    boneRoles: suggestBoneRoles(allJointNames),
    attachmentCandidates,
  };
}

export interface InspectedGlb {
  path: string;
  bytes: number;
  sha256: string;
  report: RigReport;
}

export interface InspectedLibrary {
  path: string;
  bytes: number;
  sha256: string;
  entries: InspectedGlb[];
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) {
    throw new RigAssetError("RIG_INVALID_INPUT", `No readable file at ${path}.`);
  }
  if (info.size > maxBytes) {
    throw new RigAssetError(
      "RIG_INPUT_TOO_LARGE",
      `${path} is ${info.size} bytes, over the ${maxBytes} byte limit.`,
    );
  }
  return new Uint8Array(await readFile(path));
}

export async function inspectGlbBytes(
  bytes: Uint8Array,
  label: string,
  limits: RigLimits = RIG_LIMITS,
): Promise<RigReport> {
  if (bytes.byteLength > limits.maxGlbBytes) {
    throw new RigAssetError(
      "RIG_INPUT_TOO_LARGE",
      `${label} is ${bytes.byteLength} bytes, over the ${limits.maxGlbBytes} byte GLB limit.`,
    );
  }
  const extensions = readGlbJson(bytes);
  let document: Document;
  try {
    document = await io.readBinary(bytes);
  } catch {
    throw new RigAssetError("RIG_INVALID_GLTF", `${label} is not a readable GLB asset.`);
  }
  return {
    ...inspectGltfDocument(document, limits),
    extensionsUsed: extensions.extensionsUsed,
    extensionsRequired: extensions.extensionsRequired,
  };
}

export async function inspectGlbFile(
  path: string,
  limits: RigLimits = RIG_LIMITS,
): Promise<InspectedGlb> {
  const resolved = await realpath(path).catch(() => null);
  if (!resolved) {
    throw new RigAssetError("RIG_INVALID_INPUT", `No readable file at ${path}.`);
  }
  const bytes = await readBoundedFile(resolved, limits.maxGlbBytes);
  return {
    path: resolved,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    report: await inspectGlbBytes(bytes, resolved, limits),
  };
}

function assertSafeEntryPath(name: string): void {
  if (
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new RigAssetError("RIG_UNSAFE_PATH", `Unsafe archive entry path: ${name}.`);
  }
}

async function readZipEntry(entry: FileEntry, maxBytes: number): Promise<Uint8Array> {
  if ((entry.uncompressedSize ?? 0) > maxBytes) {
    throw new RigAssetError(
      "RIG_INPUT_TOO_LARGE",
      `Archive entry ${entry.filename} is over the ${maxBytes} byte limit.`,
    );
  }
  return entry.getData(new Uint8ArrayWriter());
}

export async function inspectGlbArchive(
  path: string,
  limits: RigLimits = RIG_LIMITS,
): Promise<InspectedLibrary> {
  const resolved = await realpath(path).catch(() => null);
  if (!resolved) {
    throw new RigAssetError("RIG_INVALID_INPUT", `No readable archive at ${path}.`);
  }
  const bytes = await readBoundedFile(resolved, limits.maxArchiveBytes);
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { strictness: "strict" });
  try {
    const allEntries = await reader.getEntries();
    if (allEntries.length > limits.maxEntries) {
      throw new RigAssetError(
        "RIG_LIMIT_EXCEEDED",
        `The archive has ${allEntries.length} entries, over the ${limits.maxEntries} entry limit.`,
      );
    }
    const glbEntries = allEntries.filter(
      (entry): entry is FileEntry =>
        !entry.directory && entry.filename.toLowerCase().endsWith(".glb"),
    );
    if (glbEntries.length === 0) {
      throw new RigAssetError("RIG_ENTRY_NOT_FOUND", `${resolved} contains no GLB entries.`);
    }
    const entries: InspectedGlb[] = [];
    for (const entry of glbEntries) {
      assertSafeEntryPath(entry.filename);
      const data = await readZipEntry(entry, limits.maxGlbBytes);
      entries.push({
        path: entry.filename,
        bytes: data.byteLength,
        sha256: sha256(data),
        report: await inspectGlbBytes(data, entry.filename, limits),
      });
    }
    return {
      path: resolved,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      entries,
    };
  } finally {
    await reader.close();
  }
}

export async function inspectLocalAsset(
  path: string,
  limits: RigLimits = RIG_LIMITS,
): Promise<{ kind: "glb"; glb: InspectedGlb } | { kind: "archive"; library: InspectedLibrary }> {
  if (!isAbsolute(path) && resolve(path) !== path) {
    throw new RigAssetError("RIG_INVALID_INPUT", `Asset path must be absolute: ${path}.`);
  }
  return path.toLowerCase().endsWith(".glb")
    ? { kind: "glb", glb: await inspectGlbFile(path, limits) }
    : { kind: "archive", library: await inspectGlbArchive(path, limits) };
}
