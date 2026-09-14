import { Document, NodeIO } from "@gltf-transform/core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAssetAutoRigHandler } from "../src/tools/rig.js";
import { bipedPositions, unriggedBipedGlb } from "./helpers/rig-fixture.js";

const temporaryDirectories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-rig-cancel-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A biped dense enough that auto-rigging it stays in flight for several seconds. */
async function slowBipedGlb(vertexTarget: number): Promise<Uint8Array> {
  const base = bipedPositions("x");
  const repeats = Math.ceil((vertexTarget * 3) / base.length);
  const points = new Float32Array(base.length * repeats);
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const jitter = repeat * 1e-6;
    for (let index = 0; index < base.length; index += 3) {
      const offset = repeat * base.length + index;
      points[offset] = base[index]! + jitter;
      points[offset + 1] = base[index + 1]!;
      points[offset + 2] = base[index + 2]!;
    }
  }
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor("positions").setType("VEC3").setArray(points).setBuffer(buffer);
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

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Resolves when the server answers `id`; stays pending while the call is in flight. */
function response(child: ChildProcessWithoutNullStreams, id: number): Promise<unknown> {
  return new Promise((resolvePromise) => {
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number };
          if (parsed.id === id) resolvePromise(parsed);
        } catch {
          // Partial or non-JSON log line; the next chunk completes it.
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
  });
}

describe("rig output survives process cancellation", () => {
  it("keeps the prior output when the server is killed mid-auto-rig", async () => {
    const directory = await temporaryDirectory();
    const output = join(directory, "character.glb");

    // Establish a prior, valid output the cancelled run is allowed to replace.
    const small = join(directory, "retopo.glb");
    await writeFile(small, await unriggedBipedGlb());
    const prior = (await createAssetAutoRigHandler()({
      target: small,
      output,
      projectRoot: directory,
    } as never)) as unknown as { isError?: boolean; structuredContent: { sha256: string } };
    expect(prior.isError).toBeUndefined();
    const priorBytes = new Uint8Array(await readFile(output));
    const priorDigest = createHash("sha256").update(priorBytes).digest("hex");
    expect(priorDigest).toBe(prior.structuredContent.sha256);

    const slow = join(directory, "dense.glb");
    await writeFile(slow, await slowBipedGlb(1_500_000));

    const child = spawn(process.execPath, [resolve("dist/index.js")], {
      cwd: resolve("."),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.stderr.resume();

    const initialized = response(child, 1);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "rig-cancellation", version: "1.0.0" },
      },
    });
    await initialized;
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    let answered = false;
    void response(child, 2).then(() => {
      answered = true;
    });
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "asset_auto_rig",
        arguments: { target: slow, output, projectRoot: directory, priorDigest },
      },
    });

    await delay(1_000);
    // The point of the test is a kill *during* the call; a finished call proves nothing.
    expect(answered).toBe(false);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      delay(5_000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
    children.delete(child);

    // The prior output is byte-identical, and nothing half-written took its place.
    expect(new Uint8Array(await readFile(output))).toEqual(priorBytes);
    const reloaded = await new NodeIO().readBinary(new Uint8Array(await readFile(output)));
    expect(reloaded.getRoot().listSkins()[0]?.listJoints()).toHaveLength(18);
    const published = (await readdir(directory)).filter((entry) => entry.endsWith(".glb"));
    expect(published.sort()).toEqual(["character.glb", "dense.glb", "retopo.glb"]);
  }, 180_000);
});
