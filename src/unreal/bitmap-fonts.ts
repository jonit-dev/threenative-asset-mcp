import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface OfflineFontGlyph {
  readonly codepoint: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly page: number;
  readonly verticalOffset: number;
}

export interface OfflineFontDescriptor {
  readonly name: string;
  readonly packagePath: string;
  readonly pages: readonly string[];
  readonly glyphs: readonly OfflineFontGlyph[];
  readonly kerning: number;
  readonly emScale: number;
  readonly ascent: number;
  readonly descent: number;
  readonly leading: number;
  readonly scalingFactor: number;
  readonly isDistanceField: boolean;
  readonly distanceFieldScaleFactor: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum = -1e9, maximum = 1e9): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

export function parseOfflineFontDescriptor(value: unknown): OfflineFontDescriptor {
  const source = object(value, "offline font descriptor");
  if (typeof source.Name !== "string" || !source.Name || source.Name.length > 512 ||
      typeof source.PackagePath !== "string" || !source.PackagePath || source.PackagePath.length > 4096 ||
      !Array.isArray(source.Pages) || source.Pages.length < 1 || source.Pages.length > 256 ||
      source.Pages.some((page) => typeof page !== "string" || !/^[-A-Za-z0-9_.]+\.png$/i.test(page)) ||
      !Array.isArray(source.Characters) || source.Characters.length < 1 || source.Characters.length > 1_000_000) {
    throw new Error("offline font descriptor fields are invalid");
  }
  const pages = source.Pages as string[];
  const characters = source.Characters.map((raw, index) => {
    const character = object(raw, `offline font character ${index}`);
    const page = finite(character.TextureIndex, `character ${index} page`, 0, pages.length - 1);
    const values = {
      x: finite(character.StartU, `character ${index} x`, 0),
      y: finite(character.StartV, `character ${index} y`, 0),
      width: finite(character.USize, `character ${index} width`, 0),
      height: finite(character.VSize, `character ${index} height`, 0),
      page,
      verticalOffset: finite(character.VerticalOffset, `character ${index} vertical offset`),
    };
    if (![values.x, values.y, values.width, values.height, values.page, values.verticalOffset].every(Number.isSafeInteger)) {
      throw new Error(`offline font character ${index} must contain integers`);
    }
    return values;
  });
  const isRemapped = source.IsRemapped === true;
  const remap = object(source.CharRemap ?? {}, "offline font character remap");
  const codepointToIndex = isRemapped
    ? Object.entries(remap).map(([codepoint, index]) => [Number(codepoint), index] as const)
    : characters.map((_, index) => [index, index] as const);
  const glyphs: OfflineFontGlyph[] = [];
  for (const [codepoint, rawIndex] of codepointToIndex) {
    if (!Number.isSafeInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff ||
        typeof rawIndex !== "number" || !Number.isSafeInteger(rawIndex) || rawIndex < 0 || rawIndex >= characters.length) {
      throw new Error("offline font character remap is invalid");
    }
    const character = characters[rawIndex]!;
    if (character.width === 0 || character.height === 0) continue;
    glyphs.push({ codepoint, ...character });
  }
  if (glyphs.length === 0) throw new Error("offline font has no drawable glyphs");
  return {
    name: source.Name,
    packagePath: source.PackagePath,
    pages,
    glyphs: glyphs.sort((a, b) => a.codepoint - b.codepoint),
    kerning: finite(source.Kerning, "offline font kerning"),
    emScale: finite(source.EmScale, "offline font em scale"),
    ascent: finite(source.Ascent, "offline font ascent"),
    descent: finite(source.Descent, "offline font descent"),
    leading: finite(source.Leading, "offline font leading"),
    scalingFactor: finite(source.ScalingFactor, "offline font scaling factor", 0.000001),
    isDistanceField: source.IsDistanceField === true,
    distanceFieldScaleFactor: finite(source.DistanceFieldScaleFactor, "offline font distance-field scale", 1, 10_000),
  };
}

/** Writes BMFont-compatible JSON plus collision-safe atlas pages for Three.js bitmap/SDF text. */
export async function writeOfflineFont(options: {
  readonly descriptor: OfflineFontDescriptor;
  readonly descriptorPath: string;
  readonly outputDirectory: string;
}): Promise<{ manifest: string; pages: string[]; glyphs: number; bytes: number }> {
  const { default: sharp } = await import("sharp");
  await mkdir(options.outputDirectory, { recursive: true });
  const pages: string[] = [];
  const dimensions: { width: number; height: number }[] = [];
  const pageSources: string[] = [];
  for (const [index, name] of options.descriptor.pages.entries()) {
    const source = join(dirname(options.descriptorPath), name);
    const metadata = await sharp(await readFile(source), { limitInputPixels: 268_435_456, unlimited: true }).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`offline font page ${index} has no dimensions`);
    const targetName = `page-${String(index).padStart(2, "0")}.png`;
    pageSources.push(source);
    pages.push(targetName);
    dimensions.push({ width: metadata.width, height: metadata.height });
  }
  for (const glyph of options.descriptor.glyphs) {
    const page = dimensions[glyph.page]!;
    if (glyph.x + glyph.width > page.width || glyph.y + glyph.height > page.height) {
      throw new Error(`offline font glyph U+${glyph.codepoint.toString(16).toUpperCase()} exceeds atlas page ${glyph.page}`);
    }
  }
  await Promise.all(pages.map((page, index) => copyFile(pageSources[index]!, join(options.outputDirectory, page))));
  const metricScale = options.descriptor.emScale > 0 ? options.descriptor.emScale : 1;
  const normalizedAscent = options.descriptor.ascent / metricScale;
  const normalizedDescent = Math.abs(options.descriptor.descent / metricScale);
  const normalizedLeading = Math.max(0, options.descriptor.leading / metricScale);
  const lineHeight = Math.max(
    Math.max(...options.descriptor.glyphs.map((glyph) => glyph.height)),
    normalizedAscent + normalizedDescent,
  ) + normalizedLeading;
  const manifestName = "font.json";
  const manifestPath = join(options.outputDirectory, manifestName);
  const first = dimensions[0]!;
  const body = {
    format: "three-native-bmfont-1",
    info: { face: options.descriptor.name, size: lineHeight },
    common: { lineHeight, base: normalizedAscent, scaleW: first.width, scaleH: first.height, pages: pages.length, packed: 0 },
    pages,
    chars: options.descriptor.glyphs.map((glyph) => ({
      id: glyph.codepoint, x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height,
      xoffset: 0, yoffset: glyph.verticalOffset, xadvance: glyph.width + options.descriptor.kerning,
      page: glyph.page, chnl: 4,
    })),
    kernings: [],
    unreal: {
      packagePath: options.descriptor.packagePath,
      emScale: options.descriptor.emScale,
      ascent: options.descriptor.ascent,
      descent: options.descriptor.descent,
      leading: options.descriptor.leading,
      kerning: options.descriptor.kerning,
      scalingFactor: options.descriptor.scalingFactor,
      distanceField: options.descriptor.isDistanceField,
      distanceFieldScaleFactor: options.descriptor.distanceFieldScaleFactor,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(body, null, 2)}\n`);
  const bytes = (await stat(manifestPath)).size + (await Promise.all(pages.map((page) => stat(join(options.outputDirectory, page))))).reduce((sum, info) => sum + info.size, 0);
  return { manifest: manifestName, pages, glyphs: options.descriptor.glyphs.length, bytes };
}
