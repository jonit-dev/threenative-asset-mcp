export type Vec3 = readonly [number, number, number];

export interface BoneSegment {
  name: string;
  head: Vec3;
  tail: Vec3;
  parent: string | null;
}

export interface SkinInfluence {
  bone: number;
  weight: number;
}

export interface VertexWeights {
  influences: SkinInfluence[];
}

export interface WeightOptions {
  maxInfluences: number;
  /** Inverse-distance exponent: higher concentrates weight on the nearest bone. */
  power: number;
  epsilon: number;
}

export const DEFAULT_WEIGHT_OPTIONS: WeightOptions = Object.freeze({
  maxInfluences: 4,
  power: 2,
  epsilon: 1e-6,
});

export function distanceToSegment(point: Vec3, head: Vec3, tail: Vec3): number {
  const abx = tail[0] - head[0];
  const aby = tail[1] - head[1];
  const abz = tail[2] - head[2];
  const apx = point[0] - head[0];
  const apy = point[1] - head[1];
  const apz = point[2] - head[2];
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  const raw = lengthSquared > 0 ? (apx * abx + apy * aby + apz * abz) / lengthSquared : 0;
  const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
  const dx = point[0] - (head[0] + abx * t);
  const dy = point[1] - (head[1] + aby * t);
  const dz = point[2] - (head[2] + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function normalizeInfluences(influences: SkinInfluence[]): SkinInfluence[] {
  const total = influences.reduce((sum, influence) => sum + influence.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    return influences.length > 0 ? [{ bone: influences[0]!.bone, weight: 1 }] : [];
  }
  return influences.map((influence) => ({ bone: influence.bone, weight: influence.weight / total }));
}

/**
 * Up to four normalized influences from inverse segment distance. Pure and
 * allocation-bounded per vertex; no vertices x bones dense matrix is built.
 */
export function computeSmoothWeights(
  positions: Float32Array,
  bones: readonly BoneSegment[],
  options: WeightOptions = DEFAULT_WEIGHT_OPTIONS,
): VertexWeights[] {
  if (bones.length === 0) throw new Error("At least one bone is required.");
  const vertexCount = Math.floor(positions.length / 3);
  const result: VertexWeights[] = new Array(vertexCount);
  const distances: Array<{ bone: number; distance: number }> = new Array(bones.length);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point: Vec3 = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!];
    for (let bone = 0; bone < bones.length; bone += 1) {
      const segment = bones[bone]!;
      distances[bone] = { bone, distance: distanceToSegment(point, segment.head, segment.tail) };
    }
    distances.sort((left, right) => left.distance - right.distance);
    const chosen = distances.slice(0, Math.max(1, options.maxInfluences)).map((entry) => ({
      bone: entry.bone,
      weight: 1 / (Math.pow(entry.distance, options.power) + options.epsilon),
    }));
    result[vertex] = { influences: normalizeInfluences(chosen) };
  }
  return result;
}

/** Union-find over triangle indices: one component id per vertex. */
export function connectedVertexComponents(
  vertexCount: number,
  indices: Uint32Array | Uint16Array,
): Uint32Array {
  const parent = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) parent[index] = index;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = value;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index]!;
    const b = indices[index + 1]!;
    const c = indices[index + 2]!;
    union(a, b);
    union(b, c);
  }
  const components = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) components[index] = find(index);
  return components;
}

/**
 * Whole mechanical regions (connected components) move rigidly with one bone:
 * every vertex in a component takes weight 1 on the same bone, so triangle edge
 * lengths inside a component are preserved exactly under any bone transform.
 */
export function computeRigidWeights(
  positions: Float32Array,
  bones: readonly BoneSegment[],
  components: Uint32Array,
): VertexWeights[] {
  if (bones.length === 0) throw new Error("At least one bone is required.");
  const vertexCount = Math.floor(positions.length / 3);
  const sums = new Map<number, { x: number; y: number; z: number; count: number }>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const component = components[vertex] ?? vertex;
    const bucket = sums.get(component) ?? { x: 0, y: 0, z: 0, count: 0 };
    bucket.x += positions[vertex * 3]!;
    bucket.y += positions[vertex * 3 + 1]!;
    bucket.z += positions[vertex * 3 + 2]!;
    bucket.count += 1;
    sums.set(component, bucket);
  }
  const boneForComponent = new Map<number, number>();
  for (const [component, bucket] of sums) {
    const centroid: Vec3 = [bucket.x / bucket.count, bucket.y / bucket.count, bucket.z / bucket.count];
    let best = 0;
    let bestDistance = Infinity;
    for (let bone = 0; bone < bones.length; bone += 1) {
      const segment = bones[bone]!;
      const distance = distanceToSegment(centroid, segment.head, segment.tail);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bone;
      }
    }
    boneForComponent.set(component, best);
  }
  const result: VertexWeights[] = new Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const component = components[vertex] ?? vertex;
    result[vertex] = { influences: [{ bone: boneForComponent.get(component) ?? 0, weight: 1 }] };
  }
  return result;
}

export interface WeightDiagnostics {
  finite: boolean;
  nonNegative: boolean;
  normalized: boolean;
  maxNormalizationError: number;
  validJoints: boolean;
  maxInfluences: number;
}

export function diagnoseWeights(
  weights: readonly VertexWeights[],
  jointCount: number,
  tolerance = 1e-5,
): WeightDiagnostics {
  let finite = true;
  let nonNegative = true;
  let maxNormalizationError = 0;
  let validJoints = true;
  let maxInfluences = 0;
  for (const vertex of weights) {
    maxInfluences = Math.max(maxInfluences, vertex.influences.length);
    let sum = 0;
    for (const influence of vertex.influences) {
      if (!Number.isFinite(influence.weight)) finite = false;
      if (influence.weight < 0) nonNegative = false;
      if (!Number.isInteger(influence.bone) || influence.bone < 0 || influence.bone >= jointCount) {
        validJoints = false;
      }
      sum += influence.weight;
    }
    maxNormalizationError = Math.max(maxNormalizationError, Math.abs(sum - 1));
  }
  return {
    finite,
    nonNegative,
    validJoints,
    maxInfluences,
    maxNormalizationError,
    normalized: maxNormalizationError <= tolerance,
  };
}
