import { describe, expect, it } from "vitest";

import { fitBipedLandmarks } from "../src/rig/fit.js";
import {
  computeRigidWeights,
  computeSmoothWeights,
  connectedVertexComponents,
  diagnoseWeights,
  type BoneSegment,
} from "../src/rig/weights.js";

function biped(armAxis: "x" | "z"): Float32Array {
  const points: number[] = [];
  const put = (arm: number, y: number, other: number): void => {
    if (armAxis === "x") points.push(arm, y, other);
    else points.push(other, y, arm);
  };
  for (let y = -0.1; y <= 0.45; y += 0.05) put(0.01 * Math.sin(y * 10), y, 0.01 * Math.cos(y * 10));
  put(0, 0.5, 0);
  for (let arm = 0.05; arm <= 0.5; arm += 0.05) {
    put(arm, 0.3, 0);
    put(-arm, 0.3, 0);
  }
  for (let y = -0.1; y >= -0.5; y -= 0.05) {
    put(0.1, y, 0);
    put(-0.1, y, 0);
  }
  return new Float32Array(points);
}

const BONES: BoneSegment[] = [
  { name: "a", head: [0, 0, 0], tail: [1, 0, 0], parent: null },
  { name: "b", head: [10, 0, 0], tail: [11, 0, 0], parent: null },
];

describe("weights", () => {
  it("normalizes smooth weights to valid joints within 1e-5", () => {
    const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 10.2, 0, 0]);
    const weights = computeSmoothWeights(positions, BONES);
    const diagnostics = diagnoseWeights(weights, BONES.length);
    expect(diagnostics.finite).toBe(true);
    expect(diagnostics.nonNegative).toBe(true);
    expect(diagnostics.normalized).toBe(true);
    expect(diagnostics.validJoints).toBe(true);
    expect(diagnostics.maxInfluences).toBeLessThanOrEqual(4);
    expect(weights[0]?.influences[0]?.bone).toBe(0);
    expect(weights[2]?.influences[0]?.bone).toBe(1);
  });

  it("assigns a whole connected component to one bone with weight 1", () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0,
    ]);
    const first = connectedVertexComponents(6, new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(first[0]).toBe(first[2]);
    expect(first[0]).not.toBe(first[3]);
    const second = connectedVertexComponents(6, new Uint32Array([0, 1, 2, 2, 3, 4, 4, 5, 0]));
    expect(second[0]).toBe(second[5]);

    const rigid = computeRigidWeights(positions, BONES, first);
    for (const vertex of rigid) {
      expect(vertex.influences).toHaveLength(1);
      expect(vertex.influences[0]?.weight).toBe(1);
    }
    expect(rigid[0]?.influences[0]?.bone).toBe(0);
    expect(rigid[3]?.influences[0]?.bone).toBe(1);
  });
});

describe("fitBipedLandmarks", () => {
  it("fits an upright biped and finds the arm axis from geometry", () => {
    const fit = fitBipedLandmarks(biped("x"));
    expect(fit.orientation).toMatchObject({ up: "y", arm: "x", facing: "z" });
    expect(fit.ambiguities).toEqual([]);
    expect(fit.measure.height).toBeCloseTo(1, 3);
    expect(fit.measure.armSpreadRatio).toBeGreaterThan(0.9);

    const byName = new Map(fit.joints.map((joint) => [joint.name, joint]));
    expect(byName.get("hand.L")!.position[0]).toBeGreaterThan(
      byName.get("shoulder.L")!.position[0],
    );
    expect(byName.get("hand.R")!.position[0]).toBeLessThan(
      byName.get("shoulder.R")!.position[0],
    );
    expect(byName.get("thigh.L")!.position[1]).toBeLessThanOrEqual(
      byName.get("pelvis")!.position[1],
    );
    expect(byName.get("pelvis")!.position[1]).toBeLessThan(byName.get("chest")!.position[1]);
    for (const joint of fit.joints) expect(joint.parent === null || byName.has(joint.parent!)).toBe(true);
  });

  it("detects a rotated arm axis and keeps both sides apart", () => {
    const fit = fitBipedLandmarks(biped("z"));
    expect(fit.orientation.arm).toBe("z");
    const byName = new Map(fit.joints.map((joint) => [joint.name, joint]));
    expect(byName.get("hand.L")!.position[2]).toBeGreaterThan(0);
    expect(byName.get("hand.R")!.position[2]).toBeLessThan(0);
  });

  it("reports an ambiguity instead of inventing arms on a limbless blob", () => {
    const blob: number[] = [];
    for (let y = -0.5; y <= 0.5; y += 0.05) {
      for (let x = -0.05; x <= 0.05; x += 0.05) blob.push(x, y, 0);
    }
    const fit = fitBipedLandmarks(new Float32Array(blob));
    expect(fit.ambiguities.join(" ")).toContain("arms are not separated");
  });
});
