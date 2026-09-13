import { Document, NodeIO, type Accessor } from "@gltf-transform/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAssetAutoRigHandler } from "../src/tools/rig.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-autorig-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bipedPositions(armAxis: "x" | "z"): number[] {
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
  return points;
}

async function unriggedBipedGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array(bipedPositions("x")))
    .setBuffer(buffer);
  const vertexCount = Math.floor(positions.getCount());
  const indices = new Uint16Array(Math.floor(vertexCount / 3) * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setIndices(document.createAccessor("indices").setType("SCALAR").setArray(indices).setBuffer(buffer)),
  );
  document.createScene("Scene").addChild(document.createNode("Body").setMesh(mesh));
  return await new NodeIO().writeBinary(document);
}

interface HandlerResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function call(handler: ReturnType<typeof createAssetAutoRigHandler>, input: unknown) {
  return (await handler(input as never)) as unknown as HandlerResult;
}

describe("asset_auto_rig", () => {
  it("fits, skins and publishes a smooth rig under the project root", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const output = join(directory, "rigged.glb");

    const result = await call(createAssetAutoRigHandler(), {
      target,
      output,
      projectRoot: directory,
      weightMode: "smooth",
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent;
    expect(structured.status).toBe("rigged");
    expect(structured.joints).toBe(18);
    expect(structured.skinnedVertices).toBeGreaterThan(0);
    expect((structured.diagnostics as { finite: boolean }).finite).toBe(true);
    expect((structured.diagnostics as { validJoints: boolean }).validJoints).toBe(true);
    expect(structured.maxNormalizationError as number).toBeLessThanOrEqual(1e-5);

    const reloaded = await new NodeIO().readBinary(new Uint8Array(await readFile(output)));
    expect(reloaded.getRoot().listSkins()[0]?.listJoints()).toHaveLength(18);
    expect(reloaded.getRoot().listSkins()[0]?.getInverseBindMatrices()).not.toBeNull();
    const primitive = reloaded.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(primitive.getAttribute("JOINTS_0")).not.toBeNull();
    expect(primitive.getAttribute("WEIGHTS_0")).not.toBeNull();
  });

  it("isolates the left hand from the right leg", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const output = join(directory, "rigged.glb");
    const result = await call(createAssetAutoRigHandler(), {
      target,
      output,
      projectRoot: directory,
      weightMode: "smooth",
    });
    expect(result.isError).toBeUndefined();

    const reloaded = await new NodeIO().readBinary(new Uint8Array(await readFile(output)));
    const primitive = reloaded.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const positions = primitive.getAttribute("POSITION")!.getArray()! as Float32Array;
    const joints = primitive.getAttribute("JOINTS_0")!.getArray()! as Uint16Array;
    const weights = primitive.getAttribute("WEIGHTS_0")!.getArray()! as Float32Array;
    const rightLeg = new Set([15, 16, 17]);
    let handVertex = 0;
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      if (positions[vertex * 3]! > positions[handVertex * 3]!) handVertex = vertex;
    }
    for (let slot = 0; slot < 4; slot += 1) {
      const bone = joints[handVertex * 4 + slot]!;
      const weight = weights[handVertex * 4 + slot]!;
      if (weight > 1e-6) expect(rightLeg.has(bone)).toBe(false);
    }
  });

  it("keeps rigid weights on one bone per region", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const output = join(directory, "rigged-rigid.glb");
    const result = await call(createAssetAutoRigHandler(), {
      target,
      output,
      projectRoot: directory,
      weightMode: "rigid",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.maxInfluences).toBe(1);

    const reloaded = await new NodeIO().readBinary(new Uint8Array(await readFile(output)));
    const primitive = reloaded.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const weights = primitive.getAttribute("WEIGHTS_0")!.getArray()! as Float32Array;
    for (let vertex = 0; vertex < weights.length / 4; vertex += 1) {
      expect(weights[vertex * 4]).toBe(1);
      expect(weights[vertex * 4 + 1]).toBe(0);
    }
  });

  it("returns a landmark correction request instead of a bad rig", async () => {
    const directory = await temporaryDirectory();
    const blob: number[] = [];
    for (let y = -0.5; y <= 0.5; y += 0.05) {
      for (let x = -0.05; x <= 0.05; x += 0.05) blob.push(x, y, 0);
    }
    const document = new Document();
    const buffer = document.createBuffer();
    const mesh = document.createMesh("Body").addPrimitive(
      document
        .createPrimitive()
        .setAttribute(
          "POSITION",
          document.createAccessor("positions").setType("VEC3").setArray(new Float32Array(blob)).setBuffer(buffer) as Accessor,
        ),
    );
    document.createScene("Scene").addChild(document.createNode("Body").setMesh(mesh));
    const target = join(directory, "blob.glb");
    await writeFile(target, await new NodeIO().writeBinary(document));

    const result = await call(createAssetAutoRigHandler(), {
      target,
      output: join(directory, "out.glb"),
      projectRoot: directory,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("needs-landmarks");
    expect((result.structuredContent.ambiguities as string[]).join(" ")).toContain(
      "arms are not separated",
    );
  });

  it("changes the rig when a landmark is revised", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const base = await call(createAssetAutoRigHandler(), {
      target,
      output: join(directory, "base.glb"),
      projectRoot: directory,
    });
    const revised = await call(createAssetAutoRigHandler(), {
      target,
      output: join(directory, "revised.glb"),
      projectRoot: directory,
      overrides: { "hand.L": [0.75, 0.25, 0] },
    });
    expect(base.isError).toBeUndefined();
    expect(revised.isError).toBeUndefined();
    expect(revised.structuredContent.sha256).not.toBe(base.structuredContent.sha256);
    const hand = (revised.structuredContent.landmarks as Array<{ name: string; position: number[]; inferred: boolean }>).find(
      (landmark) => landmark.name === "hand.L",
    );
    expect(hand?.position).toEqual([0.75, 0.25, 0]);
    expect(hand?.inferred).toBe(false);
  });

  it("refuses to replace an existing rig and conflicting output", async () => {
    const directory = await temporaryDirectory();
    const rigged = join(directory, "rigged.glb");
    const source = join(directory, "retopo.glb");
    await writeFile(source, await unriggedBipedGlb());
    await call(createAssetAutoRigHandler(), {
      target: source,
      output: rigged,
      projectRoot: directory,
    });

    const secondTarget = join(directory, "already-rigged.glb");
    await writeFile(secondTarget, new Uint8Array(await readFile(rigged)));
    const refused = await call(createAssetAutoRigHandler(), {
      target: secondTarget,
      output: join(directory, "other.glb"),
      projectRoot: directory,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("already has a rig");

    const conflict = await call(createAssetAutoRigHandler(), {
      target: source,
      output: rigged,
      projectRoot: directory,
      overrides: { "hand.L": [0.4, 0.3, 0] },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.text).toContain("RIG_OUTPUT_CONFLICT");
  });
});
