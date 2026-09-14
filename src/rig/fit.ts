import type { BoneSegment, Vec3 } from "./weights.js";

export type Axis = "x" | "y" | "z";

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

export type JointName = string;

export interface TemplateJoint {
  name: JointName;
  parent: JointName | null;
}

/** 18-joint template: AETHER-compatible naming, reduced spine/neck/toe handling. */
export const TEMPLATE_JOINTS: readonly TemplateJoint[] = Object.freeze([
  { name: "root", parent: null },
  { name: "pelvis", parent: "root" },
  { name: "chest", parent: "pelvis" },
  { name: "head", parent: "chest" },
  { name: "shoulder.L", parent: "chest" },
  { name: "upper_arm.L", parent: "shoulder.L" },
  { name: "forearm.L", parent: "upper_arm.L" },
  { name: "hand.L", parent: "forearm.L" },
  { name: "shoulder.R", parent: "chest" },
  { name: "upper_arm.R", parent: "shoulder.R" },
  { name: "forearm.R", parent: "upper_arm.R" },
  { name: "hand.R", parent: "forearm.R" },
  { name: "thigh.L", parent: "pelvis" },
  { name: "shin.L", parent: "thigh.L" },
  { name: "foot.L", parent: "shin.L" },
  { name: "thigh.R", parent: "pelvis" },
  { name: "shin.R", parent: "thigh.R" },
  { name: "foot.R", parent: "shin.R" },
]);

export interface FittedJoint {
  name: JointName;
  parent: JointName | null;
  position: Vec3;
  inferred: boolean;
  ambiguous: boolean;
}

export interface FitOrientation {
  up: Axis;
  arm: Axis;
  facing: Axis;
  facingSign: 1 | -1;
}

export interface FitOptions {
  up?: Axis;
  arm?: Axis;
  facing?: Axis;
  facingSign?: 1 | -1;
  /** Explicit joint positions win over the geometry fit and are marked not inferred. */
  overrides?: Partial<Record<JointName, Vec3>>;
}

export interface FitResult {
  joints: FittedJoint[];
  orientation: FitOrientation;
  height: number;
  floor: number;
  ambiguities: string[];
  measure: {
    height: number;
    armSpan: number;
    facingExtent: number;
    armSpreadRatio: number;
    legSeparationRatio: number;
  };
}

interface Sample {
  up: number;
  arm: number;
  facing: number;
}

function axisMinMax(positions: Float32Array, axis: Axis): [number, number] {
  const index = AXIS_INDEX[axis];
  let min = Infinity;
  let max = -Infinity;
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    const value = positions[vertex + index]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

function detectOrientation(positions: Float32Array, options: FitOptions): FitOrientation {
  const up = options.up ?? "y";
  const horizontal = (["x", "y", "z"] as Axis[]).filter((axis) => axis !== up);
  const ranked = horizontal
    .map((axis) => {
      const [min, max] = axisMinMax(positions, axis);
      return { axis, extent: max - min };
    })
    .sort((left, right) => right.extent - left.extent);
  const arm = options.arm ?? ranked[0]!.axis;
  const facing = options.facing ?? horizontal.find((axis) => axis !== arm) ?? up;
  return { up, arm, facing, facingSign: options.facingSign ?? 1 };
}

function toSamples(positions: Float32Array, orientation: FitOrientation, center: Vec3): Sample[] {
  const count = Math.floor(positions.length / 3);
  const samples: Sample[] = new Array(count);
  for (let vertex = 0; vertex < count; vertex += 1) {
    samples[vertex] = {
      up: positions[vertex * 3 + AXIS_INDEX[orientation.up]]! - center[AXIS_INDEX[orientation.up]]!,
      arm:
        positions[vertex * 3 + AXIS_INDEX[orientation.arm]]! -
        center[AXIS_INDEX[orientation.arm]]!,
      facing:
        (positions[vertex * 3 + AXIS_INDEX[orientation.facing]]! -
          center[AXIS_INDEX[orientation.facing]]!) *
        orientation.facingSign,
    };
  }
  return samples;
}

function centroid(samples: readonly Sample[], filter: (sample: Sample) => boolean): Sample | null {
  let up = 0;
  let arm = 0;
  let facing = 0;
  let count = 0;
  for (const sample of samples) {
    if (!filter(sample)) continue;
    up += sample.up;
    arm += sample.arm;
    facing += sample.facing;
    count += 1;
  }
  if (count === 0) return null;
  return { up: up / count, arm: arm / count, facing: facing / count };
}

function toWorld(sample: Sample, orientation: FitOrientation, center: Vec3): Vec3 {
  const world: [number, number, number] = [0, 0, 0];
  world[AXIS_INDEX[orientation.up]] = center[AXIS_INDEX[orientation.up]]! + sample.up;
  world[AXIS_INDEX[orientation.arm]] = center[AXIS_INDEX[orientation.arm]]! + sample.arm;
  world[AXIS_INDEX[orientation.facing]] =
    center[AXIS_INDEX[orientation.facing]]! + sample.facing * orientation.facingSign;
  return world;
}

/** Bin centroids along one local axis; empty bins are skipped. */
function binCentroids(
  samples: readonly Sample[],
  key: (sample: Sample) => number,
  min: number,
  max: number,
  bins: number,
): Sample[] {
  const result: Sample[] = [];
  const width = (max - min) / bins;
  if (!(width > 0)) return result;
  for (let bin = 0; bin < bins; bin += 1) {
    const lo = min + bin * width;
    const hi = lo + width;
    const point = centroid(
      samples,
      (sample) => key(sample) >= lo && (bin === bins - 1 ? key(sample) <= hi : key(sample) < hi),
    );
    if (point) result.push(point);
  }
  return result;
}

// Math.max(...array) overflows the call stack once a mesh reaches a few hundred
// thousand vertices, which is well inside the supported vertex budget.
function extremum(
  samples: readonly Sample[],
  value: (sample: Sample) => number,
  pick: "min" | "max",
  seed: number,
): number {
  let best = seed;
  for (const sample of samples) {
    const candidate = value(sample);
    if (pick === "max" ? candidate > best : candidate < best) best = candidate;
  }
  return best;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export function fitBipedLandmarks(positions: Float32Array, options: FitOptions = {}): FitResult {
  const orientation = detectOrientation(positions, options);
  const upRange = axisMinMax(positions, orientation.up);
  const armRange = axisMinMax(positions, orientation.arm);
  const facingRange = axisMinMax(positions, orientation.facing);
  const center: [number, number, number] = [0, 0, 0];
  center[AXIS_INDEX[orientation.up]] = (upRange[0] + upRange[1]) / 2;
  center[AXIS_INDEX[orientation.arm]] = (armRange[0] + armRange[1]) / 2;
  center[AXIS_INDEX[orientation.facing]] = (facingRange[0] + facingRange[1]) / 2;
  const samples = toSamples(positions, orientation, center);
  const height = upRange[1] - upRange[0];
  const ambiguities: string[] = [];

  const maxArm = extremum(samples, (sample) => Math.abs(sample.arm), "max", 0);
  const armSpreadRatio = height > 0 ? (maxArm * 2) / height : 0;
  if (armSpreadRatio < 0.18) {
    ambiguities.push("arms are not separated from the torso; supply explicit arm landmarks");
  }

  const legBand = samples.filter((sample) => sample.up < -0.05 * height);
  const legGap = legBand.filter((sample) => Math.abs(sample.arm) < 0.02 * height).length;
  const legSeparationRatio = legBand.length > 0 ? 1 - legGap / legBand.length : 0;
  if (legBand.length > 0 && legSeparationRatio < 0.5) {
    ambiguities.push("legs are not separated below the hips; supply explicit leg landmarks");
  }

  // Arms live around the widest slice; legs are everything well below it.
  const armUp = samples.reduce(
    (best, sample) => (Math.abs(sample.arm) > Math.abs(best.arm) ? sample : best),
    samples[0] ?? { up: 0, arm: 0, facing: 0 },
  ).up;
  const torsoThreshold = 0.06 * height;

  const sideLandmarks = (sign: number) => {
    const side = samples.filter((sample) => sample.arm * sign > 0);
    const armSamples = side.filter(
      (sample) =>
        sample.arm * sign > torsoThreshold && Math.abs(sample.up - armUp) < 0.22 * height,
    );
    const reach =
      armSamples.length > 0
        ? extremum(armSamples, (s) => s.arm * sign, "max", Number.NEGATIVE_INFINITY)
        : 0;
    const armBins = armSamples.length > 0 ? binCentroids(armSamples, (s) => s.arm * sign, torsoThreshold, reach, 5) : [];
    const shoulder = armBins[0] ?? null;
    const hand = armBins[armBins.length - 1] ?? null;
    const elbow = armBins[Math.floor(armBins.length / 2)] ?? null;

    const legSamples = side.filter(
      (sample) => sample.arm * sign > torsoThreshold && sample.up < armUp - 0.18 * height,
    );
    const legBins = legSamples.length > 0
      ? binCentroids(
          legSamples,
          (s) => s.up,
          extremum(legSamples, (s) => s.up, "min", Number.POSITIVE_INFINITY),
          extremum(legSamples, (s) => s.up, "max", Number.NEGATIVE_INFINITY),
          4,
        )
      : [];
    const hip = legBins[legBins.length - 1] ?? null;
    const knee = legBins[Math.floor(legBins.length / 2)] ?? null;
    const foot = legBins[0] ?? null;
    return { shoulder, elbow, hand, hip, knee, foot };
  };

  const left = sideLandmarks(1);
  const right = sideLandmarks(-1);

  const averageSamples = (a: Sample | null, b: Sample | null): Sample | null =>
    a && b
      ? { up: (a.up + b.up) / 2, arm: (a.arm + b.arm) / 2, facing: (a.facing + b.facing) / 2 }
      : null;
  const pelvis = averageSamples(left.hip, right.hip);
  const chest = averageSamples(left.shoulder, right.shoulder);
  const head = centroid(samples, (sample) => sample.up > upRange[1] - center[AXIS_INDEX[orientation.up]]! - 0.12 * height);
  const floorSample: Sample = { up: upRange[0] - center[AXIS_INDEX[orientation.up]]!, arm: 0, facing: 0 };

  const joints: FittedJoint[] = [];
  const add = (name: JointName, sample: Sample | null, fallbackSample: Sample): void => {
    const override = options.overrides?.[name];
    const parent = TEMPLATE_JOINTS.find((entry) => entry.name === name)?.parent ?? null;
    if (override) {
      joints.push({ name, parent, position: override, inferred: false, ambiguous: false });
      return;
    }
    if (!sample) {
      ambiguities.push(`landmark ${name} could not be measured; supply it explicitly`);
      joints.push({
        name,
        parent,
        position: toWorld(fallbackSample, orientation, center),
        inferred: true,
        ambiguous: true,
      });
      return;
    }
    joints.push({ name, parent, position: toWorld(sample, orientation, center), inferred: true, ambiguous: false });
  };

  const fallback: Sample = floorSample;
  add("root", floorSample, fallback);
  add("pelvis", pelvis, fallback);
  add("chest", chest, fallback);
  add("head", head, fallback);
  add("shoulder.L", left.shoulder, fallback);
  add("upper_arm.L", left.shoulder, fallback);
  add("forearm.L", left.elbow, fallback);
  add("hand.L", left.hand, fallback);
  add("shoulder.R", right.shoulder, fallback);
  add("upper_arm.R", right.shoulder, fallback);
  add("forearm.R", right.elbow, fallback);
  add("hand.R", right.hand, fallback);
  add("thigh.L", left.hip, fallback);
  add("shin.L", left.knee, fallback);
  add("foot.L", left.foot, fallback);
  add("thigh.R", right.hip, fallback);
  add("shin.R", right.knee, fallback);
  add("foot.R", right.foot, fallback);

  return {
    joints: joints.map((joint) => ({
      ...joint,
      position: joint.position.map(round) as unknown as Vec3,
    })),
    orientation,
    height,
    floor: upRange[0],
    ambiguities,
    measure: {
      height: round(height),
      armSpan: round(armRange[1] - armRange[0]),
      facingExtent: round(facingRange[1] - facingRange[0]),
      armSpreadRatio: round(armSpreadRatio),
      legSeparationRatio: round(legSeparationRatio),
    },
  };
}

export function jointsToSegments(joints: readonly FittedJoint[]): BoneSegment[] {
  return joints.map((joint) => {
    const children = joints.filter((candidate) => candidate.parent === joint.name);
    const tail =
      children.length > 0
        ? children.reduce(
            (best, child) =>
              distanceSquared(child.position, joint.position) >
              distanceSquared(best.position, joint.position)
                ? child
                : best,
            children[0]!,
          ).position
        : joint.position;
    return { name: joint.name, head: joint.position, tail, parent: joint.parent } satisfies BoneSegment;
  });
}

function distanceSquared(left: Vec3, right: Vec3): number {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return dx * dx + dy * dy + dz * dz;
}
