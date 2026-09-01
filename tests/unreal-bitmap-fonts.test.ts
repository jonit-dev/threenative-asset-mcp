import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { parseOfflineFontDescriptor, writeOfflineFont } from "../src/unreal/bitmap-fonts.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "asset-mcp-bitmap-font-"));
  temporaryDirectories.push(path);
  return path;
}

function descriptor() {
  return {
    Name: "F_Test",
    PackagePath: "/Game/Fonts/F_Test.F_Test",
    Pages: ["F_Test_page00.png"],
    Characters: [
      { StartU: 0, StartV: 0, USize: 0, VSize: 0, TextureIndex: 0, VerticalOffset: 0 },
      { StartU: 2, StartV: 3, USize: 4, VSize: 5, TextureIndex: 0, VerticalOffset: -1 },
    ],
    CharRemap: { "65": 1 },
    IsRemapped: true,
    Kerning: 1,
    EmScale: 64,
    Ascent: 704,
    Descent: 128,
    Leading: 64,
    ScalingFactor: 1,
    IsDistanceField: true,
    DistanceFieldScaleFactor: 2,
  };
}

describe("offline Unreal fonts", () => {
  it("maps remapped codepoints and writes BMFont-compatible normalized metrics", async () => {
    const directory = await temporaryDirectory();
    const descriptorPath = join(directory, "F_Test.font.json");
    await sharp({ create: { width: 16, height: 16, channels: 4, background: "black" } }).png().toFile(join(directory, "F_Test_page00.png"));
    const parsed = parseOfflineFontDescriptor(descriptor());
    const result = await writeOfflineFont({ descriptor: parsed, descriptorPath, outputDirectory: join(directory, "output") });
    const manifest = JSON.parse(await readFile(join(directory, "output", result.manifest), "utf8"));

    expect(parsed.glyphs).toEqual([{ codepoint: 65, x: 2, y: 3, width: 4, height: 5, page: 0, verticalOffset: -1 }]);
    expect(manifest).toMatchObject({
      format: "three-native-bmfont-1",
      common: { lineHeight: 14, base: 11, scaleW: 16, scaleH: 16, pages: 1 },
      pages: ["page-00.png"],
      chars: [{ id: 65, xadvance: 5, page: 0, chnl: 4 }],
      unreal: { distanceField: true, distanceFieldScaleFactor: 2 },
    });
    expect(result).toMatchObject({ glyphs: 1, pages: ["page-00.png"] });
  });

  it("rejects traversal, invalid remaps, and glyphs outside the atlas", async () => {
    expect(() => parseOfflineFontDescriptor({ ...descriptor(), Pages: ["../secret.png"] })).toThrow(/invalid/);
    expect(() => parseOfflineFontDescriptor({ ...descriptor(), CharRemap: { "65": 99 } })).toThrow(/remap/);
    const directory = await temporaryDirectory();
    await sharp({ create: { width: 4, height: 4, channels: 4, background: "black" } }).png().toFile(join(directory, "F_Test_page00.png"));
    await expect(writeOfflineFont({
      descriptor: parseOfflineFontDescriptor(descriptor()),
      descriptorPath: join(directory, "F_Test.font.json"),
      outputDirectory: join(directory, "output"),
    })).rejects.toThrow(/exceeds atlas page/);
  });
});
