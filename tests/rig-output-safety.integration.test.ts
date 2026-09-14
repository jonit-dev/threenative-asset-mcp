import { Document, NodeIO } from "@gltf-transform/core";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { publishOutput } from "../src/rig/publish.js";
import { createAssetAutoRigHandler } from "../src/tools/rig.js";
import { bipedPositions, unriggedBipedGlb } from "./helpers/rig-fixture.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-rig-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface HandlerResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function autoRig(input: unknown): Promise<HandlerResult> {
  return (await createAssetAutoRigHandler()(input as never)) as unknown as HandlerResult;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A biped whose vertex count is large enough to overflow a spread-based extremum. */
async function denseBipedGlb(step: number): Promise<Uint8Array> {
  const points: number[] = [];
  const base = bipedPositions("x");
  const repeats = Math.ceil(step / base.length) * 3;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const jitter = repeat * 1e-6;
    for (let index = 0; index < base.length; index += 3) {
      points.push(base[index]! + jitter, base[index + 1]!, base[index + 2]!);
    }
  }
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array(points))
    .setBuffer(buffer);
  const vertexCount = positions.getCount();
  const indices = new Uint32Array(Math.floor(vertexCount / 3) * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setIndices(document.createAccessor("indices").setType("SCALAR").setArray(indices).setBuffer(buffer)),
  );
  document.createScene("Scene").addChild(document.createNode("Body").setMesh(mesh));
  return await new NodeIO().writeBinary(document);
}

async function partFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.includes(".part-"));
}

describe("rig output safety", () => {
  it("fits a mesh far larger than a spread-based extremum can hold", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "dense.glb");
    // 300k vertices: inside the 8M vertex budget, past the argument limit of
    // `Math.max(...array)`, which used to surface as an opaque RIG_INTERNAL.
    await writeFile(target, await denseBipedGlb(300_000));
    const output = join(directory, "dense-rigged.glb");

    const result = await autoRig({ target, output, projectRoot: directory });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("rigged");
    expect(result.structuredContent.joints).toBe(18);
    expect(result.structuredContent.skinnedVertices as number).toBeGreaterThan(250_000);
  }, 120_000);

  it("keeps the prior output when validation fails after it exists", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "retopo.glb");
    await writeFile(source, await unriggedBipedGlb());
    const output = join(directory, "rigged.glb");
    const first = await autoRig({ target: source, output, projectRoot: directory });
    expect(first.isError).toBeUndefined();
    const before = new Uint8Array(await readFile(output));

    const broken = join(directory, "broken.glb");
    await writeFile(broken, new Uint8Array([1, 2, 3, 4]));
    const failed = await autoRig({ target: broken, output, projectRoot: directory });

    expect(failed.isError).toBe(true);
    expect(new Uint8Array(await readFile(output))).toEqual(before);
    expect(await partFiles(directory)).toEqual([]);
  });

  it("refuses a conflicting write, preserves the prior bytes and replaces on the prior digest", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "retopo.glb");
    await writeFile(source, await unriggedBipedGlb());
    const output = join(directory, "rigged.glb");
    const first = await autoRig({ target: source, output, projectRoot: directory });
    expect(first.isError).toBeUndefined();
    const priorDigest = first.structuredContent.sha256 as string;
    const before = new Uint8Array(await readFile(output));
    expect(digest(before)).toBe(priorDigest);

    const conflicting = {
      target: source,
      output,
      projectRoot: directory,
      overrides: { "hand.L": [0.42, 0.31, 0] },
    };
    const refused = await autoRig(conflicting);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("RIG_OUTPUT_CONFLICT");
    expect(new Uint8Array(await readFile(output))).toEqual(before);
    expect(await partFiles(directory)).toEqual([]);

    const replaced = await autoRig({ ...conflicting, priorDigest });
    expect(replaced.isError).toBeUndefined();
    expect(replaced.structuredContent.replaced).toBe(true);
    const after = new Uint8Array(await readFile(output));
    expect(after).not.toEqual(before);
    expect(digest(after)).toBe(replaced.structuredContent.sha256);
    expect(await partFiles(directory)).toEqual([]);
  }, 60_000);

  it("refuses an output outside the project root and writes nothing there", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const source = join(directory, "retopo.glb");
    await writeFile(source, await unriggedBipedGlb());
    const escaped = join(outside, "escaped.glb");

    const result = await autoRig({
      target: source,
      output: join(directory, "..", resolve(escaped)),
      projectRoot: directory,
    });

    expect(result.isError).toBe(true);
    await expect(stat(escaped)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it("lets exactly one of two simultaneous writers publish a fresh output", async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, "raced.glb");
    const left = new Uint8Array(Buffer.from("left bytes for the raced output"));
    const right = new Uint8Array(Buffer.from("right bytes for the raced output"));

    const results = await Promise.allSettled([
      publishOutput({ projectRoot: directory, outputPath: output, bytes: left }),
      publishOutput({ projectRoot: directory, outputPath: output, bytes: right }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as { code?: string }).code).toBe(
      "RIG_OUTPUT_CONFLICT",
    );

    const published = (fulfilled[0] as PromiseFulfilledResult<{ sha256: string }>).value;
    const bytes = new Uint8Array(await readFile(output));
    expect(digest(bytes)).toBe(published.sha256);
    expect([digest(left), digest(right)]).toContain(digest(bytes));
    expect(await partFiles(directory)).toEqual([]);
  });
});
