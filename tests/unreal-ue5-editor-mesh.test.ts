import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";

// Real-pack regression for uncooked UE5 static meshes and editor texture colour. It needs Fab's
// Common Hazel (UE5.1 artifact) downloaded by fab_import_asset and the modern converter provisioned
// at the current version, so it skips anywhere those are absent (CI included).
const HAZEL = join(
  homedir(),
  ".cache/threenative-asset-mcp/fab-downloads/81bc7ba6-4686-4f94-9d2b-83eb1fdc4079/MS_Hazel_UE51",
);
const CONVERTER = join(homedir(), ".cache/threenative-asset-mcp/toolchain/modern/bin/ThreeNativeConverter");

function converterReady(): boolean {
  try {
    return execFileSync(CONVERTER, ["--version"], { encoding: "utf8" }).includes(CUE4PARSE_SOURCE.version);
  } catch {
    return false;
  }
}

const ready = existsSync(HAZEL) && converterReady();
const outputs: string[] = [];
afterAll(async () => {
  await Promise.all(outputs.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function baseColourMean(glb: string, material: string): Promise<number[]> {
  const document = await new NodeIO().read(glb);
  const image = document
    .getRoot()
    .listMaterials()
    .find((candidate) => candidate.getName() === material)
    ?.getBaseColorTexture()
    ?.getImage();
  if (!image) throw new Error(`${material} has no base colour texture`);
  const { channels } = await sharp(image).stats();
  return channels.slice(0, 3).map((channel) => channel.mean / 255);
}

describe.skipIf(!ready)("uncooked UE5 Megascans (local Common Hazel download)", () => {
  it(
    "decodes a StaticMesh's source model and keeps editor texture colour",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "asset-mcp-ue5-editor-"));
      outputs.push(outputDir);
      const report = await importUnrealDirectory({
        sourceDir: HAZEL,
        outputDir,
        onlyPackages: ["SM_CommonHazel_Sapling_01"],
        modernConverter: { name: "modern", path: CONVERTER, version: CUE4PARSE_SOURCE.version },
        maxTextureSize: 512,
      });
      const model = report.models.find((candidate) => candidate.name === "SM_CommonHazel_Sapling_01");
      if (!model) throw new Error(`no model; failed: ${JSON.stringify(report.failed.slice(0, 3))}`);

      // LOD0 of the source model, as the reference parser reads it byte-exact.
      const document = await new NodeIO().read(join(outputDir, model.glb));
      const triangles = document
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
        .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
      expect(triangles).toBe(15_351);
      expect(model.boundsMetres[1]).toBeCloseTo(2.298, 2);
      expect(model.materials.every((section) => section.textured)).toBe(true);

      const glb = join(outputDir, model.glb);
      // TSF_BGRA8 bark: brown (red over blue) once the source PNG's swapped channels are restored.
      const [barkRed, , barkBlue] = await baseColourMean(glb, "MI_EuropeanHazel_Tileable");
      expect(barkRed).toBeGreaterThan(barkBlue! + 0.05);
      // TSF_RGBA16 leaves are linear light: green reads ~0.06 raw and ~0.26 encoded to sRGB.
      const [, leafGreen] = await baseColourMean(glb, "MI_EuropeanHazel_TwoSided");
      expect(leafGreen).toBeGreaterThan(0.2);
    },
    900_000,
  );
});
