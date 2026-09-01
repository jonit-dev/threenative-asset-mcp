import { readFile, stat } from "node:fs/promises";

import { Document, NodeIO, VertexLayout } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";

interface TileCell { readonly tileSet: string; readonly packedTileIndex: number }
interface TileLayer { readonly name: string; readonly width: number; readonly height: number; readonly hiddenInGame: boolean; readonly cells: readonly TileCell[] }

export interface PaperTileSetDescriptor {
  readonly name: string;
  readonly packagePath: string;
  readonly texture: string;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly widthInTiles: number;
  readonly heightInTiles: number;
  readonly borderMargin: readonly [number, number, number, number];
  readonly spacing: readonly [number, number];
  readonly drawingOffset: readonly [number, number];
}

export interface PaperTileMapDescriptor {
  readonly name: string;
  readonly packagePath: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly pixelsPerUnrealUnit: number;
  readonly selectedTileSet: string;
  readonly layers: readonly TileLayer[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string, min = 1, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}

function optionalPoint(value: unknown, label: string): [number, number] {
  if (value === undefined) return [0, 0];
  const point = object(value, label);
  return [integer(point.X, `${label}.x`, 0), integer(point.Y, `${label}.y`, 0)];
}

function optionalMargin(value: unknown): [number, number, number, number] {
  if (value === undefined) return [0, 0, 0, 0];
  const margin = object(value, "tile-set border margin");
  return ["Left", "Top", "Right", "Bottom"].map((side) => integer(margin[side], `border ${side}`, 0)) as [number, number, number, number];
}

function referenceName(value: unknown, label: string): string {
  const ref = object(value, label);
  const assetPath = typeof ref.AssetPathName === "string" ? ref.AssetPathName : undefined;
  const objectName = typeof ref.ObjectName === "string" ? ref.ObjectName : undefined;
  const source = assetPath ?? objectName;
  if (!source) throw new Error(`${label} has no object name`);
  const match = /(?:[/.'])([^/.']+)(?:'|$)/.exec(source);
  return match?.[1] ?? source;
}

export function parsePaperTileSetDescriptor(value: unknown): PaperTileSetDescriptor {
  const root = object(value, "tile-set descriptor");
  const properties = object(root.Properties, "tile-set properties");
  const size = object(properties.TileSize, "tile-set size");
  const texture = text(root.Texture, "tile-set texture");
  if (!/^[-A-Za-z0-9_.]+\.png$/i.test(texture)) throw new Error("tile-set texture name is unsafe");
  return {
    name: text(root.Name, "tile-set name"),
    packagePath: text(root.PackagePath, "tile-set package path"),
    texture,
    tileWidth: integer(size.X, "tile width"),
    tileHeight: integer(size.Y, "tile height"),
    widthInTiles: integer(properties.WidthInTiles, "tile-set width"),
    heightInTiles: integer(properties.HeightInTiles, "tile-set height"),
    borderMargin: optionalMargin(properties.BorderMargin),
    spacing: optionalPoint(properties.PerTileSpacing, "per-tile spacing"),
    drawingOffset: optionalPoint(properties.DrawingOffset, "drawing offset"),
  };
}

export function parsePaperTileMapDescriptor(value: unknown): PaperTileMapDescriptor {
  const root = object(value, "tile-map descriptor");
  const properties = object(root.Properties, "tile-map properties");
  const mapWidth = integer(properties.MapWidth, "map width");
  const mapHeight = integer(properties.MapHeight, "map height");
  const related = root.RelatedExports;
  if (!Array.isArray(related) || related.length > 10_000) throw new Error("tile-map layer list is invalid");
  const layers = related.map((raw, layerIndex): TileLayer => {
    const layer = object(raw, `layer ${layerIndex}`);
    const props = object(layer.Properties, `layer ${layerIndex} properties`);
    const width = integer(props.AllocatedWidth, `layer ${layerIndex} width`);
    const height = integer(props.AllocatedHeight, `layer ${layerIndex} height`);
    const rawCells = props.AllocatedCells;
    if (!Array.isArray(rawCells) || rawCells.length !== width * height || rawCells.length > 4_000_000) {
      throw new Error(`layer ${layerIndex} cell count does not match ${width}x${height}`);
    }
    return {
      name: text(layer.Name, `layer ${layerIndex} name`), width, height, hiddenInGame: props.bHiddenInGame === true,
      cells: rawCells.map((rawCell, cellIndex) => {
        const cell = object(rawCell, `layer ${layerIndex} cell ${cellIndex}`);
        const packed = integer(cell.PackedTileIndex, `layer ${layerIndex} cell ${cellIndex} index`, -1, 0xffff_ffff);
        return { tileSet: packed === -1 || cell.TileSet === null ? "" : referenceName(cell.TileSet, "cell tile set"), packedTileIndex: packed };
      }),
    };
  });
  const ppu = properties.PixelsPerUnrealUnit;
  if (typeof ppu !== "number" || !Number.isFinite(ppu) || ppu <= 0 || ppu > 1_000_000) throw new Error("pixels per Unreal unit is invalid");
  const projection = properties.ProjectionMode;
  if (projection !== undefined && !String(projection).endsWith("Orthogonal")) throw new Error(`tile-map projection ${String(projection)} is not supported`);
  return {
    name: text(root.Name, "tile-map name"), packagePath: text(root.PackagePath, "tile-map package path"),
    mapWidth, mapHeight,
    tileWidth: integer(properties.TileWidth, "map tile width"),
    tileHeight: integer(properties.TileHeight, "map tile height"),
    pixelsPerUnrealUnit: ppu,
    selectedTileSet: referenceName(properties.SelectedTileSet, "selected tile set"), layers,
  };
}

/** Builds one unlit, alpha-blended quad per populated cell. Unreal's top three bits encode UV flips. */
export async function writePaperTileMapGlb(options: {
  readonly map: PaperTileMapDescriptor; readonly tileSet: PaperTileSetDescriptor;
  readonly texturePath: string; readonly outputPath: string;
}): Promise<{ vertices: number; tiles: number; bounds: [number, number, number]; bytes: number }> {
  const image = await readFile(options.texturePath);
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(image).metadata();
  const [marginLeft, marginTop, marginRight, marginBottom] = options.tileSet.borderMargin;
  const [spacingX, spacingY] = options.tileSet.spacing;
  const expectedWidth = marginLeft + marginRight + options.tileSet.tileWidth * options.tileSet.widthInTiles + spacingX * (options.tileSet.widthInTiles - 1);
  const expectedHeight = marginTop + marginBottom + options.tileSet.tileHeight * options.tileSet.heightInTiles + spacingY * (options.tileSet.heightInTiles - 1);
  if (!metadata.width || !metadata.height || metadata.width < expectedWidth || metadata.height < expectedHeight) {
    throw new Error(`tile sheet is smaller than its ${expectedWidth}x${expectedHeight} grid`);
  }
  const cells = options.map.layers.flatMap((layer, layerIndex) => layer.hiddenInGame ? [] : layer.cells.map((cell, cellIndex) => ({ cell, cellIndex, layer, layerIndex })))
    .filter(({ cell }) => cell.packedTileIndex !== -1 && cell.tileSet.toLowerCase() === options.tileSet.name.toLowerCase());
  if (cells.length === 0) throw new Error("tile map has no populated cells for its selected tile set");
  const positions = new Float32Array(cells.length * 12);
  const normals = new Float32Array(cells.length * 12);
  const uvs = new Float32Array(cells.length * 8);
  const indices = new (cells.length * 4 > 65_535 ? Uint32Array : Uint16Array)(cells.length * 6);
  const unit = 0.01 / options.map.pixelsPerUnrealUnit;
  cells.forEach(({ cell, cellIndex, layer, layerIndex }, tile) => {
    const x = cellIndex % layer.width;
    const y = Math.floor(cellIndex / layer.width);
    const x0 = (x * options.map.tileWidth + options.tileSet.drawingOffset[0]) * unit, x1 = x0 + options.map.tileWidth * unit;
    const y0 = -(y * options.map.tileHeight + options.tileSet.drawingOffset[1]) * unit, y1 = y0 - options.map.tileHeight * unit;
    const z = layerIndex * 0.0001;
    positions.set([x0,y0,z, x1,y0,z, x1,y1,z, x0,y1,z], tile * 12);
    normals.set([0,0,1, 0,0,1, 0,0,1, 0,0,1], tile * 12);
    const packed = cell.packedTileIndex >>> 0;
    const index = packed & 0x1fff_ffff;
    if (index >= options.tileSet.widthInTiles * options.tileSet.heightInTiles) throw new Error(`tile index ${index} exceeds the tile sheet`);
    const column = index % options.tileSet.widthInTiles, row = Math.floor(index / options.tileSet.widthInTiles);
    const pixelX = marginLeft + column * (options.tileSet.tileWidth + spacingX);
    const pixelY = marginTop + row * (options.tileSet.tileHeight + spacingY);
    const u0 = pixelX / metadata.width, u1 = (pixelX + options.tileSet.tileWidth) / metadata.width;
    const v0 = pixelY / metadata.height, v1 = (pixelY + options.tileSet.tileHeight) / metadata.height;
    let corners: [number, number][] = [[u0,v0],[u1,v0],[u1,v1],[u0,v1]];
    if (packed & 0x8000_0000) corners = [corners[1]!, corners[0]!, corners[3]!, corners[2]!];
    if (packed & 0x4000_0000) corners = [corners[3]!, corners[2]!, corners[1]!, corners[0]!];
    if (packed & 0x2000_0000) corners = [corners[0]!, corners[3]!, corners[2]!, corners[1]!];
    uvs.set(corners.flat(), tile * 8);
    const base = tile * 4; indices.set([base,base+1,base+2, base,base+2,base+3], tile * 6);
  });
  const document = new Document(); const buffer = document.createBuffer();
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(uvs).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
  const texture = document.createTexture(options.tileSet.name).setImage(image).setMimeType("image/png");
  const material = document.createMaterial(`${options.map.name}_unlit`).setBaseColorTexture(texture).setAlphaMode("BLEND").setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(1);
  material.setExtension("KHR_materials_unlit", document.createExtension(KHRMaterialsUnlit).createUnlit());
  primitive.setMaterial(material);
  const mesh = document.createMesh(options.map.name).addPrimitive(primitive);
  document.createScene(options.map.name).addChild(document.createNode(options.map.name).setMesh(mesh));
  await new NodeIO().registerExtensions([KHRMaterialsUnlit]).setVertexLayout(VertexLayout.SEPARATE).write(options.outputPath, document);
  return { vertices: positions.length / 3, tiles: cells.length,
    bounds: [options.map.mapWidth * options.map.tileWidth * unit, options.map.mapHeight * options.map.tileHeight * unit, options.map.layers.length * 0.0001],
    bytes: (await stat(options.outputPath)).size };
}
