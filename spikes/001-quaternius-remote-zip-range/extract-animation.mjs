#!/usr/bin/env node

import { NodeIO } from "@gltf-transform/core";
import { stat } from "node:fs/promises";

const input = process.argv[2] ?? "/tmp/threenative-asset-spike/ual1-standard.glb";
const requested = process.argv[3];
const output = process.argv[4] ?? "/tmp/threenative-asset-spike/ual1-single-animation.glb";
const animationOnly = process.argv.includes("--animation-only");

const io = new NodeIO();
const document = await io.read(input);
const animations = document.getRoot().listAnimations();

if (!requested) {
  console.log(
    JSON.stringify(
      {
        input,
        animationCount: animations.length,
        animations: animations.map((animation, index) => ({
          index,
          name: animation.getName(),
          channels: animation.listChannels().length,
          samplers: animation.listSamplers().length,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const selected = animations.find(
  (animation, index) => animation.getName() === requested || String(index) === requested,
);
if (!selected) {
  throw new Error(`Animation not found: ${requested}`);
}
const retainedAccessors = new Set(
  selected
    .listSamplers()
    .flatMap((sampler) => [sampler.getInput(), sampler.getOutput()])
    .filter(Boolean),
);
const discardedAccessors = new Set();
for (const animation of animations) {
  if (animation === selected) continue;
  for (const sampler of animation.listSamplers()) {
    const inputAccessor = sampler.getInput();
    const outputAccessor = sampler.getOutput();
    if (inputAccessor) discardedAccessors.add(inputAccessor);
    if (outputAccessor) discardedAccessors.add(outputAccessor);
  }
  animation.dispose();
}
for (const accessor of discardedAccessors) {
  if (!retainedAccessors.has(accessor)) accessor.dispose();
}
if (animationOnly) {
  for (const node of document.getRoot().listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }
  for (const mesh of document.getRoot().listMeshes()) mesh.dispose();
  for (const material of document.getRoot().listMaterials()) material.dispose();
  for (const texture of document.getRoot().listTextures()) texture.dispose();
  for (const camera of document.getRoot().listCameras()) camera.dispose();
}
for (const accessor of document.getRoot().listAccessors()) {
  if (!retainedAccessors.has(accessor)) accessor.dispose();
}
await io.write(output, document);
const [inputStat, outputStat] = await Promise.all([stat(input), stat(output)]);
console.log(
  JSON.stringify(
    {
      selected: selected.getName(),
      output,
      inputBytes: inputStat.size,
      outputBytes: outputStat.size,
      retainedAnimationCount: document.getRoot().listAnimations().length,
      animationOnly,
      sizeRatio: Number((outputStat.size / inputStat.size).toFixed(6)),
    },
    null,
    2,
  ),
);
