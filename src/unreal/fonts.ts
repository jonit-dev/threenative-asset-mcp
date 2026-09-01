import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const UNREAL_COMPRESSED_MAGIC = Buffer.from([0xc1, 0x83, 0x2a, 0x9e]);
const MAX_FONT_BYTES = 256 * 1024 * 1024;
const REQUIRED_TABLES = ["cmap", "head", "hhea", "maxp", "name"];

export interface ExtractedUnrealFont {
  readonly data: Buffer;
  readonly extension: "ttf" | "otf";
  readonly mimeType: "font/ttf" | "font/otf";
  readonly family: string;
  readonly style: string;
  readonly postscriptName: string | undefined;
  readonly sha256: string;
}

function safeInteger(value: bigint): number | undefined {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

/** Decodes the legacy FCompressedChunk layout used by cooked FontBulkData. */
export function decodeUnrealCompressedChunk(bytes: Buffer, offset: number): Buffer | undefined {
  if (offset < 0 || offset > bytes.length - 36 || !bytes.subarray(offset, offset + 4).equals(UNREAL_COMPRESSED_MAGIC) ||
      bytes.readUInt32LE(offset + 4) !== 0) return undefined;
  const blockSize = safeInteger(bytes.readBigUInt64LE(offset + 8));
  const totalCompressed = safeInteger(bytes.readBigUInt64LE(offset + 16));
  const totalRaw = safeInteger(bytes.readBigUInt64LE(offset + 24));
  if (!blockSize || blockSize > 16 * 1024 * 1024 || !totalCompressed || !totalRaw || totalRaw > MAX_FONT_BYTES) return undefined;
  const blockCount = Math.ceil(totalRaw / blockSize);
  if (blockCount < 1 || blockCount > 4096) return undefined;
  const summariesEnd = offset + 32 + blockCount * 16;
  if (summariesEnd > bytes.length) return undefined;
  const summaries: { compressed: number; raw: number }[] = [];
  let compressedSum = 0;
  let rawSum = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const at = offset + 32 + index * 16;
    const compressed = safeInteger(bytes.readBigUInt64LE(at));
    const raw = safeInteger(bytes.readBigUInt64LE(at + 8));
    if (!compressed || !raw || raw > blockSize || compressed > bytes.length) return undefined;
    compressedSum += compressed;
    rawSum += raw;
    summaries.push({ compressed, raw });
  }
  if (compressedSum !== totalCompressed || rawSum !== totalRaw || summariesEnd + compressedSum > bytes.length) return undefined;
  const blocks: Buffer[] = [];
  let cursor = summariesEnd;
  try {
    for (const summary of summaries) {
      const decoded = inflateSync(bytes.subarray(cursor, cursor + summary.compressed), { maxOutputLength: summary.raw });
      if (decoded.length !== summary.raw) return undefined;
      blocks.push(decoded);
      cursor += summary.compressed;
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(blocks, totalRaw);
}

function decodeName(bytes: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    if (bytes.length % 2 !== 0) return "";
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes).replaceAll("\0", "").trim();
  }
  return bytes.toString("latin1").replaceAll("\0", "").trim();
}

function fontNames(font: Buffer, nameOffset: number, nameLength: number): {
  family: string;
  style: string;
  postscriptName: string | undefined;
} {
  if (nameLength < 6 || nameOffset > font.length - nameLength) return { family: "UnrealFont", style: "Regular", postscriptName: undefined };
  const count = font.readUInt16BE(nameOffset + 2);
  const stringsAt = nameOffset + font.readUInt16BE(nameOffset + 4);
  if (count > 4096 || nameOffset + 6 + count * 12 > nameOffset + nameLength) {
    return { family: "UnrealFont", style: "Regular", postscriptName: undefined };
  }
  const values = new Map<number, { value: string; score: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = nameOffset + 6 + index * 12;
    const platform = font.readUInt16BE(at);
    const language = font.readUInt16BE(at + 4);
    const id = font.readUInt16BE(at + 6);
    if (![1, 2, 6].includes(id)) continue;
    const length = font.readUInt16BE(at + 8);
    const offset = font.readUInt16BE(at + 10);
    if (stringsAt + offset > font.length - length) continue;
    let value = "";
    try { value = decodeName(font.subarray(stringsAt + offset, stringsAt + offset + length), platform); } catch { continue; }
    if (!value || /[\u0000-\u001f]/.test(value)) continue;
    const score = (language === 0x0409 ? 4 : 0) + (platform === 3 ? 2 : platform === 0 ? 1 : 0);
    if ((values.get(id)?.score ?? -1) < score) values.set(id, { value, score });
  }
  return {
    family: values.get(1)?.value ?? "UnrealFont",
    style: values.get(2)?.value ?? "Regular",
    postscriptName: values.get(6)?.value,
  };
}

export function inspectSfnt(bytes: Buffer, offset = 0): ExtractedUnrealFont | undefined {
  if (offset < 0 || offset > bytes.length - 12) return undefined;
  const signature = bytes.readUInt32BE(offset);
  const extension = signature === 0x4f54544f ? "otf" : [0x00010000, 0x74727565, 0x74797031].includes(signature) ? "ttf" : undefined;
  if (!extension) return undefined;
  const count = bytes.readUInt16BE(offset + 4);
  if (count < 5 || count > 512 || offset + 12 + count * 16 > bytes.length) return undefined;
  const tables = new Map<string, { offset: number; length: number }>();
  let length = 12 + count * 16;
  for (let index = 0; index < count; index += 1) {
    const at = offset + 12 + index * 16;
    const tag = bytes.toString("ascii", at, at + 4);
    const tableOffset = bytes.readUInt32BE(at + 8);
    const tableLength = bytes.readUInt32BE(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tableOffset > MAX_FONT_BYTES || tableLength > MAX_FONT_BYTES ||
        tableOffset + tableLength > bytes.length - offset) return undefined;
    tables.set(tag, { offset: tableOffset, length: tableLength });
    length = Math.max(length, tableOffset + tableLength);
  }
  if (length > MAX_FONT_BYTES || REQUIRED_TABLES.some((tag) => !tables.has(tag)) ||
      (extension === "otf" ? !tables.has("CFF ") && !tables.has("CFF2") : !tables.has("glyf"))) return undefined;
  const data = Buffer.from(bytes.subarray(offset, offset + length));
  const name = tables.get("name")!;
  const names = fontNames(data, name.offset, name.length);
  return {
    data,
    extension,
    mimeType: extension === "otf" ? "font/otf" : "font/ttf",
    ...names,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function scanSfnt(bytes: Buffer): ExtractedUnrealFont[] {
  const fonts: ExtractedUnrealFont[] = [];
  for (let offset = 0; offset <= bytes.length - 12; offset += 1) {
    const font = inspectSfnt(bytes, offset);
    if (!font) continue;
    fonts.push(font);
    offset += font.data.length - 1;
  }
  return fonts;
}

/** Finds direct and legacy zlib-blocked FontBulkData without trusting arbitrary package offsets. */
export function extractUnrealFonts(payloads: readonly Buffer[]): ExtractedUnrealFont[] {
  const found: ExtractedUnrealFont[] = [];
  for (const payload of payloads) {
    found.push(...scanSfnt(payload));
    for (let offset = 0; offset <= payload.length - UNREAL_COMPRESSED_MAGIC.length; offset += 1) {
      if (!payload.subarray(offset, offset + 4).equals(UNREAL_COMPRESSED_MAGIC)) continue;
      const decoded = decodeUnrealCompressedChunk(payload, offset);
      if (decoded) found.push(...scanSfnt(decoded));
    }
  }
  return [...new Map(found.map((font) => [font.sha256, font])).values()];
}
