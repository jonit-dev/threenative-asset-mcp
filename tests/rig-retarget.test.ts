import { Document, NodeIO } from "@gltf-transform/core";
import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { mapSkeleton, retargetClip } from "../src/rig/retarget.js";

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
const AETHER_NAMES = [
  "root",
  "pelvis",
  "chest",
  "head",
  "shoulder.L",
  "upper_arm.L",
  "forearm.L",
  "hand.L",
  "shoulder.R",
  "upper_arm.R",
  "forearm.R",
  "hand.R",
  "thigh.L",
  "shin.L",
  "foot.L",
  "thigh.R",
  "shin.R",
  "foot.R",
];

function rotationAxis(axis: "x" | "y" | "z", degrees: number): [number, number, number, number] {
  const vector = new Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
  const quaternion = new Quaternion().setFromAxisAngle(vector, (degrees * Math.PI) / 180);
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function skeletonDocument(
  names: readonly string[],
  parents: readonly (number | null)[],
  options: {
    clip?: { name: string; target: number; rotation: [number, number, number, number] };
    restRotation?: Record<number, [number, number, number, number]>;
    rootDelta?: [number, number, number];
  } = {},
): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const nodes = names.map((name) => document.createNode(name));
  nodes.forEach((node, index) => {
    node.setTranslation([0, index * 0.1, 0]);
    const rest = options.restRotation?.[index];
    if (rest) node.setRotation(rest);
  });
  parents.forEach((parent, index) => {
    if (parent !== null) nodes[parent]!.addChild(nodes[index]!);
  });
  const skin = document.createSkin("Rig");
  for (const node of nodes) skin.addJoint(node);
  skin.setInverseBindMatrices(
    document
      .createAccessor("ibm")
      .setType("MAT4")
      .setArray(new Float32Array(names.length * 16))
      .setBuffer(buffer),
  );
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        document.createAccessor("pos").setType("VEC3").setArray(new Float32Array([0, 0, 0])).setBuffer(buffer),
      ),
  );
  document.createNode("Body").setMesh(mesh).setSkin(skin);
  const scene = document.createScene("Scene");
  scene.addChild(nodes[0]!);
  scene.addChild(document.getRoot().listNodes().find((node) => node.getName() === "Body")!);
  if (options.clip) {
    const input = document.createAccessor("time").setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const output = document
      .createAccessor("rot")
      .setType("VEC4")
      .setArray(new Float32Array([...options.clip.rotation, ...options.clip.rotation]))
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
    document
      .createAnimation(options.clip.name)
      .addSampler(sampler)
      .addChannel(
        document
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(nodes[options.clip.target]!)
          .setTargetPath("rotation"),
      );
  }
  if (options.rootDelta) {
    const [dx, dy, dz] = options.rootDelta;
    const input = document.createAccessor("root-time").setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const output = document
      .createAccessor("root-translation")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, dx, dy, dz]))
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
    const animation = document.getRoot().listAnimations()[0] ?? document.createAnimation("RootMotion");
    animation
      .addSampler(sampler)
      .addChannel(
        document
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(nodes[0]!)
          .setTargetPath("translation"),
      );
  }
  return document;
}

function angleBetween(a: Quaternion, b: Quaternion): number {
  const dot = Math.abs(a.dot(b));
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

describe("retarget mapping", () => {
  it("maps donor names onto AETHER names and reports missing required limbs", () => {
    const mapping = mapSkeleton(DONOR_NAMES, AETHER_NAMES);
    expect(mapping.requiredMissing).toEqual([]);
    expect(mapping.map.get("chest")).toBe("spine_03");
    expect(mapping.map.get("upper_arm.L")).toBe("upperarm_l");
    expect(mapping.map.get("shin.R")).toBe("calf_r");
    expect(mapping.map.get("hand.L")).toBe("hand_l");

    const broken = mapSkeleton(DONOR_NAMES.filter((name) => !name.startsWith("thigh") && !name.startsWith("calf")), AETHER_NAMES);
    expect(broken.requiredMissing.length).toBeGreaterThan(0);
  });
});

describe("retargetClip", () => {
  it("is identity when source and target rest poses match", async () => {
    const rest: Record<number, [number, number, number, number]> = {
      8: rotationAxis("x", 20),
    };
    const animated = rotationAxis("z", 35);
    const source = skeletonDocument(DONOR_NAMES, [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13, 1, 15, 16, 1, 18, 19], {
      restRotation: rest,
      clip: { name: "Walk_Loop", target: 8, rotation: animated },
    });
    const target = skeletonDocument(AETHER_NAMES, [null, 0, 1, 2, 1, 4, 5, 6, 1, 8, 9, 10, 1, 12, 13, 1, 15, 16], {
      restRotation: { 5: rest[8]! },
    });

    await retargetClip(source, target, { clipName: "ual1/Walk_Loop" });
    const animation = target.getRoot().listAnimations().find((entry) => entry.getName() === "ual1/Walk_Loop")!;
    expect(animation).toBeTruthy();
    const upperArm = target.getRoot().listNodes().find((node) => node.getName() === "upper_arm.L")!;
    const channel = animation.listChannels().find((entry) => entry.getTargetNode() === upperArm)!;
    const values = channel.getSampler()!.getOutput()!.getArray()!;
    const expected = new Quaternion(...animated);
    let maxError = 0;
    for (let frame = 0; frame < values.length; frame += 4) {
      const actual = new Quaternion(values[frame]!, values[frame + 1]!, values[frame + 2]!, values[frame + 3]!).normalize();
      maxError = Math.max(maxError, angleBetween(actual, expected));
    }
    expect(maxError).toBeLessThan(0.1);
  });

  it("strips donor provenance and bakes every target joint", async () => {
    const source = skeletonDocument(DONOR_NAMES, [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13, 1, 15, 16, 1, 18, 19], {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 15) },
    });
    const target = skeletonDocument(AETHER_NAMES, [null, 0, 1, 2, 1, 4, 5, 6, 1, 8, 9, 10, 1, 12, 13, 1, 15, 16]);
    const result = await retargetClip(source, target, { clipName: "ual1/Walk_Loop" });
    expect(result.jointTracks).toBe(AETHER_NAMES.length);
    const animation = target.getRoot().listAnimations()[0]!;
    expect(animation.listChannels()).toHaveLength(AETHER_NAMES.length);
    for (const channel of animation.listChannels()) {
      const output = channel.getSampler()!.getOutput()!.getArray()!;
      expect(output.length).toBeGreaterThan(0);
      for (const value of output) expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("exported glb", () => {
  it("writes and reloads a retargeted clip", async () => {
    const source = skeletonDocument(DONOR_NAMES, [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13, 1, 15, 16, 1, 18, 19], {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 15) },
    });
    const target = skeletonDocument(AETHER_NAMES, [null, 0, 1, 2, 1, 4, 5, 6, 1, 8, 9, 10, 1, 12, 13, 1, 15, 16]);
    await retargetClip(source, target, { clipName: "ual1/Walk_Loop" });
    const bytes = await new NodeIO().writeBinary(target);
    const reloaded = await new NodeIO().readBinary(bytes);
    expect(reloaded.getRoot().listAnimations().map((entry) => entry.getName())).toContain("ual1/Walk_Loop");
    expect(reloaded.getRoot().listSkins()[0]?.listJoints()).toHaveLength(AETHER_NAMES.length);
  });
});

const DONOR_PARENTS = [null, 0, 1, 2, 3, 4, 5, 4, 7, 8, 9, 4, 11, 12, 13, 1, 15, 16, 1, 18, 19];
const AETHER_PARENTS = [null, 0, 1, 2, 1, 4, 5, 6, 1, 8, 9, 10, 1, 12, 13, 1, 15, 16];

describe("retarget integrity", () => {
  it("binds every emitted track to a target joint and leaves target rest translations untouched", async () => {
    const source = skeletonDocument(DONOR_NAMES, DONOR_PARENTS, {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 15) },
    });
    const target = skeletonDocument(AETHER_NAMES, AETHER_PARENTS);
    const before = new Map(target.getRoot().listNodes().map((node) => [node.getName(), [...node.getTranslation()]]));
    await retargetClip(source, target, { clipName: "ual1/Walk_Loop" });

    const joints = new Set(target.getRoot().listSkins()[0]!.listJoints());
    for (const animation of target.getRoot().listAnimations()) {
      for (const channel of animation.listChannels()) {
        expect(joints.has(channel.getTargetNode()!)).toBe(true);
      }
    }
    for (const node of target.getRoot().listNodes()) {
      const previous = before.get(node.getName());
      if (previous) expect([...node.getTranslation()]).toEqual(previous);
    }
  });

  it("copies a 15 degree axial roll, not only the limb direction", async () => {
    const neutral = skeletonDocument(DONOR_NAMES, DONOR_PARENTS, {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 0) },
    });
    const rolled = skeletonDocument(DONOR_NAMES, DONOR_PARENTS, {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 15) },
    });
    const neutralTarget = skeletonDocument(AETHER_NAMES, AETHER_PARENTS);
    const rolledTarget = skeletonDocument(AETHER_NAMES, AETHER_PARENTS);
    await retargetClip(neutral, neutralTarget, { clipName: "clip" });
    await retargetClip(rolled, rolledTarget, { clipName: "clip" });

    const localOf = (document: Document, name: string): Quaternion => {
      const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
      const animation = document.getRoot().listAnimations()[0]!;
      const channel = animation.listChannels().find((entry) => entry.getTargetNode() === node)!;
      const values = channel.getSampler()!.getOutput()!.getArray()!;
      return new Quaternion(values[0]!, values[1]!, values[2]!, values[3]!).normalize();
    };
    expect(angleBetween(localOf(neutralTarget, "upper_arm.L"), localOf(rolledTarget, "upper_arm.L"))).toBeGreaterThan(14);
  });

  it("scales donor root displacement to the target height", async () => {
    const source = skeletonDocument(DONOR_NAMES, DONOR_PARENTS, {
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("x", 15) },
      rootDelta: [0.5, 0, 0],
    });
    const target = skeletonDocument(AETHER_NAMES, AETHER_PARENTS);
    const result = await retargetClip(source, target, {
      clipName: "ual1/Walk_Loop",
      rootMotion: true,
      sourceHeight: 1,
      targetHeight: 2,
    });
    expect(result.rootDisplacement).toBeCloseTo(1, 4);
    const root = target.getRoot().listNodes().find((node) => node.getName() === "root")!;
    const animation = target.getRoot().listAnimations()[0]!;
    const channel = animation.listChannels().find((entry) => entry.getTargetNode() === root && entry.getTargetPath() === "translation")!;
    const values = channel.getSampler()!.getOutput()!.getArray()!;
    const last = values.length - 3;
    expect(values[last]!).toBeCloseTo(1, 4);
    expect(values[last + 1]!).toBeCloseTo(0, 4);
  });
});

describe("retarget world-space correction", () => {
  it("matches an independent forward-kinematics recomputation within 1 degree", async () => {
    const source = skeletonDocument(DONOR_NAMES, DONOR_PARENTS, {
      restRotation: { 8: rotationAxis("y", 40) },
      clip: { name: "Walk_Loop", target: 8, rotation: rotationAxis("z", 25) },
    });
    const target = skeletonDocument(AETHER_NAMES, AETHER_PARENTS, {
      restRotation: { 5: rotationAxis("x", -70) },
    });
    await retargetClip(source, target, { clipName: "ual1/Walk_Loop" });

    const sourceRest = new Quaternion(...rotationAxis("y", 40)).normalize();
    const targetRest = new Quaternion(...rotationAxis("x", -70)).normalize();
    const sourceAnimatedWorld = new Quaternion(...rotationAxis("z", 25)).normalize();
    const sourceRestWorld = sourceRest.clone();
    const expectedWorld = sourceAnimatedWorld
      .clone()
      .multiply(sourceRestWorld.clone().invert())
      .multiply(targetRest.clone());

    const animation = target.getRoot().listAnimations()[0]!;
    const channel = animation.listChannels().find(
      (entry) => entry.getTargetNode()?.getName() === "upper_arm.L" && entry.getTargetPath() === "rotation",
    )!;
    const values = channel.getSampler()!.getOutput()!.getArray()!;
    const local = new Quaternion(values[0]!, values[1]!, values[2]!, values[3]!).normalize();
    const upperArmParents = new Quaternion();
    for (const name of ["shoulder.L", "chest", "pelvis", "root"]) {
      const node = target.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
      upperArmParents.premultiply(new Quaternion(...(node.getRotation() as [number, number, number, number])).normalize());
    }
    const actualWorld = upperArmParents.multiply(local);
    expect(angleBetween(actualWorld, expectedWorld)).toBeLessThan(1);
  });
});
