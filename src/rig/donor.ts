import { type Accessor, NodeIO } from "@gltf-transform/core";

export interface DonorGlb {
  bytes: Uint8Array;
  animationName: string;
  joints: number;
  channels: number;
  samplers: number;
}

/**
 * Build one small, rig-bearing, mesh-free donor GLB from a full source library.
 *
 * The donor keeps the joint hierarchy, original names, skin and inverse-bind
 * matrices plus exactly the selected animation. Meshes, materials, textures,
 * cameras and every accessor outside the selected animation and bind data are
 * removed so a donor cannot pass review on pruned skeleton metadata.
 */
export async function buildDonorGlb(
  sourceBytes: Uint8Array,
  animationIndex: number,
  io: NodeIO,
): Promise<DonorGlb> {
  const target = await io.readBinary(sourceBytes);
  const root = target.getRoot();

  const animations = root.listAnimations();
  const selected = animations[animationIndex];
  if (!selected) {
    throw new Error(`The source has no animation at index ${animationIndex}.`);
  }
  for (const animation of animations) {
    if (animation !== selected) animation.dispose();
  }

  for (const node of root.listNodes()) node.setMesh(null);
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
  for (const camera of root.listCameras()) camera.dispose();

  const retained = new Set<Accessor>();
  for (const sampler of selected.listSamplers()) {
    const input = sampler.getInput();
    if (input) retained.add(input);
    const output = sampler.getOutput();
    if (output) retained.add(output);
  }
  for (const skin of root.listSkins()) {
    const inverseBindMatrices = skin.getInverseBindMatrices();
    if (inverseBindMatrices) retained.add(inverseBindMatrices);
  }
  for (const accessor of root.listAccessors()) {
    if (!retained.has(accessor)) accessor.dispose();
  }

  const bytes = await io.writeBinary(target);
  return {
    bytes,
    animationName: selected.getName() || `animation-${animationIndex}`,
    joints: root.listSkins().reduce((sum, skin) => sum + skin.listJoints().length, 0),
    channels: selected.listChannels().length,
    samplers: selected.listSamplers().length,
  };
}

/** A fresh writer is cheap; the shared reader Document is never mutated. */
export function newGltfIo(): NodeIO {
  return new NodeIO();
}
