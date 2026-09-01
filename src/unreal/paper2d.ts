import { readFile, stat } from "node:fs/promises";

import { Document, NodeIO, VertexLayout } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";

export interface PaperSpriteDescriptor {
  readonly name: string;
  readonly packagePath: string;
  readonly texture: string;
  readonly textureName: string;
  readonly sourceUV: readonly [number, number];
  readonly sourceDimension: readonly [number, number];
  readonly pixelsPerUnrealUnit: number;
  /** Unreal stores triangle vertices as position X/Y followed by normalized atlas U/V. */
  readonly vertices: readonly (readonly [number, number, number, number])[];
}

export interface PaperFlipbookDescriptor {
  readonly name: string;
  readonly packagePath: string;
  readonly framesPerSecond: number;
  readonly frames: readonly { readonly sprite: string; readonly spritePath: string; readonly frameRun: number }[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function tuple(value: unknown, label: string, positive = false): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((entry) =>
    typeof entry !== "number" || !Number.isFinite(entry) || (positive && entry <= 0))) throw new Error(`${label} is invalid`);
  return [value[0] as number, value[1] as number];
}

export function parsePaperSpriteDescriptor(value: unknown): PaperSpriteDescriptor {
  const source = record(value, "sprite descriptor");
  const name = source.Name;
  const packagePath = source.PackagePath;
  const texture = source.Texture;
  const textureName = source.TextureName;
  const pixelsPerUnrealUnit = source.PixelsPerUnrealUnit;
  const rawVertices = source.Vertices;
  if (typeof name !== "string" || !name || name.length > 512 || typeof packagePath !== "string" || !packagePath || packagePath.length > 4096 ||
      typeof texture !== "string" || !/^[-A-Za-z0-9_.]+\.png$/i.test(texture) || typeof textureName !== "string" || !textureName ||
      typeof pixelsPerUnrealUnit !== "number" || !Number.isFinite(pixelsPerUnrealUnit) || pixelsPerUnrealUnit <= 0 || pixelsPerUnrealUnit > 1_000_000 ||
      !Array.isArray(rawVertices) || rawVertices.length < 3 || rawVertices.length > 3_000_000 || rawVertices.length % 3 !== 0) {
    throw new Error("sprite descriptor fields are invalid");
  }
  const vertices = rawVertices.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length !== 4 || raw.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1e9)) {
      throw new Error(`sprite vertex ${index} is invalid`);
    }
    return raw as [number, number, number, number];
  });
  return {
    name,
    packagePath,
    texture,
    textureName,
    sourceUV: tuple(source.SourceUV, "sprite source UV"),
    sourceDimension: tuple(source.SourceDimension, "sprite source dimensions", true),
    pixelsPerUnrealUnit,
    vertices,
  };
}

export function parsePaperFlipbookDescriptor(value: unknown): PaperFlipbookDescriptor {
  const source = record(value, "flipbook descriptor");
  if (typeof source.Name !== "string" || !source.Name || source.Name.length > 512 ||
      typeof source.PackagePath !== "string" || !source.PackagePath || source.PackagePath.length > 4096 ||
      typeof source.FramesPerSecond !== "number" || !Number.isFinite(source.FramesPerSecond) || source.FramesPerSecond <= 0 || source.FramesPerSecond > 100_000 ||
      !Array.isArray(source.Frames) || source.Frames.length < 1 || source.Frames.length > 1_000_000) {
    throw new Error("flipbook descriptor fields are invalid");
  }
  const frames = source.Frames.map((value, index) => {
    const frame = record(value, `flipbook frame ${index}`);
    if (typeof frame.Sprite !== "string" || !frame.Sprite || typeof frame.SpritePath !== "string" ||
        typeof frame.FrameRun !== "number" || !Number.isSafeInteger(frame.FrameRun) || frame.FrameRun < 1 || frame.FrameRun > 1_000_000) {
      throw new Error(`flipbook frame ${index} is invalid`);
    }
    return { sprite: frame.Sprite, spritePath: frame.SpritePath, frameRun: frame.FrameRun };
  });
  return { name: source.Name, packagePath: source.PackagePath, framesPerSecond: source.FramesPerSecond, frames };
}

/** Maps `Project/Content/Foo/Sprite.Sprite` or `/Game/Foo/Sprite.Sprite` to a loose package path. */
export function paperObjectPathToPackage(value: string, fallbackName: string): string {
  const normalized = value.replaceAll("\\", "/");
  const contentAt = normalized.toLowerCase().indexOf("/content/");
  let path = contentAt >= 0 ? normalized.slice(contentAt + 1) : normalized.startsWith("/Game/") ? `Content/${normalized.slice(6)}` : "";
  const objectSuffix = path.lastIndexOf(".");
  if (objectSuffix > path.lastIndexOf("/")) path = path.slice(0, objectSuffix);
  path = path.replace(/^\/+|\/+$/g, "");
  return path && !path.split("/").some((part) => part === "..") ? `${path}.uasset` : `Content/Paper2D/${fallbackName}.uasset`;
}

export async function writePaperSpriteGlb(options: {
  readonly descriptor: PaperSpriteDescriptor;
  readonly texturePath: string;
  readonly outputPath: string;
  readonly maxTextureSize: number | undefined;
}): Promise<{ vertices: number; widthMetres: number; heightMetres: number; textureWidth: number; textureHeight: number; bytes: number }> {
  const { default: sharp } = await import("sharp");
  const textureData = await readFile(options.texturePath);
  const metadata = await sharp(textureData, { limitInputPixels: 268_435_456, unlimited: true }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("sprite atlas has no dimensions");
  const left = Math.round(options.descriptor.sourceUV[0]);
  const top = Math.round(options.descriptor.sourceUV[1]);
  const sourceWidth = Math.round(options.descriptor.sourceDimension[0]);
  const sourceHeight = Math.round(options.descriptor.sourceDimension[1]);
  if (left < 0 || top < 0 || sourceWidth < 1 || sourceHeight < 1 || left + sourceWidth > metadata.width || top + sourceHeight > metadata.height) {
    throw new Error(`sprite source region ${left},${top} ${sourceWidth}x${sourceHeight} exceeds ${metadata.width}x${metadata.height}`);
  }
  const scale = options.maxTextureSize === undefined ? 1 : Math.min(1, options.maxTextureSize / Math.max(sourceWidth, sourceHeight));
  const textureWidth = Math.max(1, Math.round(sourceWidth * scale));
  const textureHeight = Math.max(1, Math.round(sourceHeight * scale));
  const cropped = await sharp(textureData, { limitInputPixels: 268_435_456, unlimited: true })
    .extract({ left, top, width: sourceWidth, height: sourceHeight })
    .resize(textureWidth, textureHeight, { kernel: "nearest", fit: "fill" })
    .png()
    .toBuffer();

  const positions = new Float32Array(options.descriptor.vertices.length * 3);
  const normals = new Float32Array(options.descriptor.vertices.length * 3);
  const uvs = new Float32Array(options.descriptor.vertices.length * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  options.descriptor.vertices.forEach((vertex, index) => {
    const x = vertex[0] * 0.01;
    const y = vertex[1] * 0.01;
    positions.set([x, y, 0], index * 3);
    normals.set([0, 0, 1], index * 3);
    uvs.set([(vertex[2] * metadata.width - left) / sourceWidth, (vertex[3] * metadata.height - top) / sourceHeight], index * 2);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  });
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor("POSITION").setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor("NORMAL").setType("VEC3").setArray(normals).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", document.createAccessor("TEXCOORD_0").setType("VEC2").setArray(uvs).setBuffer(buffer));
  const texture = document.createTexture(options.descriptor.textureName).setImage(cropped).setMimeType("image/png");
  const material = document.createMaterial(`${options.descriptor.name}_unlit`)
    .setBaseColorTexture(texture)
    .setAlphaMode("BLEND")
    .setDoubleSided(true)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  material.setExtension("KHR_materials_unlit", document.createExtension(KHRMaterialsUnlit).createUnlit());
  primitive.setMaterial(material);
  const mesh = document.createMesh(options.descriptor.name).addPrimitive(primitive);
  document.createScene(options.descriptor.name).addChild(document.createNode(options.descriptor.name).setMesh(mesh));
  await new NodeIO()
    .registerExtensions([KHRMaterialsUnlit])
    .setVertexLayout(VertexLayout.SEPARATE)
    .write(options.outputPath, document);
  return {
    vertices: options.descriptor.vertices.length,
    widthMetres: maxX - minX,
    heightMetres: maxY - minY,
    textureWidth,
    textureHeight,
    bytes: (await stat(options.outputPath)).size,
  };
}
