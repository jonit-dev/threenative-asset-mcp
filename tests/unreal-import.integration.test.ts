import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  packsRoughnessInAlpha,
  parseMatFile,
  parsePropsFile,
  resolveMaterial,
} from "../src/unreal/materials.js";
import {
  applyTextureTransform,
  assertContained,
  hashSourceTree,
  ImportError,
  importUnrealDirectory,
  interleavedBufferViews,
  parseUmodelList,
  summarizeClasses,
  validateGlb,
} from "../src/unreal/importer.js";
import { childEnvironment, resolveExecutable, ToolchainError } from "../src/unreal/toolchain.js";
import { runImportCli } from "../src/cli.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "asset-mcp-unreal-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const ROCK_MAT = `Diffuse=T_Rock_D_R
Normal=T_Rock_N
Other[0]=T_Rock_Extra
`;

const ROCK_PROPS = `TwoSided = false
BlendMode = BLEND_Opaque (0)
OpacityMaskClipValue = 0.333
`;

const FOLIAGE_MAT = `Normal=T_Leaf_N
SpecPower=T_Leaf_S
Other[0]=T_Leaf_Atlas
`;

const FOLIAGE_PROPS = `TwoSided = true
BlendMode = BLEND_Masked (1)
OpacityMaskClipValue = 0.4
CollectedTextureParameters[2] =
{
    CollectedTextureParameters[0] =
    {
        Texture = Texture2D'Content/Game/T_Leaf_Atlas.T_Leaf_Atlas'
        Name = Diffuse
        Group = None
    }
    CollectedTextureParameters[1] =
    {
        Texture = Texture2D'Content/Game/T_Leaf_N.T_Leaf_N'
        Name = Normal
        Group = None
    }
}
`;

/** Builds a source tree the fake umodel reports on, plus the artifacts it "exports". */
async function unrealWorkspace(options: {
  readonly mat?: string;
  readonly props?: string;
  readonly textures?: readonly string[];
  readonly degenerateTangents?: boolean;
  readonly classes?: Readonly<Record<string, readonly string[]>>;
  readonly listExitCode?: number;
  readonly exportExitCode?: number;
  readonly corruptBuffer?: boolean;
  readonly argvLog?: string;
} = {}): Promise<{
  sourceDir: string;
  outputDir: string;
  umodel: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await temporaryDirectory();
  const sourceDir = join(root, "pack", "Content", "Game");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "SM_Rock.uasset"), "not really an unreal package");
  await writeFile(join(sourceDir, "Showcase.umap"), "level");
  await writeFile(join(sourceDir, "BP_Spawner.uasset"), "blueprint");

  const exported = join(root, "exported");
  await writeMeshFixture(exported, {
    name: "SM_Rock",
    materialName: "M_Rock",
    mat: options.mat ?? ROCK_MAT,
    props: options.props ?? ROCK_PROPS,
    textures: options.textures ?? ["T_Rock_D_R", "T_Rock_N", "T_Rock_Extra"],
    ...(options.degenerateTangents === undefined
      ? {}
      : { degenerateTangents: options.degenerateTangents }),
  });

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes: options.classes ?? {
      SM_Rock: ["StaticMesh", "BodySetup"],
      BP_Spawner: ["Blueprint"],
    },
    outputSubdirectory: "Game",
    ...(options.listExitCode === undefined ? {} : { listExitCode: options.listExitCode }),
    ...(options.exportExitCode === undefined ? {} : { exportExitCode: options.exportExitCode }),
    ...(options.corruptBuffer === undefined ? {} : { corruptBuffer: options.corruptBuffer }),
    ...(options.argvLog === undefined ? {} : { argvLog: options.argvLog }),
  });

  return {
    sourceDir: join(root, "pack"),
    outputDir: join(root, "game", "assets", "fab", "pack"),
    umodel,
    environment: {
      ...process.env,
      THREENATIVE_UMODEL_PATH: umodel,
      THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"),
      THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
    },
  };
}

describe("UE Viewer material metadata", () => {
  it("reads the named slots and leaves everything else as Other", () => {
    const parsed = parseMatFile(ROCK_MAT);
    expect(parsed.slots.get("Diffuse")).toBe("T_Rock_D_R");
    expect(parsed.slots.get("Normal")).toBe("T_Rock_N");
    expect(parsed.others).toEqual(["T_Rock_Extra"]);
  });

  it("reads blend mode, cutoff, sidedness, and the material's own parameter names", () => {
    const parsed = parsePropsFile(FOLIAGE_PROPS);
    expect(parsed.twoSided).toBe(true);
    expect(parsed.blendMode).toBe("BLEND_Masked");
    expect(parsed.opacityMaskClipValue).toBeCloseTo(0.4);
    expect(parsed.collected).toEqual([
      { name: "Diffuse", texture: "T_Leaf_Atlas" },
      { name: "Normal", texture: "T_Leaf_N" },
    ]);
  });

  it("reads a material instance's own texture overrides and its parent", () => {
    const parsed = parsePropsFile(`Parent = Material3'Content/Game/M_Master.M_Master'
TextureParameterValues[2] =
{
    TextureParameterValues[0] =
    {
        ParameterInfo = { Name=None }
        ParameterValue = Texture2D'Content/Game/T_Pillar_N.T_Pillar_N'
        ParameterName = NRM
    }
    TextureParameterValues[1] =
    {
        ParameterInfo = { Name=None }
        ParameterValue = Texture2D'Content/Game/T_Pillar_M.T_Pillar_M'
        ParameterName = Mask
    }
}
`);
    expect(parsed.parent).toBe("M_Master");
    expect(parsed.overrides).toEqual([
      { name: "NRM", texture: "T_Pillar_N" },
      { name: "Mask", texture: "T_Pillar_M" },
    ]);
  });
});

describe("material reconstruction", () => {
  const textures = new Set([
    "T_Rock_D_R",
    "T_Rock_N",
    "T_Rock_Extra",
    "T_Leaf_Atlas",
    "T_Leaf_N",
    "T_Leaf_S",
    "T_Pillar_N",
  ]);

  it("binds .mat slots exactly and derives roughness from a packed _D_R alpha", () => {
    const resolved = resolveMaterial({
      name: "M_Rock",
      readMat: (name) => (name === "M_Rock" ? ROCK_MAT : undefined),
      readProps: (name) => (name === "M_Rock" ? ROCK_PROPS : undefined),
      availableTextures: textures,
    });
    expect(packsRoughnessInAlpha("T_Rock_D_R")).toBe(true);
    expect(resolved.bindings).toContainEqual({
      slot: "baseColor",
      texture: "T_Rock_D_R",
      source: "mat",
      confidence: "exact",
      transform: "none",
    });
    expect(resolved.bindings).toContainEqual({
      slot: "metallicRoughness",
      texture: "T_Rock_D_R",
      source: "mat",
      confidence: "heuristic",
      transform: "alphaToRoughness",
    });
    expect(resolved.alphaMode).toBe("OPAQUE");
  });

  it("recovers a diffuse the .mat left in Other from the material's parameter names", () => {
    const resolved = resolveMaterial({
      name: "M_Leaf",
      readMat: () => FOLIAGE_MAT,
      readProps: () => FOLIAGE_PROPS,
      availableTextures: textures,
    });
    const baseColor = resolved.bindings.find((binding) => binding.slot === "baseColor");
    expect(baseColor).toMatchObject({
      texture: "T_Leaf_Atlas",
      source: "props",
      confidence: "heuristic",
    });
    expect(resolved.alphaMode).toBe("MASK");
    expect(resolved.alphaCutoff).toBeCloseTo(0.4);
    expect(resolved.doubleSided).toBe(true);
  });

  it("follows a parent chain and stops on a cycle instead of recursing forever", () => {
    const resolved = resolveMaterial({
      name: "MI_A",
      readMat: (name) => (name === "M_Base" ? "Diffuse=T_Rock_D_R\n" : "Other[0]=T_Rock_Extra\n"),
      readProps: (name) =>
        name === "MI_A"
          ? "Parent = Material'Content/G/M_Base.M_Base'\n"
          : "Parent = Material'Content/G/MI_A.MI_A'\n",
      availableTextures: textures,
    });
    expect(resolved.parents).toEqual(["M_Base"]);
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe(
      "T_Rock_D_R",
    );
  });

  it("fills an unresolved slot from an instance override without displacing a .mat slot", () => {
    const resolved = resolveMaterial({
      name: "MI_Pillar",
      readMat: () => "Diffuse=T_Rock_D_R\n",
      readProps: () => `TextureParameterValues[1] =
{
    TextureParameterValues[0] =
    {
        ParameterValue = Texture2D'Content/G/T_Pillar_N.T_Pillar_N'
        ParameterName = NRM
    }
}
`,
      availableTextures: textures,
    });
    expect(resolved.bindings.find((binding) => binding.slot === "normal")).toMatchObject({
      texture: "T_Pillar_N",
      source: "props",
      confidence: "heuristic",
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe(
      "T_Rock_D_R",
    );
  });

  it("reports an unmappable texture rather than dropping it", () => {
    const resolved = resolveMaterial({
      name: "M_Odd",
      readMat: () => "Other[0]=T_Mystery_Thing\n",
      readProps: () => undefined,
      availableTextures: new Set(["T_Mystery_Thing"]),
    });
    expect(resolved.bindings).toHaveLength(0);
    expect(resolved.unsupported).toEqual([
      {
        texture: "T_Mystery_Thing",
        reason: "no exact, parameter-name, or filename mapping",
      },
    ]);
  });
});

describe("named channel transforms", () => {
  async function readPixel(data: Buffer): Promise<number[]> {
    const { default: sharp } = await import("sharp");
    const raw = await sharp(data).raw().toBuffer({ resolveWithObject: true });
    return [raw.data[0] ?? 0, raw.data[1] ?? 0, raw.data[2] ?? 0];
  }

  it("moves a packed diffuse alpha into glTF's roughness channel", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "packed.png");
    await writePng(source, [10, 20, 30, 200]);
    const result = await applyTextureTransform(await readFile(source), "alphaToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 200, 0]);
  });

  it("inverts a specular-power map into roughness", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "spec.png");
    await writePng(source, [200, 200, 200, 255]);
    const result = await applyTextureTransform(await readFile(source), "specPowerToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 55, 0]);
  });

  it("moves a red-channel roughness map into green", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "rough.png");
    await writePng(source, [77, 0, 0, 255]);
    const result = await applyTextureTransform(await readFile(source), "redToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 77, 0]);
  });

  it("returns an untouched image byte-for-byte when nothing has to change", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "plain.png");
    await writePng(source, [1, 2, 3, 255]);
    const bytes = await readFile(source);
    const result = await applyTextureTransform(bytes, "none", undefined);
    expect(result.data).toEqual(bytes);
  });
});

describe("path and toolchain guards", () => {
  it("refuses an output name that escapes the import directory", () => {
    expect(() => assertContained("/tmp/out", "../escape.glb")).toThrow(ImportError);
    expect(assertContained("/tmp/out", "Group/Mesh.glb")).toBe("/tmp/out/Group/Mesh.glb");
  });

  it("hashes the source tree by relative path and size, independent of the root", () => {
    const left = hashSourceTree("/a", [{ path: "/a/x.uasset", size: 10 }]);
    const right = hashSourceTree("/b", [{ path: "/b/x.uasset", size: 10 }]);
    const changed = hashSourceTree("/a", [{ path: "/a/x.uasset", size: 11 }]);
    expect(left).toBe(right);
    expect(changed).not.toBe(left);
  });

  it("parses the class table UE Viewer prints for -list", () => {
    const parsed = parseUmodelList(
      "Found 3 game files\n   0    178AC       99 AssetImportData AssetImportData_6\n   4    17B21     1485 StaticMesh SM_Rock\n",
    );
    expect(parsed.classes).toEqual(["AssetImportData", "StaticMesh"]);
    expect(parsed.objects).toEqual(["AssetImportData_6", "SM_Rock"]);
  });

  it("names a few classes and counts the rest instead of dumping hundreds", () => {
    expect(summarizeClasses(["A", "B", "C", "D", "E", "F"])).toBe("A, B, C, D and 2 more");
  });

  it("hands a child no environment variable that could carry a secret", () => {
    const forwarded = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      NPM_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      FAB_SESSION: "secret",
    });
    expect(forwarded).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    });
  });

  it("refuses a relative executable override rather than searching for it", async () => {
    await expect(
      resolveExecutable("umodel", { THREENATIVE_UMODEL_PATH: "./umodel" }),
    ).rejects.toThrow(ToolchainError);
  });

  it("reports a missing umodel with an actionable message when auto-install is off", async () => {
    await expect(
      resolveExecutable("umodel", { PATH: "/nonexistent" }),
    ).rejects.toThrow(/THREENATIVE_UMODEL_PATH/);
  });
});

describe("GLB validation", () => {
  it("rejects a file that is not a glTF binary container", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "broken.glb");
    await writeFile(path, Buffer.alloc(64));
    await expect(validateGlb(path)).rejects.toThrow(/not a glTF binary container/);
  });

  it("rejects a container whose declared length does not match the file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "short.glb");
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32LE(0x46546c67, 0);
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(9999, 8);
    await writeFile(path, bytes);
    await expect(validateGlb(path)).rejects.toThrow(/declares 9999 bytes/);
  });
});

describe("importing a local Unreal directory", () => {
  it("converts static meshes, textures the materials, and reports everything it skipped", async () => {
    const workspace = await unrealWorkspace();
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts.exported).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.materials).toBe("complete");
    expect(report.materialCoverage.textured).toBe(1);

    // The level and the Blueprint are named, not silently dropped.
    expect(report.skipped.map((entry) => entry.package)).toEqual(
      expect.arrayContaining([
        "Content/Game/Showcase.umap",
        "Content/Game/BP_Spawner.uasset",
      ]),
    );
    expect(report.skipped.find((entry) => entry.package.endsWith(".umap"))?.reason).toMatch(
      /Unreal level/,
    );

    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    const glb = join(workspace.outputDir, model.glb);
    const document = await new NodeIO().read(glb);
    const material = document.getRoot().listMaterials()[0];
    if (!material) throw new Error("expected a material");

    // Re-read from the written artifact: a report literal would prove nothing.
    expect(material.getBaseColorTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    expect(material.getNormalTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    expect(material.getMetallicRoughnessTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    // UE Viewer's debug colour never survives.
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
  });

  it("writes separate vertex layout, which the native host requires", async () => {
    const workspace = await unrealWorkspace();
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    // An interleaved buffer view renders on the web and fails createRenderPipeline on native.
    expect(interleavedBufferViews(await readFile(join(workspace.outputDir, model.glb)))).toBe(0);
  });

  it("drops UE Viewer's all-zero tangents and its lightmap UV sets", async () => {
    const workspace = await unrealWorkspace({ degenerateTangents: true });
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    expect(report.warnings.join(" ")).toMatch(/zero-length TANGENT/);
    expect(report.warnings.join(" ")).toMatch(/extra UV channels/);

    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    const document = await new NodeIO().read(join(workspace.outputDir, model.glb));
    const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
    expect(primitive?.getAttribute("TANGENT")).toBeNull();
    expect(primitive?.getAttribute("TEXCOORD_1")).toBeNull();
    expect(primitive?.getAttribute("TEXCOORD_0")).not.toBeNull();
  });

  it("renames a section UE Viewer could not resolve and never calls it textured", async () => {
    const workspace = await unrealWorkspace();
    // The fixture's material is named by the mesh fixture; rewrite it to umodel's placeholder.
    const exported = join(workspace.sourceDir, "..", "exported");
    const gltfPath = join(exported, "SM_Rock.gltf");
    const document = await new NodeIO().read(gltfPath);
    document.getRoot().listMaterials()[0]?.setName("dummy_material_0");
    await new NodeIO().write(gltfPath, document);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    const section = report.models[0]?.materials[0];
    expect(section?.name).toMatch(/_unresolved_section_\d+$/);
    expect(section?.name).not.toMatch(/dummy_material/);
    expect(section?.resolved).toBe(false);
    expect(report.materials).toBe("degraded");
    expect(report.materialCoverage.unresolved).toBe(1);
  });

  it("reuses an identical import and refuses to overwrite a different one", async () => {
    const workspace = await unrealWorkspace();
    const request = {
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel" as const, path: workspace.umodel, version: "Test" },
    };
    const first = await importUnrealDirectory(request);
    expect(first.reused).toBe(false);
    const second = await importUnrealDirectory(request);
    expect(second.reused).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);

    await expect(
      importUnrealDirectory({ ...request, maxTextureSize: 256 }),
    ).rejects.toThrow(/already holds a different import/);
  });

  it("fails without promoting anything when UE Viewer exits nonzero", async () => {
    const workspace = await unrealWorkspace({ exportExitCode: 3 });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/No package produced a valid GLB/);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("fails without promoting anything when the exported buffer is corrupt", async () => {
    const workspace = await unrealWorkspace({ corruptBuffer: true });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(ImportError);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("fails when no package in the directory holds a static mesh", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["Texture2D"] } });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/contains a StaticMesh, so there is nothing to convert/);
  });

  it("refuses a source directory that is not there", async () => {
    const workspace = await unrealWorkspace();
    await expect(
      importUnrealDirectory({
        sourceDir: join(workspace.sourceDir, "missing"),
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/not a readable directory/);
  });
});

describe("the CLI and the MCP tool are one code path", () => {
  it("produces byte-identical GLBs from the same directory", async () => {
    const workspace = await unrealWorkspace();
    const viaLibrary = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: join(workspace.outputDir, "library"),
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    const previous = process.env.THREENATIVE_UMODEL_PATH;
    const previousCache = process.env.THREENATIVE_UNREAL_CACHE_DIR;
    process.env.THREENATIVE_UMODEL_PATH = workspace.umodel;
    process.env.THREENATIVE_UNREAL_CACHE_DIR = workspace.environment.THREENATIVE_UNREAL_CACHE_DIR ?? "";
    try {
      const result = await runImportCli([
        workspace.sourceDir,
        "--out",
        join(workspace.outputDir, "cli"),
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const summary = JSON.parse(result.stdout) as { models: { glb: string }[] };
      const model = viaLibrary.models[0];
      const cliModel = summary.models[0];
      if (!model || !cliModel) throw new Error("expected one model from each path");
      expect(cliModel.glb).toBe(model.glb);
      expect(await readFile(join(workspace.outputDir, "cli", cliModel.glb))).toEqual(
        await readFile(join(workspace.outputDir, "library", model.glb)),
      );
    } finally {
      if (previous === undefined) delete process.env.THREENATIVE_UMODEL_PATH;
      else process.env.THREENATIVE_UMODEL_PATH = previous;
      if (previousCache === undefined) delete process.env.THREENATIVE_UNREAL_CACHE_DIR;
      else process.env.THREENATIVE_UNREAL_CACHE_DIR = previousCache;
    }
  });

  it("prints usage and exits nonzero without an output directory", async () => {
    const result = await runImportCli(["/some/pack"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--out <directory>/);
  });
});
