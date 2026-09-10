import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import { z } from "zod";

import type { CreatureConfig, CreatureLimits } from "../config.js";

const CompilerSummarySchema = z
  .object({
    ok: z.literal(true),
    out: z.string(),
    bytes: z.number().int().positive(),
    dims: z.object({
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      length: z.number().finite().nonnegative(),
    }),
    verts: z.number().int().positive(),
    faces: z.number().int().positive(),
    joints: z.number().int().positive(),
    anims: z.array(z.string().min(1)),
    checks: z.literal("all green"),
    contract: z.literal("ok"),
  })
  .passthrough();

const ChecksSchema = z
  .object({
    passed: z.literal(true),
    checks: z
      .array(
        z.object({
          name: z.string().min(1),
          passed: z.boolean(),
          warned: z.boolean().optional(),
        }),
      )
      .min(1),
    blocking: z.array(z.unknown()).max(0),
    measures: z.array(z.string()),
  })
  .passthrough();

export type CreatureErrorCode =
  | "INVALID_SPEC"
  | "COMPILE_BLOCKED"
  | "OUTPUT_INVALID"
  | "OUTPUT_CONFLICT"
  | "TOOLCHAIN_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "BUSY";

export class CreatureOperationError extends Error {
  readonly code: CreatureErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: CreatureErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CreatureOperationError";
    this.code = code;
    this.detail = detail;
  }
}

export interface CreaturePayloadDescriptor {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly version: string;
  readonly commit: string;
  readonly root: string;
  readonly files: readonly string[];
}

export interface CreatureCompileRequest {
  readonly specPath: string;
  readonly outputPath: string;
  readonly expectedOutputSha256?: string;
}

export interface CreatureCompileMeasurements {
  readonly bytes: number;
  readonly bounds: { readonly width: number; readonly height: number; readonly length: number };
  readonly vertices: number;
  readonly faces: number;
  readonly joints: number;
  readonly clips: readonly string[];
}

export interface CreatureCompileResult {
  readonly operation: "creature_compile";
  readonly specPath: string;
  readonly outputPath: string;
  readonly sourceSnapshotPath: string;
  readonly checksPath: string;
  readonly diagnosticsPath: string;
  readonly receiptPath: string;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly checksSha256: string;
  readonly payload: {
    readonly version: string;
    readonly commit: string;
    readonly archiveSha256: string;
  };
  readonly measurements: CreatureCompileMeasurements;
  readonly limits: CreatureLimits;
  readonly durationMs: number;
  readonly unchanged: boolean;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly overflow: boolean;
  readonly spawnError?: Error;
}

interface GlbIdentity {
  readonly clips: readonly string[];
  readonly joints: number;
  readonly vertices: number;
  readonly faces: number;
  readonly bounds: { readonly width: number; readonly height: number; readonly length: number };
}

interface StatePaths {
  readonly root: string;
  readonly staging: string;
  readonly locks: string;
  readonly sources: string;
  readonly diagnostics: string;
  readonly checks: string;
  readonly receipts: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function projectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function nodeErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function canonicalMissingPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missing);
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTDIR"]).has(nodeErrorCode(error) ?? "")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function assertRelativePath(path: string, label: string): void {
  if (
    !path.trim() ||
    isAbsolute(path) ||
    path.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith("//")
  ) {
    throw new CreatureOperationError(
      "INVALID_SPEC",
      `${label} must be a project-relative path inside the server launch root.`,
      { field: label },
    );
  }
}

function assertFiniteValues(value: unknown, location = "spec"): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CreatureOperationError("INVALID_SPEC", `${location} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFiniteValues(entry, `${location}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertFiniteValues(entry, `${location}.${key}`);
  }
}

function validateSpec(value: unknown): void {
  if (!isRecord(value)) {
    throw new CreatureOperationError("INVALID_SPEC", "The creature spec must be a JSON object.");
  }
  assertFiniteValues(value);
  const palette = value.palette;
  const joints = value.joints;
  const chains = value.chains;
  const volumes = value.volumes;
  if (!isRecord(palette) || !Object.keys(palette).length) {
    throw new CreatureOperationError("INVALID_SPEC", "The creature spec needs a nonempty palette object.");
  }
  if (!isRecord(joints) || !Object.keys(joints).length) {
    throw new CreatureOperationError("INVALID_SPEC", "The creature spec needs a nonempty joints object.");
  }
  if (!isRecord(chains) || !Object.keys(chains).length) {
    throw new CreatureOperationError("INVALID_SPEC", "The creature spec needs a nonempty chains object.");
  }
  if (!Array.isArray(volumes) || !volumes.length) {
    throw new CreatureOperationError("INVALID_SPEC", "The creature spec needs at least one volume.");
  }

  const jointNames = new Set(Object.keys(joints));
  const mirroredJointNames = new Set<string>();
  const mirroredChains = Array.isArray(value.mirror)
    ? value.mirror.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const [chainName, chainValue] of Object.entries(chains)) {
    if (!Array.isArray(chainValue) || !chainValue.length || chainValue.some((entry) => typeof entry !== "string")) {
      throw new CreatureOperationError("INVALID_SPEC", `Chain '${chainName}' must contain joint names.`);
    }
    for (const joint of chainValue as string[]) {
      if (!jointNames.has(joint)) {
        throw new CreatureOperationError("INVALID_SPEC", `Chain '${chainName}' references missing joint '${joint}'.`);
      }
      if (mirroredChains.includes(chainName) && joint.startsWith("L")) mirroredJointNames.add(`R${joint.slice(1)}`);
    }
  }

  const attach = value.attach;
  if (attach !== undefined) {
    if (!isRecord(attach)) throw new CreatureOperationError("INVALID_SPEC", "Spec attach must be an object.");
    for (const [chainName, host] of Object.entries(attach)) {
      if (!(chainName in chains) || typeof host !== "string" || !jointNames.has(host)) {
        throw new CreatureOperationError("INVALID_SPEC", `Attachment '${chainName}' must name an existing chain and host joint.`);
      }
    }
  }

  for (const [index, volume] of volumes.entries()) {
    if (!isRecord(volume) || typeof volume.chain !== "string" || !(volume.chain in chains)) {
      throw new CreatureOperationError("INVALID_SPEC", `Volume ${index} references an unknown chain.`);
    }
    if (typeof volume.material !== "string" || !(volume.material in palette)) {
      throw new CreatureOperationError("INVALID_SPEC", `Volume ${index} references an unknown material.`);
    }
  }
  if (Array.isArray(value.parts)) {
    for (const [index, part] of value.parts.entries()) {
      if (!isRecord(part)) throw new CreatureOperationError("INVALID_SPEC", `Part ${index} must be an object.`);
      if (typeof part.material !== "string" || !(part.material in palette)) {
        throw new CreatureOperationError("INVALID_SPEC", `Part ${index} references an unknown material.`);
      }
      if (typeof part.host === "string" && !jointNames.has(part.host) && !mirroredJointNames.has(part.host)) {
        throw new CreatureOperationError("INVALID_SPEC", `Part ${index} references missing host joint '${part.host}'.`);
      }
    }
  }
  if (value.animations !== undefined) {
    if (!isRecord(value.animations)) throw new CreatureOperationError("INVALID_SPEC", "Spec animations must be an object.");
    for (const [clipName, clip] of Object.entries(value.animations)) {
      if (!isRecord(clip) || !isRecord(clip.tracks) || !Object.keys(clip.tracks).length) {
        throw new CreatureOperationError("INVALID_SPEC", `Animation '${clipName}' needs nonempty tracks.`);
      }
      for (const trackName of Object.keys(clip.tracks)) {
        if (!jointNames.has(trackName) && !mirroredJointNames.has(trackName)) {
          throw new CreatureOperationError("INVALID_SPEC", `Animation '${clipName}' references missing joint '${trackName}'.`);
        }
      }
    }
  }
}

function fileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory;
}

function assertSafeArchiveEntry(entry: Entry, descriptor: CreaturePayloadDescriptor): void {
  const name = entry.filename;
  if (
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    !name.startsWith(descriptor.root) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged creature payload contains an unsafe path.");
  }
  const unixType = (entry.unixMode ?? (entry.externalFileAttributes >>> 16)) & 0o170000;
  if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
    throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged creature payload contains a symlink or special file.");
  }
}

async function listTree(root: string, prefix = ""): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The extracted creature payload contains a symlink.");
    }
    if (entry.isDirectory()) output.push(...(await listTree(root, name)));
    else if (entry.isFile()) output.push(name);
    else throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The extracted creature payload contains a special file.");
  }
  return output.sort();
}

function dependencySearchPath(): string {
  const require = createRequire(import.meta.url);
  return [...new Set(require.resolve.paths("@zip.js/zip.js") ?? [])].join(delimiter);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.NODE_PATH = dependencySearchPath();
  return environment;
}

function parseGlb(bytes: Buffer): GlbIdentity {
  if (bytes.length < 28 || bytes.subarray(0, 4).toString("ascii") !== "glTF") {
    throw new CreatureOperationError("OUTPUT_INVALID", "The compiler output is not a GLB container.");
  }
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB header version or declared byte length is invalid.");
  }
  let offset = 12;
  const chunks: Array<{ type: number; data: Buffer }> = [];
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new CreatureOperationError("OUTPUT_INVALID", "The GLB chunk header is truncated.");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.length) {
      throw new CreatureOperationError("OUTPUT_INVALID", "The GLB chunk length is invalid.");
    }
    chunks.push({ type, data: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (offset !== bytes.length || chunks.length !== 2 || chunks[0]?.type !== 0x4e4f534a || chunks[1]?.type !== 0x004e4942) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB must contain exactly one JSON chunk followed by one BIN chunk.");
  }
  let document: unknown;
  try {
    document = JSON.parse(chunks[0].data.toString("utf8").replace(/[\0 ]+$/u, ""));
  } catch {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB JSON chunk is malformed.");
  }
  if (!isRecord(document)) throw new CreatureOperationError("OUTPUT_INVALID", "The GLB JSON document is invalid.");
  const buffers = document.buffers;
  const meshes = document.meshes;
  const skins = document.skins;
  const nodes = document.nodes;
  const animations = document.animations;
  const accessors = document.accessors;
  const bufferViews = document.bufferViews;
  if (!Array.isArray(buffers) || buffers.length !== 1 || !isRecord(buffers[0]) || "uri" in buffers[0]) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB must have one embedded buffer and no external URI.");
  }
  if (!Array.isArray(meshes) || meshes.length !== 1 || !Array.isArray(skins) || skins.length !== 1 || !Array.isArray(nodes) || !Array.isArray(accessors) || !Array.isArray(bufferViews)) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB must contain one mesh, one skin, and a node table.");
  }
  if ((Array.isArray(document.images) && document.images.length > 0) || (Array.isArray(document.textures) && document.textures.length > 0) || document.extensionsRequired !== undefined) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB contains externalizable media or required extensions outside the creature output contract.");
  }
  const binary = chunks[1]?.data;
  const declaredBinaryLength = buffers[0].byteLength;
  if (
    !binary ||
    !Number.isInteger(declaredBinaryLength) ||
    (declaredBinaryLength as number) <= 0 ||
    (declaredBinaryLength as number) > binary.length ||
    binary.length - (declaredBinaryLength as number) > 3
  ) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB embedded BIN length is invalid.");
  }
  for (const view of bufferViews) {
    if (!isRecord(view)) throw new CreatureOperationError("OUTPUT_INVALID", "The GLB contains an invalid bufferView.");
    const byteOffset = view.byteOffset ?? 0;
    if (
      view.buffer !== 0 ||
      !Number.isInteger(byteOffset) ||
      (byteOffset as number) < 0 ||
      !Number.isInteger(view.byteLength) ||
      (view.byteLength as number) <= 0 ||
      (byteOffset as number) + (view.byteLength as number) > (declaredBinaryLength as number)
    ) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB bufferView escapes the embedded BIN.");
    }
  }
  const componentBytes = new Map<number, number>([
    [5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4],
  ]);
  const typeComponents = new Map<string, number>([
    ["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4], ["MAT2", 4], ["MAT3", 9], ["MAT4", 16],
  ]);
  const accessorLayout = (index: number) => {
    const accessor = accessors[index];
    if (!isRecord(accessor) || "sparse" in accessor || !Number.isInteger(accessor.bufferView)) {
      throw new CreatureOperationError("OUTPUT_INVALID", "The GLB contains an unsupported or unbound accessor.");
    }
    const view = bufferViews[accessor.bufferView as number];
    if (!isRecord(view)) throw new CreatureOperationError("OUTPUT_INVALID", "A GLB accessor references a missing bufferView.");
    const bytesPerComponent = componentBytes.get(accessor.componentType as number);
    const components = typeComponents.get(accessor.type as string);
    const count = accessor.count;
    const accessorOffset = accessor.byteOffset ?? 0;
    if (
      bytesPerComponent === undefined ||
      components === undefined ||
      !Number.isInteger(count) ||
      (count as number) <= 0 ||
      !Number.isInteger(accessorOffset) ||
      (accessorOffset as number) < 0
    ) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB accessor has an invalid component, type, count, or offset.");
    }
    const elementBytes = bytesPerComponent * components;
    const stride = view.byteStride ?? elementBytes;
    if (
      !Number.isInteger(stride) ||
      (stride as number) < elementBytes ||
      (stride as number) % bytesPerComponent !== 0 ||
      (accessorOffset as number) + ((count as number) - 1) * (stride as number) + elementBytes > (view.byteLength as number)
    ) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB accessor range escapes its bufferView.");
    }
    return {
      accessor,
      count: count as number,
      elementBytes,
      stride: stride as number,
      absoluteOffset: (view.byteOffset as number | undefined ?? 0) + (accessorOffset as number),
    };
  };
  for (let index = 0; index < accessors.length; index += 1) accessorLayout(index);
  const skin = skins[0];
  if (!isRecord(skin) || !Array.isArray(skin.joints) || !skin.joints.length || skin.joints.some((joint) => !Number.isInteger(joint) || joint < 0 || joint >= nodes.length)) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB skin has invalid joint bindings.");
  }
  const mesh = meshes[0];
  if (!isRecord(mesh) || !Array.isArray(mesh.primitives) || !mesh.primitives.length) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB creature mesh has no primitives.");
  }
  let vertices = 0;
  let faces = 0;
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const primitive of mesh.primitives) {
    if (!isRecord(primitive) || !isRecord(primitive.attributes)) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB creature primitive has no attributes.");
    }
    const positionIndex = primitive.attributes.POSITION;
    const jointsIndex = primitive.attributes.JOINTS_0;
    const weightsIndex = primitive.attributes.WEIGHTS_0;
    const indicesIndex = primitive.indices;
    if (![positionIndex, jointsIndex, weightsIndex, indicesIndex].every((index) => Number.isInteger(index) && (index as number) >= 0 && (index as number) < accessors.length)) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB creature primitive is missing bounded position, index, joint, or weight accessors.");
    }
    const position = accessors[positionIndex as number];
    const indices = accessors[indicesIndex as number];
    if (!isRecord(position) || !isRecord(indices) || !Number.isInteger(position.count) || !Number.isInteger(indices.count) || (position.count as number) <= 0 || (indices.count as number) <= 0 || (indices.count as number) % 3 !== 0 || !Array.isArray(position.min) || !Array.isArray(position.max) || position.min.length !== 3 || position.max.length !== 3) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB creature primitive has invalid position bounds or triangle counts.");
    }
    const positionLayout = accessorLayout(positionIndex as number);
    const jointsLayout = accessorLayout(jointsIndex as number);
    const weightsLayout = accessorLayout(weightsIndex as number);
    const indicesLayout = accessorLayout(indicesIndex as number);
    if (
      position.componentType !== 5126 || position.type !== "VEC3" ||
      !isRecord(accessors[jointsIndex as number]) || accessors[jointsIndex as number].type !== "VEC4" ||
      !new Set([5121, 5123]).has(accessors[jointsIndex as number].componentType as number) ||
      !isRecord(accessors[weightsIndex as number]) || accessors[weightsIndex as number].componentType !== 5126 || accessors[weightsIndex as number].type !== "VEC4" ||
      indices.type !== "SCALAR" || !new Set([5121, 5123, 5125]).has(indices.componentType as number) ||
      jointsLayout.count !== positionLayout.count || weightsLayout.count !== positionLayout.count
    ) {
      throw new CreatureOperationError("OUTPUT_INVALID", "A GLB creature primitive has incompatible geometry or skin accessor types.");
    }
    for (let index = 0; index < indicesLayout.count; index += 1) {
      const valueOffset = indicesLayout.absoluteOffset + index * indicesLayout.stride;
      const value = indices.componentType === 5121
        ? binary.readUInt8(valueOffset)
        : indices.componentType === 5123
          ? binary.readUInt16LE(valueOffset)
          : binary.readUInt32LE(valueOffset);
      if (value >= positionLayout.count) {
        throw new CreatureOperationError("OUTPUT_INVALID", "A GLB index references a missing vertex.");
      }
    }
    vertices += position.count as number;
    faces += (indices.count as number) / 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const low = position.min[axis];
      const high = position.max[axis];
      if (typeof low !== "number" || typeof high !== "number" || !Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        throw new CreatureOperationError("OUTPUT_INVALID", "A GLB creature primitive has non-finite or reversed position bounds.");
      }
      minimum[axis] = Math.min(minimum[axis] ?? low, low);
      maximum[axis] = Math.max(maximum[axis] ?? high, high);
    }
  }
  const jointNodes = new Set(skin.joints as number[]);
  if (!Number.isInteger(skin.inverseBindMatrices)) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB skin is missing inverse bind matrices.");
  }
  const inverseBind = accessorLayout(skin.inverseBindMatrices as number);
  if (inverseBind.accessor.componentType !== 5126 || inverseBind.accessor.type !== "MAT4" || inverseBind.count !== skin.joints.length) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The GLB inverse bind matrices do not match the rig.");
  }
  if (!Array.isArray(animations)) throw new CreatureOperationError("OUTPUT_INVALID", "The GLB animation table is missing.");
  const clips = animations.map((animation, index) => {
    if (!isRecord(animation) || typeof animation.name !== "string" || !animation.name || !Array.isArray(animation.channels) || !animation.channels.length || !Array.isArray(animation.samplers) || !animation.samplers.length) {
      throw new CreatureOperationError("OUTPUT_INVALID", `GLB animation ${index} has no usable channels or samplers.`);
    }
    for (const channel of animation.channels) {
      if (!isRecord(channel) || !isRecord(channel.target) || !Number.isInteger(channel.target.node) || (channel.target.node as number) < 0 || (channel.target.node as number) >= nodes.length || !Number.isInteger(channel.sampler) || (channel.sampler as number) < 0 || (channel.sampler as number) >= animation.samplers.length) {
        throw new CreatureOperationError("OUTPUT_INVALID", `GLB animation '${animation.name}' targets a missing node.`);
      }
      if (!jointNodes.has(channel.target.node as number)) {
        throw new CreatureOperationError("OUTPUT_INVALID", `GLB animation '${animation.name}' has a channel that does not bind to its rig.`);
      }
      const sampler = animation.samplers[channel.sampler as number];
      if (!isRecord(sampler) || !Number.isInteger(sampler.input) || !Number.isInteger(sampler.output)) {
        throw new CreatureOperationError("OUTPUT_INVALID", `GLB animation '${animation.name}' has an invalid sampler.`);
      }
      const input = accessorLayout(sampler.input as number);
      const output = accessorLayout(sampler.output as number);
      const expectedOutputType = channel.target.path === "rotation"
        ? "VEC4"
        : new Set(["translation", "scale"]).has(channel.target.path as string)
          ? "VEC3"
          : undefined;
      if (
        input.accessor.componentType !== 5126 || input.accessor.type !== "SCALAR" ||
        output.accessor.componentType !== 5126 || output.accessor.type !== expectedOutputType ||
        input.count !== output.count
      ) {
        throw new CreatureOperationError("OUTPUT_INVALID", `GLB animation '${animation.name}' sampler ranges do not match its target path.`);
      }
    }
    return animation.name;
  });
  return {
    clips,
    joints: skin.joints.length,
    vertices,
    faces,
    bounds: {
      width: Number(((maximum[0] ?? 0) - (minimum[0] ?? 0)).toFixed(3)),
      height: Number(((maximum[1] ?? 0) - (minimum[1] ?? 0)).toFixed(3)),
      length: Number(((maximum[2] ?? 0) - (minimum[2] ?? 0)).toFixed(3)),
    },
  };
}

function compilerCheckIds(stderr: string): string[] {
  const ids = new Set<string>();
  for (const line of stderr.split("\n")) {
    const match = /^BLOCK:\s+(?:contract\s+\[([^\]]+)\]|([a-z][a-z0-9_]*)(?::|\b))/iu.exec(line.trim());
    const id = match?.[1] ?? match?.[2];
    if (id) ids.add(id);
  }
  return [...ids];
}

function processGroupSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      try {
        child.kill(signal);
      } catch {
        // The process exited before the fixed descendant terminator started.
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process exited between the state check and signal delivery.
    }
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function prepareAtomicWrite(path: string, bytes: Uint8Array): Promise<string> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function hashExistingFile(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new CreatureOperationError("OUTPUT_CONFLICT", "The output destination is not a regular file.");
    }
    if (info.size > maxBytes) {
      throw new CreatureOperationError("OUTPUT_CONFLICT", `The existing output exceeds the ${maxBytes}-byte GLB cap; move or inspect it before compiling.`);
    }
    return sha256(await readFile(path));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export class CreatureRunner {
  readonly limits: CreatureLimits;
  readonly payload: CreaturePayloadDescriptor;
  readonly launchRoot: string;
  private readonly cacheDir: string;
  private active: ActiveRun | undefined;
  private closing = false;
  private readonly destinationLocks = new Set<string>();

  constructor(config: CreatureConfig, launchRoot: string, payload: CreaturePayloadDescriptor) {
    this.limits = config.limits;
    this.cacheDir = config.cacheDir;
    this.launchRoot = resolve(launchRoot);
    this.payload = payload;
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort({ kind: "cancelled", source: "shutdown" });
    await active.done;
  }

  async compile(request: CreatureCompileRequest, callerSignal?: AbortSignal): Promise<CreatureCompileResult> {
    if (this.closing) throw new CreatureOperationError("CANCELLED", "The creature compiler is shutting down; start the server again and retry.");
    if (this.active || this.limits.maxActiveHeavyOperations !== 1) {
      throw new CreatureOperationError("BUSY", "Another creature operation is active; retry after it finishes.", { retryable: true });
    }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => {
      finish = resolveDone;
    });
    this.active = { controller, done };
    const onCancel = () => controller.abort({ kind: "cancelled", source: "client" });
    callerSignal?.addEventListener("abort", onCancel, { once: true });
    if (callerSignal?.aborted) onCancel();
    const timer = setTimeout(() => controller.abort({ kind: "timeout" }), this.limits.compileTimeoutMs);
    try {
      return await this.compileActive(request, controller.signal);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCancel);
      this.active = undefined;
      finish();
    }
  }

  private async compileActive(request: CreatureCompileRequest, signal: AbortSignal): Promise<CreatureCompileResult> {
    const startedAt = Date.now();
    assertRelativePath(request.specPath, "specPath");
    assertRelativePath(request.outputPath, "outputPath");
    if (extname(request.outputPath).toLowerCase() !== ".glb") {
      throw new CreatureOperationError("INVALID_SPEC", "outputPath must end in .glb.", { field: "outputPath" });
    }
    const root = await realpath(this.launchRoot).catch(() => {
      throw new CreatureOperationError("INVALID_SPEC", "The server launch root is unavailable.");
    });
    const specAbsolute = await realpath(resolve(root, request.specPath)).catch(() => {
      throw new CreatureOperationError("INVALID_SPEC", `Spec '${request.specPath}' does not exist.`);
    });
    if (!isInside(specAbsolute, root)) {
      throw new CreatureOperationError("INVALID_SPEC", "specPath escapes the server launch root.", { field: "specPath" });
    }
    const outputAbsolute = await canonicalMissingPath(resolve(root, request.outputPath));
    if (!isInside(outputAbsolute, root)) {
      throw new CreatureOperationError("INVALID_SPEC", "outputPath escapes the server launch root through traversal or a symlink.", { field: "outputPath" });
    }
    if (this.destinationLocks.has(outputAbsolute)) {
      throw new CreatureOperationError("BUSY", "This creature output is already being compiled; retry after it finishes.", { retryable: true });
    }
    this.destinationLocks.add(outputAbsolute);

    let stagingDirectory: string | undefined;
    let lockPath: string | undefined;
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsLock = false;
    let publicationTemporary: string | undefined;
    let previousOutputBackup: string | undefined;
    let rollbackCapture: string | undefined;
    let receiptTemporary: string | undefined;
    let publicationCommitted = false;
    const rollback = { state: "none" as "none" | "prepared" | "complete" | "preserved" };
    try {
      const sourceInfo = await stat(specAbsolute);
      if (!sourceInfo.isFile() || sourceInfo.size > this.limits.specBytes) {
        throw new CreatureOperationError("INVALID_SPEC", `The creature spec must be a regular JSON file no larger than ${this.limits.specBytes} bytes.`);
      }
      const sourceBytes = await readFile(specAbsolute);
      if (sourceBytes.length > this.limits.specBytes) {
        throw new CreatureOperationError("INVALID_SPEC", `The creature spec exceeds the ${this.limits.specBytes}-byte cap.`);
      }
      let sourceText: string;
      let sourceValue: unknown;
      try {
        sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
        sourceValue = JSON.parse(sourceText) as unknown;
      } catch {
        throw new CreatureOperationError("INVALID_SPEC", "The creature spec must be well-formed UTF-8 JSON.");
      }
      validateSpec(sourceValue);
      if (signal.aborted) throw this.abortError(signal);

      const state = await this.ensureState(root);
      const inputSha256 = sha256(sourceBytes);
      const sourceSnapshotAbsolute = join(state.sources, `${inputSha256}.json`);
      await this.writeImmutable(sourceSnapshotAbsolute, sourceBytes, inputSha256);

      const destinationKey = sha256(Buffer.from(projectPath(root, outputAbsolute))).slice(0, 24);
      lockPath = join(state.locks, `${destinationKey}.lock`);
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        ownsLock = true;
        await lockHandle.writeFile(JSON.stringify({ pid: process.pid, outputPath: request.outputPath }));
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") {
          throw new CreatureOperationError("BUSY", "This creature output is locked by another operation; retry after it finishes.", { retryable: true });
        }
        throw error;
      }

      const initialOutputSha256 = await hashExistingFile(outputAbsolute, this.limits.glbBytes);
      if (request.expectedOutputSha256 !== undefined && request.expectedOutputSha256 !== initialOutputSha256) {
        throw new CreatureOperationError("OUTPUT_CONFLICT", "The existing output hash does not match expectedOutputSha256; inspect the current asset before retrying.", {
          expectedOutputSha256: request.expectedOutputSha256,
          observedOutputSha256: initialOutputSha256 ?? null,
        });
      }

      const toolchainRoot = await this.ensurePayload(signal);
      stagingDirectory = await mkdtemp(join(state.staging, "compile-"));
      await writeFile(join(stagingDirectory, ".private"), "creature compiler staging\n", { mode: 0o600 });
      const stagedOutput = join(stagingDirectory, "creature.glb");
      const processResult = await this.runCompiler(join(toolchainRoot, "engine", "cli.js"), sourceSnapshotAbsolute, stagedOutput, signal);
      const diagnostics = Buffer.concat([
        Buffer.from("[stdout]\n"),
        processResult.stdout,
        Buffer.from("\n[stderr]\n"),
        processResult.stderr,
      ]);
      const diagnosticsAbsolute = join(state.diagnostics, `${destinationKey}-${randomUUID()}.log`);
      await atomicWrite(diagnosticsAbsolute, diagnostics.subarray(0, this.limits.diagnosticsBytes));

      if (signal.aborted) throw this.abortError(signal, diagnosticsAbsolute, root);
      if (processResult.overflow) {
        throw new CreatureOperationError("OUTPUT_INVALID", `Compiler diagnostics exceeded the ${this.limits.diagnosticsBytes}-byte cap.`, {
          diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        });
      }
      if (processResult.spawnError) {
        throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The fixed packaged Node compiler could not be started.", {
          diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        });
      }
      if (processResult.exitCode !== 0) {
        const compilerStderr = processResult.stderr.toString("utf8");
        const checkIds = compilerCheckIds(compilerStderr);
        throw new CreatureOperationError("COMPILE_BLOCKED", "The pinned anyCreature compiler blocked this spec; revise the reported checks and retry.", {
          checkIds,
          exitCode: processResult.exitCode,
          diagnostics: compilerStderr.slice(-4_000),
          diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        });
      }

      const summary = this.parseSummary(processResult.stdout, stagedOutput, diagnosticsAbsolute, root);
      const stagedInfo = await stat(stagedOutput).catch(() => undefined);
      if (!stagedInfo?.isFile() || stagedInfo.size <= 0 || stagedInfo.size > this.limits.glbBytes) {
        throw new CreatureOperationError("OUTPUT_INVALID", `Compiler output is missing or exceeds the ${this.limits.glbBytes}-byte GLB cap.`, {
          diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        });
      }
      const glbBytes = await readFile(stagedOutput);
      const identity = parseGlb(glbBytes);
      // Upstream's `faces` summary counts authored polygons, while the GLB stores
      // triangulated indices. The receipt therefore records the parsed GLB count.
      if (
        summary.bytes !== glbBytes.length ||
        summary.joints !== identity.joints ||
        summary.verts !== identity.vertices ||
        summary.anims.join("\0") !== identity.clips.join("\0") ||
        summary.dims.width !== identity.bounds.width ||
        summary.dims.height !== identity.bounds.height ||
        summary.dims.length !== identity.bounds.length
      ) {
        throw new CreatureOperationError("OUTPUT_INVALID", "The compiler summary does not match the generated GLB.", {
          diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        });
      }
      const stagedChecks = stagedOutput.replace(/\.glb$/iu, ".checks.json");
      const checksBytes = await readFile(stagedChecks).catch(() => {
        throw new CreatureOperationError("OUTPUT_INVALID", "The compiler did not produce its checks sidecar.");
      });
      if (checksBytes.length > this.limits.diagnosticsBytes) {
        throw new CreatureOperationError("OUTPUT_INVALID", "The compiler checks sidecar exceeds the diagnostics cap.");
      }
      let checksValue: unknown;
      try {
        checksValue = JSON.parse(checksBytes.toString("utf8")) as unknown;
      } catch {
        throw new CreatureOperationError("OUTPUT_INVALID", "The compiler checks sidecar is malformed.");
      }
      const checks = ChecksSchema.safeParse(checksValue);
      if (!checks.success || checks.data.checks.some((check) => !check.passed)) {
        throw new CreatureOperationError("OUTPUT_INVALID", "The compiler checks sidecar does not certify every emitted check.");
      }

      const outputSha256 = sha256(glbBytes);
      const checksSha256 = sha256(checksBytes);
      const observedBeforePublish = await hashExistingFile(outputAbsolute, this.limits.glbBytes);
      if (observedBeforePublish !== initialOutputSha256) {
        throw new CreatureOperationError("OUTPUT_CONFLICT", "The output changed while compilation was running; the stale writer was rejected.", {
          initialOutputSha256: initialOutputSha256 ?? null,
          observedOutputSha256: observedBeforePublish ?? null,
        });
      }
      if (initialOutputSha256 !== undefined && request.expectedOutputSha256 === undefined && initialOutputSha256 !== outputSha256) {
        throw new CreatureOperationError("OUTPUT_CONFLICT", "A different output already exists; retry with its SHA-256 as expectedOutputSha256 after inspecting it.", {
          observedOutputSha256: initialOutputSha256,
        });
      }

      await mkdir(dirname(outputAbsolute), { recursive: true });
      const recanonicalizedOutput = await canonicalMissingPath(outputAbsolute);
      if (recanonicalizedOutput !== outputAbsolute || !isInside(recanonicalizedOutput, root)) {
        throw new CreatureOperationError("OUTPUT_CONFLICT", "The output destination changed or escaped before publication.");
      }
      const unchanged = initialOutputSha256 === outputSha256;
      const checksAbsolute = join(state.checks, `${destinationKey}-${outputSha256}.checks.json`);
      await this.writeImmutable(checksAbsolute, checksBytes, checksSha256);
      const measurements: CreatureCompileMeasurements = {
        bytes: glbBytes.length,
        bounds: identity.bounds,
        vertices: identity.vertices,
        faces: identity.faces,
        joints: identity.joints,
        clips: identity.clips,
      };
      const receiptAbsolute = join(
        state.receipts,
        `${destinationKey}-${inputSha256}-${outputSha256}-${randomUUID()}.json`,
      );
      const receipt = {
        schemaVersion: 1,
        operation: "creature_compile",
        createdAt: new Date().toISOString(),
        specPath: projectPath(root, specAbsolute),
        outputPath: projectPath(root, outputAbsolute),
        sourceSnapshotPath: projectPath(root, sourceSnapshotAbsolute),
        checksPath: projectPath(root, checksAbsolute),
        diagnosticsPath: projectPath(root, diagnosticsAbsolute),
        inputSha256,
        outputSha256,
        checksSha256,
        payload: {
          version: this.payload.version,
          commit: this.payload.commit,
          archiveSha256: this.payload.archiveSha256,
        },
        measurements,
        limits: this.limits,
        durationMs: Date.now() - startedAt,
        unchanged,
      };
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
      receiptTemporary = await prepareAtomicWrite(receiptAbsolute, receiptBytes);

      if (!unchanged) {
        publicationTemporary = join(dirname(outputAbsolute), `.${basename(outputAbsolute)}.${randomUUID()}.tmp`);
        await copyFile(stagedOutput, publicationTemporary, constants.COPYFILE_EXCL);
        const publicationHandle = await open(publicationTemporary, "r");
        await publicationHandle.sync();
        await publicationHandle.close();
        if (initialOutputSha256 !== undefined) {
          previousOutputBackup = join(dirname(outputAbsolute), `.${basename(outputAbsolute)}.${randomUUID()}.rollback`);
          await copyFile(outputAbsolute, previousOutputBackup, constants.COPYFILE_EXCL);
          const backupHandle = await open(previousOutputBackup, "r");
          await backupHandle.sync();
          await backupHandle.close();
          if ((await hashExistingFile(previousOutputBackup, this.limits.glbBytes)) !== initialOutputSha256) {
            throw new CreatureOperationError("OUTPUT_CONFLICT", "The previous creature output changed while its rollback copy was prepared.");
          }
          rollback.state = "prepared";
        }
        if ((await hashExistingFile(outputAbsolute, this.limits.glbBytes)) !== initialOutputSha256) {
          throw new CreatureOperationError("OUTPUT_CONFLICT", "The output changed during publication; the stale writer was rejected.");
        }
        if (signal.aborted) throw this.abortError(signal, diagnosticsAbsolute, root);
        await rename(publicationTemporary, outputAbsolute);
        publicationTemporary = undefined;
        publicationCommitted = true;
      }

      try {
        await link(receiptTemporary, receiptAbsolute);
        await unlink(receiptTemporary).catch(() => undefined);
        receiptTemporary = undefined;
      } catch (error) {
        if (publicationCommitted) {
          const priorRecoveryPath = previousOutputBackup ? projectPath(root, previousOutputBackup) : undefined;
          let observedOutputSha256: string | undefined;
          try {
            observedOutputSha256 = await hashExistingFile(outputAbsolute, this.limits.glbBytes);
          } catch {
            rollback.state = "preserved";
            throw new CreatureOperationError(
              "OUTPUT_CONFLICT",
              "Receipt finalization failed and output ownership could not be verified; inspect the retained recovery artifact before retrying.",
              {
                publishedOutputSha256: outputSha256,
                observedOutputSha256: null,
                recoveryPath: priorRecoveryPath ?? projectPath(root, outputAbsolute),
                rollback: "preserved",
              },
            );
          }
          if (observedOutputSha256 !== outputSha256) {
            rollback.state = "preserved";
            throw new CreatureOperationError(
              "OUTPUT_CONFLICT",
              "Receipt finalization failed after another writer replaced the output; the newer output and prior recovery artifact were preserved.",
              {
                publishedOutputSha256: outputSha256,
                observedOutputSha256: observedOutputSha256 ?? null,
                recoveryPath: priorRecoveryPath ?? projectPath(root, outputAbsolute),
                rollback: "preserved",
              },
            );
          }

          rollbackCapture = join(dirname(outputAbsolute), `.${basename(outputAbsolute)}.${randomUUID()}.rollback-published`);
          const rollbackCaptureAbsolute = rollbackCapture;
          try {
            await rename(outputAbsolute, rollbackCaptureAbsolute);
          } catch {
            rollback.state = "preserved";
            throw new CreatureOperationError(
              "OUTPUT_CONFLICT",
              "Receipt finalization failed and the published output could not be isolated safely; inspect recoveryPath before retrying.",
              {
                publishedOutputSha256: outputSha256,
                observedOutputSha256,
                recoveryPath: priorRecoveryPath ?? projectPath(root, outputAbsolute),
                rollback: "preserved",
              },
            );
          }

          const capturedOutputSha256 = await hashExistingFile(rollbackCaptureAbsolute, this.limits.glbBytes).catch(() => undefined);
          if (capturedOutputSha256 !== outputSha256) {
            try {
              await copyFile(rollbackCaptureAbsolute, outputAbsolute, constants.COPYFILE_EXCL);
              await unlink(rollbackCaptureAbsolute);
              rollbackCapture = undefined;
            } catch {
              // A later writer at outputAbsolute wins. The displaced bytes stay at rollbackCapture.
            }
            rollback.state = "preserved";
            throw new CreatureOperationError(
              "OUTPUT_CONFLICT",
              "Receipt finalization failed while another writer replaced the output; no external bytes were overwritten.",
              {
                publishedOutputSha256: outputSha256,
                observedOutputSha256: capturedOutputSha256 ?? null,
                recoveryPath: priorRecoveryPath ?? projectPath(root, rollbackCapture ?? outputAbsolute),
                ...(rollbackCapture ? { displacedOutputPath: projectPath(root, rollbackCapture) } : {}),
                rollback: "preserved",
              },
            );
          }

          if (previousOutputBackup) {
            try {
              await copyFile(previousOutputBackup, outputAbsolute, constants.COPYFILE_EXCL);
              const restoredOutputSha256 = await hashExistingFile(outputAbsolute, this.limits.glbBytes);
              if (restoredOutputSha256 !== initialOutputSha256) {
                throw new Error("The restored output changed before verification.");
              }
            } catch {
              rollback.state = "preserved";
              throw new CreatureOperationError(
                "OUTPUT_CONFLICT",
                "Receipt finalization failed and the previous output could not be restored without overwriting another writer; recover it from recoveryPath.",
                {
                  publishedOutputSha256: outputSha256,
                  observedOutputSha256: await hashExistingFile(outputAbsolute, this.limits.glbBytes).catch(() => undefined) ?? null,
                  recoveryPath: priorRecoveryPath,
                  publishedRecoveryPath: projectPath(root, rollbackCaptureAbsolute),
                  rollback: "preserved",
                },
              );
            }
          }
          try {
            await unlink(rollbackCaptureAbsolute);
            rollbackCapture = undefined;
          } catch {
            rollback.state = "preserved";
            throw new CreatureOperationError(
              "OUTPUT_CONFLICT",
              previousOutputBackup
                ? "Receipt finalization failed after the previous output was restored, but the published output remains at recoveryPath."
                : "Receipt finalization failed and the newly published output could not be removed; inspect recoveryPath before retrying.",
              {
                publishedOutputSha256: outputSha256,
                observedOutputSha256,
                recoveryPath: projectPath(root, rollbackCaptureAbsolute),
                rollback: "preserved",
              },
            );
          }
          rollback.state = "complete";
        }
        throw error;
      }
      if (previousOutputBackup) {
        await unlink(previousOutputBackup).catch(() => undefined);
        previousOutputBackup = undefined;
      }
      rollback.state = "complete";
      return {
        ...receipt,
        operation: "creature_compile",
        receiptPath: projectPath(root, receiptAbsolute),
      };
    } catch (error) {
      if (signal.aborted && !publicationCommitted && !(error instanceof CreatureOperationError && new Set(["TIMEOUT", "CANCELLED"]).has(error.code))) {
        throw this.abortError(signal);
      }
      if (error instanceof CreatureOperationError) throw error;
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The creature compiler could not complete local file or toolchain setup.");
    } finally {
      await lockHandle?.close().catch(() => undefined);
      if (ownsLock && lockPath) await unlink(lockPath).catch(() => undefined);
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (publicationTemporary) await unlink(publicationTemporary).catch(() => undefined);
      if (previousOutputBackup && rollback.state !== "preserved") {
        await unlink(previousOutputBackup).catch(() => undefined);
      }
      if (rollbackCapture && rollback.state !== "preserved") {
        await unlink(rollbackCapture).catch(() => undefined);
      }
      if (receiptTemporary) await unlink(receiptTemporary).catch(() => undefined);
      this.destinationLocks.delete(outputAbsolute);
    }
  }

  private abortError(signal: AbortSignal, diagnosticsPath?: string, root?: string): CreatureOperationError {
    const reason = signal.reason;
    const timedOut = isRecord(reason) && reason.kind === "timeout";
    return new CreatureOperationError(
      timedOut ? "TIMEOUT" : "CANCELLED",
      timedOut
        ? `Creature compilation exceeded ${this.limits.compileTimeoutMs} ms; simplify the spec or retry when the machine is less loaded.`
        : "Creature compilation was cancelled; the previous output was preserved and the process was terminated.",
      diagnosticsPath && root ? { diagnosticsPath: projectPath(root, diagnosticsPath) } : {},
    );
  }

  private async ensureState(root: string): Promise<StatePaths> {
    const stateRoot = await canonicalMissingPath(join(root, ".threenative", "creatures"));
    if (!isInside(stateRoot, root)) throw new CreatureOperationError("INVALID_SPEC", "The .threenative creature state path escapes the launch root.");
    const paths: StatePaths = {
      root: stateRoot,
      staging: join(stateRoot, ".staging"),
      locks: join(stateRoot, ".locks"),
      sources: join(stateRoot, "sources"),
      diagnostics: join(stateRoot, "diagnostics"),
      checks: join(stateRoot, "checks"),
      receipts: join(stateRoot, "receipts"),
    };
    for (const path of Object.values(paths)) {
      const expected = resolve(path);
      const before = await canonicalMissingPath(expected);
      if (before !== expected || !isInside(before, root)) {
        throw new CreatureOperationError("INVALID_SPEC", "Creature state storage escapes the launch root through a symlink.");
      }
      await mkdir(expected, { recursive: true, mode: 0o700 });
      const info = await lstat(expected);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new CreatureOperationError("INVALID_SPEC", "Creature state storage must contain only private directories.");
      }
      const canonical = await realpath(path);
      if (canonical !== expected || !isInside(canonical, root)) {
        throw new CreatureOperationError("INVALID_SPEC", "Creature state storage escapes the launch root.");
      }
      await chmod(expected, 0o700);
    }
    return paths;
  }

  private async writeImmutable(path: string, bytes: Uint8Array, expectedHash: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (nodeErrorCode(error) !== "EEXIST") throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const stored = await readFile(path);
    if (sha256(stored) !== expectedHash) {
      throw new CreatureOperationError("OUTPUT_CONFLICT", "A retained creature evidence file has conflicting bytes.");
    }
  }

  private async verifiedArchive(signal: AbortSignal): Promise<Map<string, Buffer>> {
    const archive = await readFile(this.payload.archivePath).catch(() => {
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged anyCreature payload is missing; reinstall the asset MCP package.");
    });
    if (sha256(archive) !== this.payload.archiveSha256) {
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged anyCreature payload failed its SHA-256 check; reinstall the package.");
    }
    const reader = new ZipReader(new Uint8ArrayReader(archive), { strictness: "strict" });
    try {
      const entries = await reader.getEntries();
      for (const entry of entries) assertSafeArchiveEntry(entry, this.payload);
      const files = entries.filter(fileEntry);
      const names = files.map((entry) => entry.filename.slice(this.payload.root.length)).sort();
      const expected = [...this.payload.files].sort();
      if (new Set(names).size !== names.length || names.join("\0") !== expected.join("\0")) {
        throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged anyCreature payload inventory is invalid.");
      }
      const extracted = new Map<string, Buffer>();
      let totalBytes = 0;
      for (const entry of files) {
        const data = Buffer.from(await entry.getData(new Uint8ArrayWriter(), { signal, checkOverlappingEntry: true, checkSignature: true }));
        totalBytes += data.length;
        if (totalBytes > 64 * 1_024 * 1_024) {
          throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The packaged anyCreature payload exceeds its extraction budget.");
        }
        extracted.set(entry.filename.slice(this.payload.root.length), data);
      }
      return extracted;
    } finally {
      await reader.close();
    }
  }

  private async ensurePayload(signal: AbortSignal): Promise<string> {
    const files = await this.verifiedArchive(signal);
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const cacheParent = await realpath(this.cacheDir);
    const cacheRoot = join(cacheParent, `anyCreature-${this.payload.version}-${this.payload.archiveSha256.slice(0, 16)}`);
    const boundary = Buffer.from('{"private":true,"type":"commonjs"}\n');
    const marker = Buffer.from(`${JSON.stringify({ archiveSha256: this.payload.archiveSha256, files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]).sort()) }, null, 2)}\n`);
    try {
      await lstat(cacheRoot);
      await this.verifyCache(cacheRoot, files, boundary, marker);
      return cacheRoot;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }

    const temporary = await mkdtemp(join(cacheParent, ".extract-"));
    try {
      for (const [name, bytes] of files) {
        const destination = resolve(temporary, name);
        if (!isInside(destination, temporary)) throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "Payload extraction attempted to escape its private directory.");
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      }
      await writeFile(join(temporary, "package.json"), boundary, { flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, ".payload.json"), marker, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, cacheRoot);
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST" && nodeErrorCode(error) !== "ENOTEMPTY") throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.verifyCache(cacheRoot, files, boundary, marker);
    return cacheRoot;
  }

  private async verifyCache(root: string, files: ReadonlyMap<string, Buffer>, boundary: Buffer, marker: Buffer): Promise<void> {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The creature toolchain cache is not a private directory.");
    }
    const expected = [...files.keys(), "package.json", ".payload.json"].sort();
    const actual = await listTree(root);
    if (actual.join("\0") !== expected.join("\0")) {
      throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The extracted creature toolchain inventory changed; remove its cache directory and retry.");
    }
    const expectedBytes = new Map(files);
    expectedBytes.set("package.json", boundary);
    expectedBytes.set(".payload.json", marker);
    for (const [name, bytes] of expectedBytes) {
      const candidate = join(root, name);
      const candidateInfo = await lstat(candidate);
      if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink() || sha256(await readFile(candidate)) !== sha256(bytes)) {
        throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The extracted creature toolchain failed verification; remove its cache directory and retry.");
      }
    }
  }

  private async runCompiler(cliPath: string, specPath: string, outputPath: string, signal: AbortSignal): Promise<ProcessResult> {
    const child = spawn(process.execPath, [cliPath, specPath, outputPath], {
      cwd: dirname(cliPath),
      env: childEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let overflow = false;
    let spawnError: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      processGroupSignal(child, "SIGTERM");
      forceKill = setTimeout(() => processGroupSignal(child, "SIGKILL"), 750);
      forceKill.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = this.limits.diagnosticsBytes - capturedBytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      capturedBytes += chunk.length;
      if (capturedBytes > this.limits.diagnosticsBytes && !overflow) {
        overflow = true;
        requestTermination();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const onAbort = () => requestTermination();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const closed = await new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolveClose) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode, signalCode) => resolveClose({ exitCode, signalCode }));
    });
    if (forceKill) clearTimeout(forceKill);
    signal.removeEventListener("abort", onAbort);
    return {
      ...closed,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      overflow,
      ...(spawnError ? { spawnError } : {}),
    };
  }

  private parseSummary(stdout: Buffer, stagedOutput: string, diagnosticsPath: string, root: string): z.infer<typeof CompilerSummarySchema> {
    const lines = stdout.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    let candidate: unknown;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        candidate = JSON.parse(lines[index] ?? "") as unknown;
        break;
      } catch {
        // Diagnostic lines before the final JSON summary are expected.
      }
    }
    const parsed = CompilerSummarySchema.safeParse(candidate);
    if (!parsed.success || resolve(parsed.data.out) !== resolve(stagedOutput)) {
      throw new CreatureOperationError("OUTPUT_INVALID", "The compiler did not emit a valid final summary for its staged GLB.", {
        diagnosticsPath: projectPath(root, diagnosticsPath),
      });
    }
    return parsed.data;
  }
}
