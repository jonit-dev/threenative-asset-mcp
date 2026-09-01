import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  paperObjectPathToPackage,
  parsePaperFlipbookDescriptor,
  parsePaperSpriteDescriptor,
  writePaperSpriteGlb,
} from "../src/unreal/paper2d.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "asset-mcp-paper2d-"));
  temporaryDirectories.push(path);
  return path;
}

function spriteDescriptor() {
  return {
    Name: "S_Frame",
    PackagePath: "Sample/Content/Sprites/S_Frame.S_Frame",
    Texture: "T_Atlas.png",
    TextureName: "T_Atlas",
    SourceUV: [2, 1],
    SourceDimension: [2, 2],
    PixelsPerUnrealUnit: 0.5,
    Vertices: [
      [0, 0, 0.5, 0.25],
      [2, 0, 1, 0.25],
      [2, 2, 1, 0.75],
      [0, 0, 0.5, 0.25],
      [2, 2, 1, 0.75],
      [0, 2, 0.5, 0.75],
    ],
  };
}

describe("Paper2D promotion", () => {
  it("crops the atlas and writes a self-contained unlit sprite GLB with local UVs", async () => {
    const directory = await temporaryDirectory();
    const texture = join(directory, "T_Atlas.png");
    const output = join(directory, "S_Frame.glb");
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
      const offset = (y * 4 + x) * 4;
      pixels.set(x >= 2 && y >= 1 && y < 3 ? [11, 22, 33, 255] : [220, 10, 10, 255], offset);
    }
    await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toFile(texture);

    const result = await writePaperSpriteGlb({
      descriptor: parsePaperSpriteDescriptor(spriteDescriptor()),
      texturePath: texture,
      outputPath: output,
      maxTextureSize: undefined,
    });
    const document = await new NodeIO().registerExtensions([KHRMaterialsUnlit]).read(output);
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const uv = [...primitive.getAttribute("TEXCOORD_0")!.getArray()!];
    const image = document.getRoot().listTextures()[0]!.getImage()!;
    const decoded = await sharp(image).raw().toBuffer({ resolveWithObject: true });

    expect(result).toMatchObject({ vertices: 6, widthMetres: 0.02, heightMetres: 0.02, textureWidth: 2, textureHeight: 2 });
    expect(uv).toEqual([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    expect(document.getRoot().listMaterials()[0]!.getExtension("KHR_materials_unlit")).not.toBeNull();
    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect([...decoded.data]).toEqual([11, 22, 33, 255, 11, 22, 33, 255, 11, 22, 33, 255, 11, 22, 33, 255]);
    expect((await readFile(output)).subarray(0, 4).toString("ascii")).toBe("glTF");
  });

  it("preserves flipbook frame runs and rejects unsafe timing", () => {
    expect(parsePaperFlipbookDescriptor({
      Name: "F_Run",
      PackagePath: "/Game/Sprites/F_Run.F_Run",
      FramesPerSecond: 7.5,
      Frames: [
        { Sprite: "S_0", SpritePath: "/Game/Sprites/S_0.S_0", FrameRun: 1 },
        { Sprite: "S_1", SpritePath: "/Game/Sprites/S_1.S_1", FrameRun: 3 },
      ],
    })).toMatchObject({ framesPerSecond: 7.5, frames: [{ frameRun: 1 }, { frameRun: 3 }] });
    expect(() => parsePaperFlipbookDescriptor({ Name: "F", PackagePath: "/Game/F.F", FramesPerSecond: 0, Frames: [] })).toThrow(/invalid/);
  });

  it("maps Unreal object references without allowing path traversal", () => {
    expect(paperObjectPathToPackage("Sample/Content/Sprites/S_Frame.S_Frame", "fallback")).toBe("Content/Sprites/S_Frame.uasset");
    expect(paperObjectPathToPackage("/Game/Sprites/S_Frame.S_Frame", "fallback")).toBe("Content/Sprites/S_Frame.uasset");
    expect(paperObjectPathToPackage("/Game/../Secret.Asset", "fallback")).toBe("Content/Paper2D/fallback.uasset");
  });

  it("rejects malformed vertices and atlas regions instead of emitting partial GLBs", async () => {
    expect(() => parsePaperSpriteDescriptor({ ...spriteDescriptor(), Vertices: [[0, 0, Number.NaN, 0]] })).toThrow(/invalid/);
    const directory = await temporaryDirectory();
    const texture = join(directory, "T_Atlas.png");
    const output = join(directory, "S_Frame.glb");
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "white" } }).png().toFile(texture);
    await expect(writePaperSpriteGlb({
      descriptor: parsePaperSpriteDescriptor(spriteDescriptor()),
      texturePath: texture,
      outputPath: output,
      maxTextureSize: undefined,
    })).rejects.toThrow(/exceeds 2x2/);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
