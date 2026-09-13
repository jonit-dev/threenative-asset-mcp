import { Document, NodeIO, type Node as GltfNode } from "@gltf-transform/core";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { suggestBoneRoles } from "../src/rig/inspect.js";
import { createAssetInspectRigHandler } from "../src/tools/rig.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-rig-"));
  temporaryDirectories.push(directory);
  return directory;
}

const JOINT_NAMES = [
  "Hips",
  "Spine",
  "Chest",
  "Neck",
  "Head",
  "Shoulder.L",
  "upper_arm.L",
  "forearm.L",
  "hand.L",
  "Shoulder.R",
  "upper_arm.R",
  "forearm.R",
  "hand.R",
  "Thigh.L",
  "shin.L",
  "foot.L",
  "Thigh.R",
  "shin.R",
  "foot.R",
];

function addClip(document: Document, name: string, target: GltfNode, distance: number): void {
  const buffer =
    document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const input = document
    .createAccessor(`${name}-time`)
    .setType("SCALAR")
    .setArray(new Float32Array([0, 0.5, 1]))
    .setBuffer(buffer);
  const output = document
    .createAccessor(`${name}-translation`)
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, distance, 0, 0, 0, 0, 0]))
    .setBuffer(buffer);
  const sampler = document
    .createAnimationSampler()
    .setInput(input)
    .setOutput(output)
    .setInterpolation("LINEAR");
  document
    .createAnimation(name)
    .addSampler(sampler)
    .addChannel(
      document
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(target)
        .setTargetPath("translation"),
    );
}

async function humanoidGlb(clipNames: readonly string[], withSecondUv = false): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");

  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]))
    .setBuffer(buffer);
  const joints = document
    .createAccessor("joints")
    .setType("VEC4")
    .setArray(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]))
    .setBuffer(buffer);
  const weights = document
    .createAccessor("weights")
    .setType("VEC4")
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const uv0 = document
    .createAccessor("uv0")
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", positions)
    .setAttribute("JOINTS_0", joints)
    .setAttribute("WEIGHTS_0", weights)
    .setAttribute("TEXCOORD_0", uv0);
  if (withSecondUv) {
    primitive.setAttribute(
      "TEXCOORD_1",
      document
        .createAccessor("uv1")
        .setType("VEC2")
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer),
    );
  }
  const mesh = document.createMesh("Body").addPrimitive(primitive);
  document.createMaterial("Skin").setBaseColorFactor([1, 1, 1, 1]);

  const jointsNodes = JOINT_NAMES.map((name) => document.createNode(name));
  const skin = document.createSkin("Rig");
  for (const joint of jointsNodes) skin.addJoint(joint);
  const inverseBindMatrices = new Float32Array(JOINT_NAMES.length * 16);
  for (let i = 0; i < JOINT_NAMES.length; i += 1) inverseBindMatrices[i * 16 + 15] = 1;
  skin.setInverseBindMatrices(
    document.createAccessor("ibm").setType("MAT4").setArray(inverseBindMatrices).setBuffer(buffer),
  );

  const body = document.createNode("Body").setMesh(mesh).setSkin(skin);
  const root = document.createNode("Root");
  scene.addChild(root);
  root.addChild(body);
  root.addChild(jointsNodes[0]!);
  const parentOf: Record<number, number> = {
    1: 0,
    2: 1,
    3: 2,
    4: 3,
    5: 2,
    6: 5,
    7: 6,
    8: 7,
    9: 2,
    10: 9,
    11: 10,
    12: 11,
    13: 0,
    14: 13,
    15: 14,
    16: 0,
    17: 16,
    18: 17,
  };
  for (const [child, parent] of Object.entries(parentOf)) {
    jointsNodes[Number(parent)]!.addChild(jointsNodes[Number(child)]!);
  }

  for (const [index, name] of clipNames.entries()) {
    addClip(document, name, jointsNodes[0]!, index + 1);
  }

  return await new NodeIO().writeBinary(document);
}

async function writeGlb(directory: string, name: string, bytes: Uint8Array): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

async function writeLibraryZip(directory: string): Promise<string> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "Universal Animation Library 1/Unreal-Godot/UAL1_Standard.glb",
    new Uint8ArrayReader(await humanoidGlb(["Idle_Loop", "Walk_Loop", "A_TPose"])),
  );
  await writer.add(
    "Universal Animation Library 1/Unreal-Godot/UAL1_Standard_RM.glb",
    new Uint8ArrayReader(await humanoidGlb(["Walk_Loop", "A_TPose"])),
  );
  const bytes = await writer.close();
  const path = join(directory, "UAL1_Standard.zip");
  await writeFile(path, bytes);
  return path;
}

interface HandlerOutput {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function call(handler: ReturnType<typeof createAssetInspectRigHandler>, input: unknown) {
  return (await handler(input as never)) as unknown as HandlerOutput;
}

describe("asset_inspect_rig", () => {
  it("identifies a rig, its clips and the two library variants offline", async () => {
    const directory = await temporaryDirectory();
    const target = await writeGlb(directory, "aether-02.glb", await humanoidGlb(["Walk"], true));
    const library = await writeLibraryZip(directory);

    const result = await call(createAssetInspectRigHandler(), { target, libraries: [library] });

    expect(result.isError).toBeUndefined();
    const output = result.structuredContent;
    const targetReport = (output.target as { report: Record<string, unknown> }).report;
    expect((targetReport.skins as Array<{ joints: number }>)[0]?.joints).toBe(JOINT_NAMES.length);
    expect((targetReport.meshes as Array<{ attributes: string[] }>)[0]?.attributes).toContain(
      "TEXCOORD_1",
    );
    expect(output.attachmentCandidates).toContain("hand.R");

    const clips = output.catalog as Array<{
      id: string;
      variant: string;
      calibration: boolean;
    }>;
    expect(clips).toHaveLength(5);
    expect(clips.map((clip) => clip.id)).toContain("ual1/Walk_Loop");
    expect(clips.filter((clip) => clip.variant === "root_motion")).toHaveLength(2);
    expect(clips.filter((clip) => clip.calibration).every((clip) => clip.id.endsWith("A_TPose"))).toBe(
      true,
    );

    const sources = output.sources as Array<{ id: string }>;
    expect(sources.map((source) => source.id)).toEqual([
      "aether-02",
      "aether-02-retopo",
      "ual1",
      "ual2",
    ]);
  });

  it("rejects an archive used as the target", async () => {
    const directory = await temporaryDirectory();
    const library = await writeLibraryZip(directory);
    const result = await call(createAssetInspectRigHandler(), { target: library });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("target must be a GLB");
  });

  it("fails closed when a limit is exceeded", async () => {
    const directory = await temporaryDirectory();
    const target = await writeGlb(directory, "aether-02.glb", await humanoidGlb(["Walk"]));
    const result = await call(
      createAssetInspectRigHandler({
        limits: {
          maxGlbBytes: 64,
          maxArchiveBytes: 64,
          maxJoints: 2_048,
          maxClips: 1_024,
          maxMeshes: 4_096,
          maxVertices: 8_000_000,
          maxEntries: 2_048,
          maxTextures: 4_096,
        },
      }),
      { target },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("RIG_INPUT_TOO_LARGE");
  });

  it("acquires a pinned sample through the acquirer and still inspects it", async () => {
    const directory = await temporaryDirectory();
    const samplePath = await writeGlb(
      directory,
      "aether-02-cache.glb",
      await humanoidGlb(["Walk"]),
    );
    const result = await call(
      createAssetInspectRigHandler({
        acquire: async (sourceId) => ({
          path: samplePath,
          bytes: 1,
          sha256: "a".repeat(64),
          alreadyCached: false,
          sourceUrl: `https://raw.githubusercontent.com/RamonLinares/atlas-09/1b8fb9d54160215c071c5a29a49b1c36dc01f0df/${sourceId}.glb`,
        }),
      }),
      { target: { sourceId: "aether-02" } },
    );
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent.acquisition as { sourceId: string }).sourceId).toBe("aether-02");
    const targetReport = (
      result.structuredContent.target as { report: { skins: Array<{ joints: number }> } }
    ).report;
    expect(targetReport.skins[0]?.joints).toBe(JOINT_NAMES.length);
  });

  it("returns a named ambiguity instead of guessing a mapping", () => {
    const roles = suggestBoneRoles(["Hips", "Spine", "UpperArm.L", "UpperArm.R", "hand.R"]);
    const upperArm = roles.find((role) => role.role === "upper_arm" && role.side === "left");
    expect(upperArm?.joint).toBe("UpperArm.L");
    const hand = roles.find((role) => role.role === "hand" && role.side === "right");
    expect(hand?.joint).toBe("hand.R");
  });
});
