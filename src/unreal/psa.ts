import type { Document, Node } from "@gltf-transform/core";

const CHUNK_HEADER_BYTES = 32;
const BONE_BYTES = 120;
const ANIMATION_INFO_BYTES = 168;
const KEY_BYTES = 32;
const MAX_BONES = 16_384;
const MAX_ANIMATIONS = 100_000;
const MAX_KEYS = 100_000_000;

export interface PsaBone {
  readonly name: string;
  readonly parentIndex: number;
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

export interface PsaTrack {
  readonly bone: string;
  readonly times: Float32Array<ArrayBuffer>;
  readonly translations: Float32Array<ArrayBuffer>;
  readonly rotations: Float32Array<ArrayBuffer>;
}

export interface PsaSequence {
  readonly name: string;
  readonly rate: number;
  readonly frames: number;
  readonly tracks: readonly PsaTrack[];
}

export interface PsaFile {
  readonly bones: readonly PsaBone[];
  readonly sequences: readonly PsaSequence[];
  readonly hasScaleKeys: boolean;
}

interface Chunk {
  readonly id: string;
  readonly dataSize: number;
  readonly count: number;
  readonly offset: number;
}

function boundedName(bytes: Buffer, offset: number, length: number, label: string): string {
  const end = bytes.indexOf(0, offset);
  const limit = offset + length;
  const actualEnd = end < offset || end > limit ? limit : end;
  const name = bytes.subarray(offset, actualEnd).toString("utf8").trim();
  if (!name || name.length > length || /[\u0000-\u001f]/u.test(name)) {
    throw new Error(`ActorX PSA ${label} is empty or invalid.`);
  }
  return name;
}

function chunkTable(bytes: Buffer): Map<string, Chunk> {
  if (bytes.length < CHUNK_HEADER_BYTES || bytes.length > 2 ** 32 - 1) {
    throw new Error("ActorX PSA file is empty, truncated, or too large.");
  }
  const chunks = new Map<string, Chunk>();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < CHUNK_HEADER_BYTES) {
      throw new Error(`ActorX PSA has a truncated chunk header at byte ${offset}.`);
    }
    const id = boundedName(bytes, offset, 20, `chunk identifier at byte ${offset}`);
    const dataSize = bytes.readInt32LE(offset + 24);
    const count = bytes.readInt32LE(offset + 28);
    if (dataSize < 0 || count < 0) throw new Error(`ActorX PSA chunk ${id} has negative dimensions.`);
    const payloadBytes = dataSize * count;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > bytes.length - offset - CHUNK_HEADER_BYTES) {
      throw new Error(`ActorX PSA chunk ${id} exceeds the file boundary.`);
    }
    if (chunks.has(id)) throw new Error(`ActorX PSA contains duplicate ${id} chunks.`);
    chunks.set(id, { id, dataSize, count, offset: offset + CHUNK_HEADER_BYTES });
    offset += CHUNK_HEADER_BYTES + payloadBytes;
  }
  return chunks;
}

function position(bytes: Buffer, offset: number): [number, number, number] {
  // UE Viewer uses the same conversion in ExportGLTF.cpp: swap Y/Z and centimetres → metres.
  const value: [number, number, number] = [
    bytes.readFloatLE(offset) * 0.01,
    bytes.readFloatLE(offset + 8) * 0.01,
    bytes.readFloatLE(offset + 4) * 0.01,
  ];
  if (value.some((component) => !Number.isFinite(component))) {
    throw new Error("ActorX PSA contains a non-finite translation.");
  }
  return value;
}

function rotation(bytes: Buffer, offset: number, root: boolean): [number, number, number, number] {
  let value: [number, number, number, number] = [
    bytes.readFloatLE(offset),
    bytes.readFloatLE(offset + 8),
    bytes.readFloatLE(offset + 4),
    bytes.readFloatLE(offset + 12),
  ];
  if (root) value = [-value[0], -value[1], -value[2], value[3]];
  const magnitude = Math.hypot(...value);
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) return [0, 0, 0, 1];
  return value.map((component) => component === 0 ? 0 : component / magnitude) as [
    number,
    number,
    number,
    number,
  ];
}

/** Parses UE Viewer's bounded ActorX PSA output without depending on Unreal Engine. */
export function parsePsa(bytes: Buffer): PsaFile {
  const chunks = chunkTable(bytes);
  const boneChunk = chunks.get("BONENAMES");
  const infoChunk = chunks.get("ANIMINFO");
  const keyChunk = chunks.get("ANIMKEYS");
  if (!boneChunk || !infoChunk || !keyChunk) {
    throw new Error("ActorX PSA is missing BONENAMES, ANIMINFO, or ANIMKEYS.");
  }
  if (boneChunk.dataSize < BONE_BYTES || boneChunk.count === 0 || boneChunk.count > MAX_BONES) {
    throw new Error("ActorX PSA bone table has an unsupported record size or count.");
  }
  if (infoChunk.dataSize < ANIMATION_INFO_BYTES || infoChunk.count > MAX_ANIMATIONS) {
    throw new Error("ActorX PSA animation table has an unsupported record size or count.");
  }
  if (keyChunk.dataSize < KEY_BYTES || keyChunk.count > MAX_KEYS) {
    throw new Error("ActorX PSA key table has an unsupported record size or count.");
  }

  const bones: PsaBone[] = [];
  const boneNames = new Set<string>();
  for (let index = 0; index < boneChunk.count; index += 1) {
    const offset = boneChunk.offset + index * boneChunk.dataSize;
    const parentIndex = bytes.readInt32LE(offset + 72);
    if (parentIndex < -1 || parentIndex >= boneChunk.count) {
      throw new Error(`ActorX PSA bone ${index} has invalid parent ${parentIndex}.`);
    }
    const name = boundedName(bytes, offset, 64, `bone ${index} name`);
    if (boneNames.has(name.toLowerCase())) {
      throw new Error(`ActorX PSA contains duplicate bone name ${name}.`);
    }
    boneNames.add(name.toLowerCase());
    bones.push({
      name,
      parentIndex,
      rotation: rotation(bytes, offset + 76, index === 0),
      translation: position(bytes, offset + 92),
    });
  }

  const sequences: PsaSequence[] = [];
  for (let sequenceIndex = 0; sequenceIndex < infoChunk.count; sequenceIndex += 1) {
    const offset = infoChunk.offset + sequenceIndex * infoChunk.dataSize;
    const name = boundedName(bytes, offset, 64, `animation ${sequenceIndex} name`);
    const totalBones = bytes.readInt32LE(offset + 128);
    const rate = bytes.readFloatLE(offset + 152);
    const firstFrame = bytes.readInt32LE(offset + 160);
    const frames = bytes.readInt32LE(offset + 164);
    if (totalBones !== bones.length || frames <= 0 || firstFrame < 0 || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`ActorX PSA animation ${name} has invalid bones, frames, or rate.`);
    }
    const finalKey = (firstFrame + frames) * totalBones;
    if (!Number.isSafeInteger(finalKey) || finalKey > keyChunk.count) {
      throw new Error(`ActorX PSA animation ${name} references keys outside ANIMKEYS.`);
    }
    const effectiveRate = rate > 0.001 ? rate : 1;
    const tracks: PsaTrack[] = [];
    for (let boneIndex = 0; boneIndex < totalBones; boneIndex += 1) {
      const times = new Float32Array(frames);
      const translations = new Float32Array(frames * 3);
      const rotations = new Float32Array(frames * 4);
      let previous: [number, number, number, number] | undefined;
      for (let frame = 0; frame < frames; frame += 1) {
        const keyIndex = (firstFrame + frame) * totalBones + boneIndex;
        const keyOffset = keyChunk.offset + keyIndex * keyChunk.dataSize;
        times[frame] = frame / effectiveRate;
        translations.set(position(bytes, keyOffset), frame * 3);
        let quaternion = rotation(bytes, keyOffset + 12, boneIndex === 0);
        if (previous && previous.reduce((sum, component, axis) => sum + component * quaternion[axis]!, 0) < 0) {
          quaternion = quaternion.map((component) => component === 0 ? 0 : -component) as [
            number,
            number,
            number,
            number,
          ];
        }
        rotations.set(quaternion, frame * 4);
        previous = quaternion;
      }
      tracks.push({ bone: bones[boneIndex]!.name, times, translations, rotations });
    }
    sequences.push({ name, rate, frames, tracks });
  }

  return { bones, sequences, hasScaleKeys: (chunks.get("SCALEKEYS")?.count ?? 0) > 0 };
}

export interface AttachedPsaResult {
  readonly attached: readonly string[];
  readonly existing: readonly string[];
  readonly incompatible: readonly string[];
}

/** Adds PSA clips to a compatible glTF skin by case-insensitive joint name, ready for AnimationMixer. */
export function attachPsaAnimations(
  document: Document,
  files: readonly PsaFile[],
  minimumBoneCoverage = 0.8,
): AttachedPsaResult {
  const root = document.getRoot();
  const joints = new Map<string, Node>();
  for (const skin of root.listSkins()) {
    for (const joint of skin.listJoints()) joints.set(joint.getName().toLowerCase(), joint);
  }
  const existing = new Set(root.listAnimations().map((animation) => animation.getName().toLowerCase()));
  const buffer = root.listBuffers()[0] ?? document.createBuffer("PSA animations");
  const attached: string[] = [];
  const alreadyPresent: string[] = [];
  const incompatible: string[] = [];

  for (const file of files) {
    for (const sequence of file.sequences) {
      if (existing.has(sequence.name.toLowerCase())) {
        alreadyPresent.push(sequence.name);
        continue;
      }
      const mapped = sequence.tracks.filter((track) => joints.has(track.bone.toLowerCase()));
      const coverage = sequence.tracks.length === 0 ? 0 : mapped.length / sequence.tracks.length;
      if (mapped.length === 0 || coverage < minimumBoneCoverage) {
        incompatible.push(sequence.name);
        continue;
      }
      const animation = document
        .createAnimation(sequence.name)
        .setExtras({ unreal: { sourceFormat: "ActorX PSA", boneCoverage: coverage } });
      for (const track of mapped) {
        const target = joints.get(track.bone.toLowerCase())!;
        const input = document
          .createAccessor(`${sequence.name}/${track.bone}/time`)
          .setType("SCALAR")
          .setArray(track.times)
          .setBuffer(buffer);
        const translation = document
          .createAccessor(`${sequence.name}/${track.bone}/translation`)
          .setType("VEC3")
          .setArray(track.translations)
          .setBuffer(buffer);
        const rotationOutput = document
          .createAccessor(`${sequence.name}/${track.bone}/rotation`)
          .setType("VEC4")
          .setArray(track.rotations)
          .setBuffer(buffer);
        const translationSampler = document
          .createAnimationSampler()
          .setInput(input)
          .setOutput(translation)
          .setInterpolation("LINEAR");
        const rotationSampler = document
          .createAnimationSampler()
          .setInput(input)
          .setOutput(rotationOutput)
          .setInterpolation("LINEAR");
        animation
          .addSampler(translationSampler)
          .addSampler(rotationSampler)
          .addChannel(
            document
              .createAnimationChannel()
              .setSampler(translationSampler)
              .setTargetNode(target)
              .setTargetPath("translation"),
          )
          .addChannel(
            document
              .createAnimationChannel()
              .setSampler(rotationSampler)
              .setTargetNode(target)
              .setTargetPath("rotation"),
          );
      }
      existing.add(sequence.name.toLowerCase());
      attached.push(sequence.name);
    }
  }
  return { attached, existing: alreadyPresent, incompatible };
}
