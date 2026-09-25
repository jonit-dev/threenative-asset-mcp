import { extname } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/functions";

/** Bounding-box size of a written glTF asset, in the file's own units. */
export interface SizeMeters {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Measures a written `.glb`/`.gltf` file, and reports nothing for any other format. glTF units
 * are metres by specification, so this returns the file's numbers unchanged: a rock that measures
 * 890 units was authored in centimetres, and only the game knows whether to scale it. Guessing a
 * conversion here would hide that.
 *
 * Returns undefined rather than throwing — a download that arrived is still a download, and a
 * missing measurement is honest where a wrong one is not.
 */
export async function sizeMeters(path: string): Promise<SizeMeters | undefined> {
  const extension = extname(path).toLowerCase();
  if (extension !== ".glb" && extension !== ".gltf") return undefined;
  try {
    const root = (await new NodeIO().read(path)).getRoot();
    const scene = root.getDefaultScene() ?? root.listScenes()[0];
    if (!scene) return undefined;
    const { min, max } = getBounds(scene);
    return { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
  } catch {
    return undefined;
  }
}
