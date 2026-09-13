import { Document, NodeIO } from "@gltf-transform/core";
import { Quaternion, Vector3 } from "three";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAssetAutoRigHandler, createAssetRetargetAnimationsHandler } from "../src/tools/rig.js";
import { unriggedBipedGlb } from "./helpers/rig-fixture.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-retarget-"));
  temporaryDirectories.push(directory);
  return directory;
}

const DONOR_NAMES = [
  "root",
  "pelvis",
  "spine_01",
  "spine_02",
  "spine_03",
  "neck_01",
  "Head",
  "clavicle_l",
  "upperarm_l",
  "lowerarm_l",
  "hand_l",
  "clavicle_r",
  "upperarm_r",
  "lowerarm_r",
  "hand_r",
  "thigh_l",
  "calf_l",
  "foot_l",
  "thigh_r",
  "calf_r",
  "foot_r",
];
const DONOR_PARENTS = [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13, 1, 15, 16, 1, 18, 19];

function donorDocument(names: readonly string[] = DONOR_NAMES, parents: readonly (number | null)[] = DONOR_PARENTS): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const nodes = names.map((name) => document.createNode(name));
  nodes.forEach((node, index) => node.setTranslation([0, index * 0.05, 0]));
  parents.forEach((parent, index) => {
    if (parent !== null) nodes[parent]!.addChild(nodes[index]!);
  });
  const skin = document.createSkin("DonorRig");
  for (const node of nodes) skin.addJoint(node);
  skin.setInverseBindMatrices(
    document.createAccessor("ibm").setType("MAT4").setArray(new Float32Array(nodes.length * 16)).setBuffer(buffer),
  );
  const mesh = document.createMesh("DonorBody").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", document.createAccessor("pos").setType("VEC3").setArray(new Float32Array([0, 0, 0])).setBuffer(buffer)),
  );
  document.createNode("DonorBody").setMesh(mesh).setSkin(skin);
  const scene = document.createScene("Scene");
  scene.addChild(nodes[0]!);
  scene.addChild(document.getRoot().listNodes().find((node) => node.getName() === "DonorBody")!);

  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 8);
  const input = document.createAccessor("time").setType("SCALAR").setArray(new Float32Array([0, 0.5, 1])).setBuffer(buffer);
  const output = document
    .createAccessor("rot")
    .setType("VEC4")
    .setArray(new Float32Array([rotation.x, rotation.y, rotation.z, rotation.w, rotation.x, rotation.y, rotation.z, rotation.w, rotation.x, rotation.y, rotation.z, rotation.w]))
    .setBuffer(buffer);
  const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  document
    .createAnimation("donor-clip")
    .addSampler(sampler)
    .addChannel(
      document.createAnimationChannel().setSampler(sampler).setTargetNode(nodes[8]!).setTargetPath("rotation"),
    );
  return document;
}

interface HandlerResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

describe("asset_retarget_animations", () => {
  it("retargets a donor clip onto an auto-rigged target and publishes a glb", async () => {
    const directory = await temporaryDirectory();
    const unrigged = join(directory, "retopo.glb");
    await writeFile(unrigged, await unriggedBipedGlb());
    const target = join(directory, "rigged.glb");
    const autoRig = (await createAssetAutoRigHandler()({ target: unrigged, output: target, projectRoot: directory } as never)) as unknown as HandlerResult;
    expect(autoRig.isError).toBeUndefined();

    const output = join(directory, "retargeted.glb");
    const handler = createAssetRetargetAnimationsHandler({
      loadDonor: async () => donorDocument(),
    });
    const result = (await handler({
      target,
      output,
      projectRoot: directory,
      clips: [{ id: "ual1/Walk_Loop", variant: "in_place" }],
      keepExistingClips: false,
    } as never)) as unknown as HandlerResult;

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent;
    expect(structured.status).toBe("retargeted");
    expect(structured.animationCount).toBe(1);
    expect(structured.animationBytes).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(true);

    const reloaded = await new NodeIO().readBinary(new Uint8Array(await readFile(output)));
    expect(reloaded.getRoot().listAnimations().map((entry) => entry.getName())).toEqual(["ual1/Walk_Loop"]);
    expect(reloaded.getRoot().listSkins()[0]?.listJoints()).toHaveLength(18);
    const primitives = reloaded.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(primitives.getAttribute("TEXCOORD_0") ?? primitives.getAttribute("POSITION")).not.toBeNull();
  });

  it("fails a missing required mapping", async () => {
    const directory = await temporaryDirectory();
    const unrigged = join(directory, "retopo.glb");
    await writeFile(unrigged, await unriggedBipedGlb());
    const target = join(directory, "rigged.glb");
    await createAssetAutoRigHandler()({ target: unrigged, output: target, projectRoot: directory } as never);

    const broken = donorDocument(
      [
        "root",
        "pelvis",
        "spine_01",
        "spine_02",
        "spine_03",
        "neck_01",
        "Head",
        "clavicle_l",
        "upperarm_l",
        "lowerarm_l",
        "hand_l",
        "clavicle_r",
        "upperarm_r",
        "lowerarm_r",
        "hand_r",
      ],
      [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13],
    );
    const handler = createAssetRetargetAnimationsHandler({ loadDonor: async () => broken });
    const result = (await handler({
      target,
      output: join(directory, "out.glb"),
      projectRoot: directory,
      clips: [{ id: "ual1/Walk_Loop", variant: "in_place" }],
    } as never)) as unknown as HandlerResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("required target bones");
  });
});
