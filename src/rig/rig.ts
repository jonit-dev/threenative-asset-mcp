import { Document, type Node } from "@gltf-transform/core";

import { type FittedJoint, jointsToSegments } from "./fit.js";
import {
  computeRigidWeights,
  computeSmoothWeights,
  connectedVertexComponents,
  DEFAULT_WEIGHT_OPTIONS,
  diagnoseWeights,
  type VertexWeights,
} from "./weights.js";

export interface AutoRigOptions {
  weightMode: "smooth" | "rigid";
  maxInfluences?: number;
}

export interface AutoRigDiagnostics {
  weightMode: "smooth" | "rigid";
  joints: number;
  skinnedPrimitives: number;
  skinnedVertices: number;
  maxInfluences: number;
  maxNormalizationError: number;
  finite: boolean;
  nonNegative: boolean;
  validJoints: boolean;
}

function inverseBindMatrix(position: readonly [number, number, number]): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  matrix[12] = -position[0];
  matrix[13] = -position[1];
  matrix[14] = -position[2];
  return matrix;
}

/**
 * Add an 18-joint skin to an unrigged document in place. Joints are pure
 * translations in bind pose, so a joint's world position is its rest position
 * and the inverse-bind matrix is its negated translation.
 */
export function skinDocument(
  document: Document,
  joints: readonly FittedJoint[],
  options: AutoRigOptions,
): AutoRigDiagnostics {
  const root = document.getRoot();
  const segments = jointsToSegments(joints);
  const buffer = root.listBuffers()[0] ?? document.createBuffer();

  const jointNodes = new Map<string, Node>();
  for (const joint of joints) jointNodes.set(joint.name, document.createNode(joint.name));

  const positionByName = new Map(joints.map((joint) => [joint.name, joint.position]));
  for (const joint of joints) {
    const parentPosition = joint.parent ? positionByName.get(joint.parent)! : ([0, 0, 0] as const);
    jointNodes
      .get(joint.name)!
      .setTranslation([
        joint.position[0] - parentPosition[0],
        joint.position[1] - parentPosition[1],
        joint.position[2] - parentPosition[2],
      ]);
  }
  for (const joint of joints) {
    if (joint.parent) jointNodes.get(joint.parent)!.addChild(jointNodes.get(joint.name)!);
  }

  const inverseBind = new Float32Array(joints.length * 16);
  joints.forEach((joint, index) => {
    inverseBind.set(inverseBindMatrix(joint.position), index * 16);
  });
  const skin = document
    .createSkin("Rig")
    .setInverseBindMatrices(
      document.createAccessor("inverseBind").setType("MAT4").setArray(inverseBind).setBuffer(buffer),
    );
  for (const joint of joints) skin.addJoint(jointNodes.get(joint.name)!);

  const scene = root.listScenes()[0] ?? document.createScene("Scene");
  const rootJoint = joints.find((joint) => joint.parent === null) ?? joints[0]!;
  scene.addChild(jointNodes.get(rootJoint.name)!);

  let skinnedPrimitives = 0;
  let skinnedVertices = 0;
  let maxInfluences = 0;
  let maxNormalizationError = 0;
  let finite = true;
  let nonNegative = true;
  let validJoints = true;

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const array = position?.getArray();
      if (!position || !array) continue;
      const positions = array instanceof Float32Array ? array : Float32Array.from(array);
      const vertexCount = Math.floor(positions.length / 3);

      let weights: VertexWeights[];
      if (options.weightMode === "rigid") {
        const indexAccessor = primitive.getIndices();
        const indexArray = indexAccessor?.getArray();
        const indices = indexArray
          ? Uint32Array.from(indexArray)
          : Uint32Array.from({ length: vertexCount }, (_, value) => value);
        weights = computeRigidWeights(positions, segments, connectedVertexComponents(vertexCount, indices));
      } else {
        weights = computeSmoothWeights(positions, segments, {
          ...DEFAULT_WEIGHT_OPTIONS,
          maxInfluences: options.maxInfluences ?? DEFAULT_WEIGHT_OPTIONS.maxInfluences,
        });
      }

      const jointIndices = new Uint16Array(vertexCount * 4);
      const vertexWeights = new Float32Array(vertexCount * 4);
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const influences = weights[vertex]!.influences;
        for (let slot = 0; slot < 4; slot += 1) {
          const influence = influences[slot];
          jointIndices[vertex * 4 + slot] = influence ? influence.bone : 0;
          vertexWeights[vertex * 4 + slot] = influence ? influence.weight : 0;
        }
      }
      primitive.setAttribute(
        "JOINTS_0",
        document
          .createAccessor(`${mesh.getName()}-joints`)
          .setType("VEC4")
          .setArray(jointIndices)
          .setBuffer(buffer),
      );
      primitive.setAttribute(
        "WEIGHTS_0",
        document
          .createAccessor(`${mesh.getName()}-weights`)
          .setType("VEC4")
          .setArray(vertexWeights)
          .setBuffer(buffer),
      );

      const diagnostics = diagnoseWeights(weights, joints.length);
      finite &&= diagnostics.finite;
      nonNegative &&= diagnostics.nonNegative;
      validJoints &&= diagnostics.validJoints;
      maxInfluences = Math.max(maxInfluences, diagnostics.maxInfluences);
      maxNormalizationError = Math.max(maxNormalizationError, diagnostics.maxNormalizationError);
      skinnedPrimitives += 1;
      skinnedVertices += vertexCount;
    }
  }

  for (const node of root.listNodes()) {
    if (node.getMesh()) node.setSkin(skin);
  }

  return {
    weightMode: options.weightMode,
    joints: joints.length,
    skinnedPrimitives,
    skinnedVertices,
    maxInfluences,
    maxNormalizationError,
    finite,
    nonNegative,
    validJoints,
  };
}
