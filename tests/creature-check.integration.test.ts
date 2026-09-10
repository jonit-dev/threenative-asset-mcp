import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateClaimsMetrics } from "../src/creature/check.js";

const WYVERN_SPEC = {
  name: "task4_wyvern",
  style: "heavy",
  palette: {
    body: { color: "#26333a", rough: 0.82 },
    neck: { color: "#46545a", rough: 0.76 },
    leg: { color: "#303d42", rough: 0.8 },
    wing: { color: "#a9422f", rough: 0.72 },
  },
  joints: {
    Pelvis: [0, 1.02, -0.18],
    Breast: { from: "Pelvis", up: 0.34, fwd: 0.12 },
    NeckBase: { from: "Breast", up: 0.16, fwd: 0.08 },
    Head: { from: "NeckBase", up: 0.25, fwd: 0.2 },
    Jaw: { from: "Head", up: -0.02, fwd: 0.2 },
    LThigh: { from: "Pelvis", side: 0.14, up: -0.02, fwd: 0.02 },
    LShin: { from: "LThigh", side: 0.04, up: -0.43, fwd: 0.16 },
    LFoot: { from: "LShin", side: 0.015, up: -0.32, fwd: -0.1, ground: 0.04 },
  },
  chains: {
    torso: ["Pelvis", "Breast"],
    neck: ["NeckBase", "Head", "Jaw"],
    LLeg: ["LThigh", "LShin", "LFoot"],
  },
  attach: { neck: "Breast", LLeg: "Pelvis" },
  mirror: ["LLeg"],
  touch: [["torso", "neck"]],
  volumes: [
    {
      chain: "torso",
      material: "body",
      frame: "up",
      sides: 12,
      smooth_angle: 24,
      profile: [[0, 0.28, 0.25], [0.5, 0.4, 0.32], [1, 0.32, 0.28]],
      caps: ["dome", "dome"],
    },
    {
      chain: "neck",
      material: "neck",
      frame: "up",
      sides: 10,
      smooth_angle: 25,
      profile: [[0, 0.2, 0.18], [0.5, 0.22, 0.2], [1, 0.1, 0.09]],
      caps: ["none", "dome"],
    },
    {
      chain: "LLeg",
      material: "leg",
      sides: 9,
      smooth_angle: 28,
      profile: [[0, 0.11, 0.13], [0.4, 0.1, 0.11], [1, 0.05, 0.05]],
      caps: ["none", "dome"],
    },
  ],
  parts: [
    {
      type: "curve",
      name: "wing",
      host: "Breast",
      material: "wing",
      join: "insert",
      offset: [0, 0, 0],
      dir: [1, 0, 0],
      sides: 8,
      segments: [{ len: 0.3, r: 0.04 }],
      mirrored: true,
    },
  ],
  animations: {
    idle: {
      duration: 2.4,
      loop: true,
      tracks: {
        Pelvis: { ty: [[0, 0], [0.5, 0.01], [1, 0]] },
      },
    },
    move: {
      duration: 1.05,
      loop: true,
      mirror_phase: 0.5,
      tracks: {
        LThigh: { rx: [[0, 3], [0.5, -3], [1, 3]] },
        Pelvis: { ty: [[0, 0], [0.25, 0.025], [0.5, 0], [0.75, 0.025], [1, 0]] },
      },
    },
    attack: {
      duration: 0.82,
      loop: false,
      tracks: {
        Pelvis: { tz: [[0, 0], [0.22, -0.16], [0.5, 0.58], [0.78, 0.18], [1, 0]] },
        Jaw: { rx: [[0, 0], [0.32, 2], [0.52, -2], [1, 0]] },
      },
    },
  },
};

const temporaryDirectories: string[] = [];
let installedCommand = "";

function npm(args: readonly string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required for packed-package tests");
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "creature-check-package-"));
  temporaryDirectories.push(packageDirectory);
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", packageDirectory], resolve(".")),
  ) as Array<{ filename: string }>;
  const tarball = join(packageDirectory, packed[0]?.filename ?? "");
  const consumerDirectory = join(packageDirectory, "consumer");
  npm(
    ["install", "--ignore-scripts", "--no-package-lock", "--prefix", consumerDirectory, tarball],
    resolve("."),
  );
  installedCommand = join(consumerDirectory, "node_modules", ".bin", "threenative-asset-mcp");
  expect(existsSync(installedCommand)).toBe(true);
}, 30_000);

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function nextResponse(child: ChildProcessWithoutNullStreams, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}`)), 120_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          reject(new Error(`Non-JSON stdout from MCP: ${line}`));
          return;
        }
        if (message.id === id) {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          resolveResponse(message);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function startServer(projectRoot: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [installedCommand], {
    cwd: projectRoot,
    env: { ...process.env, XDG_CACHE_HOME: join(projectRoot, ".cache") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const initialized = nextResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "creature-check-integration", version: "1.0.0" },
    },
  });
  await initialized;
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  return child;
}

async function callTool(
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextResponse(child, id);
  send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
  return response;
}

function resultOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("MCP response has no result");
  return result as Record<string, unknown>;
}

function structured(response: Record<string, unknown>): Record<string, unknown> {
  const content = resultOf(response).structuredContent;
  if (typeof content !== "object" || content === null || Array.isArray(content)) throw new Error("MCP response has no structuredContent");
  return content as Record<string, unknown>;
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creature-check-project-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".threenative", "creatures"), { recursive: true });
  await writeFile(join(root, ".threenative", "creatures", "wyvern.json"), `${JSON.stringify(WYVERN_SPEC, null, 2)}\n`);
  return root;
}

async function compileWyvern(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  const response = await callTool(child, 2, "creature_compile", {
    specPath: ".threenative/creatures/wyvern.json",
    outputPath: "assets/creatures/wyvern.glb",
  });
  if (resultOf(response).isError) throw new Error(JSON.stringify(response, null, 2));
  return structured(response);
}

function parseGlb(raw: Buffer): { document: Record<string, unknown>; binary: Buffer } {
  const jsonLength = raw.readUInt32LE(12);
  const document = JSON.parse(raw.subarray(20, 20 + jsonLength).toString("utf8").replace(/[\0 ]+$/u, "")) as Record<string, unknown>;
  const binaryOffset = 20 + jsonLength;
  const binaryLength = raw.readUInt32LE(binaryOffset);
  return { document, binary: raw.subarray(binaryOffset + 8, binaryOffset + 8 + binaryLength) };
}

function packGlb(document: Record<string, unknown>, binary: Buffer): Buffer {
  let json = Buffer.from(JSON.stringify(document), "utf8");
  while (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.from(" ")]);
  let paddedBinary = binary;
  while (paddedBinary.length % 4 !== 0) paddedBinary = Buffer.concat([paddedBinary, Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + paddedBinary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binaryHeader, paddedBinary]);
}

async function stripAttack(source: string, destination: string): Promise<void> {
  const { document, binary } = parseGlb(await readFile(source));
  document.animations = (document.animations as Array<{ name?: string }>).filter((animation) => animation.name !== "attack");
  await writeFile(destination, packGlb(document, binary));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("creature_check installed MCP", () => {
  it("should return the original authored spec when it is embedded", async () => {
    const root = await createProject();
    const child = await startServer(root);
    try {
      const compiled = await compileWyvern(child);
      const response = await callTool(child, 3, "creature_check", {
        glbPath: compiled.outputPath,
        mode: "structural",
      });
      const output = structured(response);
      expect(resultOf(response).isError).not.toBe(true);
      expect(output).toMatchObject({
        operation: "creature_check",
        mode: "structural",
        passed: true,
        glbPath: compiled.outputPath,
        glbSha256: compiled.outputSha256,
        sourceSpec: WYVERN_SPEC,
        visualReview: "notReviewed",
      });
      expect(output.measurements).toMatchObject({
        vertices: expect.any(Number),
        faces: expect.any(Number),
        joints: expect.any(Number),
        materials: expect.objectContaining({ names: expect.arrayContaining(["body", "wing"]) }),
        clips: expect.arrayContaining(["idle", "move", "attack"]),
      });
      expect((output.structuralErrors as unknown[]).length).toBe(0);
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("should reject HIGH delivery when attack is missing", async () => {
    const root = await createProject();
    const child = await startServer(root);
    try {
      const compiled = await compileWyvern(child);
      const strippedPath = join(root, "assets", "creatures", "wyvern-no-attack.glb");
      await mkdir(join(root, "assets", "creatures"), { recursive: true });
      await stripAttack(join(root, compiled.outputPath as string), strippedPath);
      await writeFile(
        join(root, ".threenative", "creatures", "high-claims.json"),
        `${JSON.stringify({ claims: [{ type: "anim_named", names: ["idle", "move", "attack"], stage: "HIGH", enforce: "block", when: "verify" }] }, null, 2)}\n`,
      );
      const response = await callTool(child, 3, "creature_check", {
        glbPath: "assets/creatures/wyvern-no-attack.glb",
        mode: "claims",
        claimsPath: ".threenative/creatures/high-claims.json",
        stage: "HIGH",
      });
      const output = structured(response);
      expect(resultOf(response).isError).not.toBe(true);
      expect(output).toMatchObject({ operation: "creature_check", mode: "claims", passed: false, visualReview: "notReviewed" });
      expect(JSON.stringify(output)).toMatch(/attack/u);
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("should reject claims when a type is unknown or the selected stage is empty", async () => {
    const root = await createProject();
    const child = await startServer(root);
    try {
      const compiled = await compileWyvern(child);
      await writeFile(join(root, ".threenative", "creatures", "unknown.json"), `${JSON.stringify({ claims: [{ type: "misspelled_claim", stage: "MID" }] })}\n`);
      const unknown = await callTool(child, 3, "creature_check", { glbPath: compiled.outputPath, mode: "claims", claimsPath: ".threenative/creatures/unknown.json", stage: "MID" });
      expect(resultOf(unknown)).toMatchObject({ isError: true, structuredContent: { operation: "creature_check", code: "INVALID_CLAIMS" } });

      await writeFile(join(root, ".threenative", "creatures", "low-only.json"), `${JSON.stringify({ claims: [{ type: "tri_budget", min: 1, max: 999999, stage: "LOW" }] })}\n`);
      const empty = await callTool(child, 4, "creature_check", { glbPath: compiled.outputPath, mode: "claims", claimsPath: ".threenative/creatures/low-only.json", stage: "HIGH" });
      expect(resultOf(empty)).toMatchObject({ isError: true, structuredContent: { operation: "creature_check", code: "INVALID_CLAIMS" } });
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("should fail a required observation when its metric is missing", async () => {
    const root = await createProject();
    const child = await startServer(root);
    try {
      const compiled = await compileWyvern(child);
      await writeFile(join(root, ".threenative", "creatures", "low-claims.json"), `${JSON.stringify({ claims: [{ type: "tri_budget", min: 1, max: 999999, stage: "LOW" }] })}\n`);
      const response = await callTool(child, 3, "creature_check", { glbPath: compiled.outputPath, mode: "claims", claimsPath: ".threenative/creatures/low-claims.json", stage: "LOW" });
      const output = structured(response);
      expect(resultOf(response).isError).not.toBe(true);
      expect(output.passed).toBe(true);
      expect(output.observations).toBeDefined();
      const metricsPath = String(output.metricsPath);
      const metrics = JSON.parse(await readFile(join(root, metricsPath), "utf8")) as Record<string, unknown>;
      delete (metrics.stats as Record<string, unknown>).triangles;
      await writeFile(join(root, metricsPath), `${JSON.stringify(metrics)}\n`);
      expect(() => validateClaimsMetrics(metrics, [{ type: "tri_budget", min: 1, max: 999999, stage: "LOW" }])).toThrowError(
        expect.objectContaining({ code: "OUTPUT_INVALID", message: expect.stringContaining("stats.triangles") }),
      );
    } finally {
      await stopServer(child);
    }
  }, 120_000);
});
