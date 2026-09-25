import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import { sizeMeters } from "../src/gltf-size.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "threenative-gltf-size-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

/** A box of exactly the given size, centred on the origin: the smallest asset with a known
 * bounding box, so a scale bug in the measurement cannot hide. */
async function writeBoxGlb(path: string, [x, y, z]: readonly [number, number, number]): Promise<void> {
  const corners = [
    [-x / 2, -y / 2, -z / 2], [x / 2, -y / 2, -z / 2], [x / 2, y / 2, -z / 2], [-x / 2, y / 2, -z / 2],
    [-x / 2, -y / 2, z / 2], [x / 2, -y / 2, z / 2], [x / 2, y / 2, z / 2], [-x / 2, y / 2, z / 2],
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]]) {
    indices.push(a!, b!, c!, a!, c!, d!);
  }
  const document = new Document();
  const buffer = document.createBuffer();
  document
    .createScene()
    .addChild(
      document
        .createNode("box")
        .setMesh(
          document
            .createMesh("box")
            .addPrimitive(
              document
                .createPrimitive()
                .setAttribute(
                  "POSITION",
                  document
                    .createAccessor("POSITION")
                    .setType("VEC3")
                    .setArray(new Float32Array(corners.flat()))
                    .setBuffer(buffer),
                )
                .setIndices(
                  document
                    .createAccessor()
                    .setType("SCALAR")
                    .setArray(new Uint16Array(indices))
                    .setBuffer(buffer),
                ),
            ),
        ),
    );
  await new NodeIO().write(path, document);
}

describe("sizeMeters", () => {
  it("reports the bounding-box size of a written GLB in metres", async () => {
    const path = await temporaryPath("box.glb");
    await writeBoxGlb(path, [2, 4, 6]);
    expect(await sizeMeters(path)).toEqual({ x: 2, y: 4, z: 6 });
  });

  it("reports no size for a file that is not a readable glTF", async () => {
    const path = await temporaryPath("broken.glb");
    await writeFile(path, "not a glb");
    expect(await sizeMeters(path)).toBeUndefined();
  });

  it("reports no size for a scene that holds no mesh to measure", async () => {
    const path = await temporaryPath("empty.glb");
    const document = new Document();
    document.createScene("empty");
    await new NodeIO().write(path, document);
    expect(await sizeMeters(path)).toBeUndefined();
  });
});
