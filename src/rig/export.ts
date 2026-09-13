import { type Accessor, Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

export interface ExportOptions {
  keepExistingClips: boolean;
  addedClipNames: readonly string[];
}

export interface ExportReport {
  bytes: number;
  animationBytes: number;
  meshTextureBytes: number;
  animationCount: number;
  accessorCount: number;
}

function accessorBytes(accessor: Accessor): number {
  const array = accessor.getArray();
  return array ? array.byteLength : 0;
}

/**
 * Drop accessors no remaining animation, skin or mesh references, then report
 * animation versus mesh/texture byte accounting. Existing target clips survive
 * unless the caller asked for a game-minimal export.
 */
export function pruneAndAccount(
  document: Document,
  options: ExportOptions,
): ExportReport {
  const root = document.getRoot();
  if (!options.keepExistingClips) {
    for (const animation of root.listAnimations()) {
      if (!options.addedClipNames.includes(animation.getName())) animation.dispose();
    }
  }

  const referenced = new Set<Accessor>();
  for (const animation of root.listAnimations()) {
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (input) referenced.add(input);
      const output = sampler.getOutput();
      if (output) referenced.add(output);
    }
  }
  for (const skin of root.listSkins()) {
    const inverseBind = skin.getInverseBindMatrices();
    if (inverseBind) referenced.add(inverseBind);
  }
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const accessor of primitive.listAttributes()) {
        referenced.add(accessor);
      }
      const indices = primitive.getIndices();
      if (indices) referenced.add(indices);
    }
  }

  let animationBytes = 0;
  const animationAccessors = new Set<Accessor>();
  for (const animation of root.listAnimations()) {
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (input) animationAccessors.add(input);
      const output = sampler.getOutput();
      if (output) animationAccessors.add(output);
    }
  }
  for (const accessor of animationAccessors) animationBytes += accessorBytes(accessor);

  let meshTextureBytes = 0;
  for (const accessor of referenced) {
    if (!animationAccessors.has(accessor)) meshTextureBytes += accessorBytes(accessor);
  }
  for (const texture of root.listTextures()) {
    meshTextureBytes += texture.getImage()?.byteLength ?? 0;
  }

  let accessorCount = 0;
  for (const accessor of root.listAccessors()) {
    if (!referenced.has(accessor)) {
      accessor.dispose();
    } else {
      accessorCount += 1;
    }
  }

  return {
    bytes: 0,
    animationBytes,
    meshTextureBytes,
    animationCount: root.listAnimations().length,
    accessorCount,
  };
}

export async function finalizeDocument(
  document: Document,
  options: ExportOptions,
): Promise<{ bytes: Uint8Array; report: ExportReport }> {
  const report = pruneAndAccount(document, options);
  const bytes = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document);
  return { bytes, report: { ...report, bytes: bytes.byteLength } };
}
