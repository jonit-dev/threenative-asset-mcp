import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodeUnrealCompressedChunk, extractUnrealFonts, inspectSfnt } from "../src/unreal/fonts.js";

function compressedChunk(data: Buffer, blockSize = 32 * 1024): Buffer {
  const rawBlocks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += blockSize) rawBlocks.push(data.subarray(offset, offset + blockSize));
  const blocks = rawBlocks.map((block) => deflateSync(block));
  const header = Buffer.alloc(32 + blocks.length * 16);
  header.set([0xc1, 0x83, 0x2a, 0x9e], 0);
  header.writeBigUInt64LE(BigInt(blockSize), 8);
  header.writeBigUInt64LE(BigInt(blocks.reduce((sum, block) => sum + block.length, 0)), 16);
  header.writeBigUInt64LE(BigInt(data.length), 24);
  for (let index = 0; index < blocks.length; index += 1) {
    header.writeBigUInt64LE(BigInt(blocks[index]!.length), 32 + index * 16);
    header.writeBigUInt64LE(BigInt(rawBlocks[index]!.length), 40 + index * 16);
  }
  return Buffer.concat([header, ...blocks]);
}

describe("Unreal embedded fonts", () => {
  it("reconstructs a multi-block Unreal FontBulkData payload and validates its SFNT tables", async () => {
    const source = await readFile(join(process.cwd(), "node_modules/playwright-core/lib/vite/recorder/assets/codicon-DCmgc-ay.ttf"));
    const wrapped = Buffer.concat([Buffer.from("package-prefix"), compressedChunk(source), Buffer.from("package-footer")]);
    const fonts = extractUnrealFonts([wrapped]);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ family: "codicon", style: "Regular", extension: "ttf", mimeType: "font/ttf" });
    expect(fonts[0]!.data).toEqual(source);
    expect(inspectSfnt(fonts[0]!.data)?.sha256).toBe(fonts[0]!.sha256);
  });

  it("rejects truncated, oversized, and corrupt compressed chunks without inflating them", () => {
    const corrupt = Buffer.alloc(64);
    corrupt.set([0xc1, 0x83, 0x2a, 0x9e], 0);
    corrupt.writeBigUInt64LE(131_072n, 8);
    corrupt.writeBigUInt64LE(8n, 16);
    corrupt.writeBigUInt64LE(BigInt(300 * 1024 * 1024), 24);
    expect(decodeUnrealCompressedChunk(corrupt, 0)).toBeUndefined();
    expect(extractUnrealFonts([Buffer.from("\0\x01\0\0not-a-font", "binary")])).toEqual([]);
  });
});
