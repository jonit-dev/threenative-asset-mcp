import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreatureRunner } from "../src/creature/runner.js";

const WYVERN_SPEC = {
  name: "ember_crown_wyvern",
  height: 2.56,
  style: "heavy",
  palette: {
    torso_scale: { color: "#26333a", rough: 0.82 },
    throat_scale: { color: "#46545a", rough: 0.76 },
    tail_scale: { color: "#1d292f", rough: 0.84 },
    leg_scale: { color: "#303d42", rough: 0.8 },
    wing_membrane: { color: "#a9422f", rough: 0.72 },
    crown_horn: { color: "#d9b66f", rough: 0.48 },
    jaw_plate: { color: "#714033", rough: 0.7 },
    eye_ember: { color: "#ffb21f", rough: 0.2 },
  },
  shading: {
    pattern: { color: "#66747a", sharpness: 0.62, amount: 0.34, scale: 0.055 },
    ramp: { bottom: "#0d1519", mid: "#34434a", top: "#7b8585", pm: 0.35, wm: 0.09 },
  },
  smooth_angle: 28,
  joints: {
    Pelvis: [0, 1.03, -0.28],
    Midback: { from: "Pelvis", up: 0.19, fwd: 0.23 },
    Breast: { from: "Midback", up: 0.27, fwd: 0.2 },
    Withers: { from: "Breast", up: 0.16, fwd: 0.08 },
    NeckBase: { from: "Withers", up: 0.116, fwd: 0.09 },
    NeckCrest: { from: "NeckBase", up: 0.14, fwd: 0.13 },
    Cranium: { from: "NeckCrest", up: 0.04, fwd: 0.2 },
    Jaw: { from: "Cranium", up: -0.1, fwd: 0.24 },
    Snout: { from: "Jaw", up: 0.015, fwd: 0.3 },
    TailSocket: { from: "Pelvis", up: 0.02, fwd: -0.124 },
    TailA: { from: "TailSocket", up: 0.06, fwd: -0.32 },
    TailB: { from: "TailA", up: 0.03, fwd: -0.38 },
    TailC: { from: "TailB", up: -0.08, fwd: -0.36 },
    TailD: { from: "TailC", up: -0.13, fwd: -0.31 },
    TailBlade: { from: "TailD", up: -0.1, fwd: -0.27 },
    LThigh: { from: "Pelvis", side: 0.135, up: -0.014, fwd: 0.01 },
    LShin: { from: "LThigh", side: 0.04, up: -0.43, fwd: 0.17 },
    LAnkle: { from: "LShin", side: 0.015, up: -0.34, fwd: -0.12 },
    LFoot: { from: "LAnkle", side: 0.01, fwd: 0.24, ground: 0.04 },
  },
  chains: {
    torso: ["Pelvis", "Midback", "Breast", "Withers"],
    neck: ["NeckBase", "NeckCrest", "Cranium", "Jaw", "Snout"],
    tail: ["TailSocket", "TailA", "TailB", "TailC", "TailD", "TailBlade"],
    LLeg: ["LThigh", "LShin", "LAnkle", "LFoot"],
  },
  attach: { neck: "Withers", tail: "Pelvis", LLeg: "Pelvis" },
  mirror: ["LLeg"],
  touch: [["torso", "neck"], ["torso", "tail"]],
  volumes: [
    {
      chain: "torso",
      material: "torso_scale",
      frame: "up",
      sides: 12,
      smooth_angle: 24,
      profile: [[0, 0.3, 0.27], [0.28, 0.31, 0.29], [0.72, 0.36, 0.34], [1, 0.3, 0.28]],
      caps: ["dome", "dome"],
    },
    {
      chain: "neck",
      material: "throat_scale",
      frame: "up",
      sides: 10,
      smooth_angle: 25,
      profile: [[0, 0.2, 0.19], [0.34, 0.17, 0.18], [0.67, 0.25, 0.2], [0.84, 0.18, 0.14], [1, 0.09, 0.075]],
      caps: ["none", "dome"],
    },
    {
      chain: "tail",
      material: "tail_scale",
      sides: 9,
      smooth_angle: 28,
      profile: [[0, 0.18, 0.17], [0.22, 0.155, 0.145], [0.55, 0.11, 0.1], [0.82, 0.065, 0.06], [1, 0.025, 0.022]],
      caps: ["none", "dome"],
    },
    {
      chain: "LLeg",
      material: "leg_scale",
      sides: 9,
      smooth_angle: 28,
      profile: [[0, 0.095, 0.13], [0.38, 0.105, 0.12], [0.74, 0.08, 0.085], [1, 0.055, 0.045]],
      caps: ["none", "dome"],
    },
  ],
  parts: [
    {
      type: "fin",
      name: "swept_wing",
      host: "Withers",
      material: "wing_membrane",
      thickness: 0.035,
      conform: false,
      anchor: { chain: "torso", t: 0.86, around: 62 },
      udir: [0.94, 0.25, -0.22],
      vdir: [-0.12, 0.48, -0.88],
      points: [[-0.05, -0.04], [0.48, 0.08], [1.18, 0.42], [0.92, -0.2], [0.34, -0.38], [0.02, -0.17]],
      mirrored: true,
    },
    {
      type: "curve",
      name: "brow_horn",
      host: "Cranium",
      material: "crown_horn",
      join: "place",
      offset: [0.11, 0.12, 0.015],
      dir: [0.3, 0.72, -0.15],
      sides: 8,
      segments: [{ len: 0.18, r: 0.055, rise: 18 }, { len: 0.16, r: 0.038, behind: 24 }, { len: 0.11, r: 0.018, taper: true }],
      mirrored: true,
    },
    {
      type: "fin",
      name: "lower_jaw_keel",
      host: "Jaw",
      material: "jaw_plate",
      thickness: 0.025,
      conform: false,
      anchor: { chain: "neck", t: 0.77, around: 178 },
      udir: [0, 0, 1],
      vdir: [0, -1, 0],
      points: [[-0.04, 0], [0.28, -0.01], [0.2, -0.15], [0.03, -0.12]],
    },
    {
      type: "eye",
      host: "Cranium",
      material: "eye_ember",
      size: 0.042,
      anchor: { chain: "neck", t: 0.68, around: 62 },
    },
    {
      type: "paw",
      toes: 3,
      host: "LFoot",
      material: "leg_scale",
      size: [0.3, 0.22, 0.12],
      mirrored: true,
    },
  ],
  animations: {
    idle: {
      duration: 2.4,
      loop: true,
      tracks: {
        NeckBase: { rx: [[0, -3], [0.5, 4], [1, -3]] },
        Cranium: { rx: [[0, 2], [0.5, -3], [1, 2]] },
        TailA: { ry: [[0, -8], [0.5, 9], [1, -8]] },
        TailC: { ry: [[0, 7], [0.5, -10], [1, 7]] },
      },
    },
    move: {
      duration: 1.05,
      loop: true,
      mirror_phase: 0.5,
      tracks: {
        LThigh: { rx: [[0, 10], [0.5, -12], [1, 10]] },
        Pelvis: { ty: [[0, 0], [0.25, 0.025], [0.5, 0], [0.75, 0.025], [1, 0]] },
        TailB: { ry: [[0, 6], [0.5, -7], [1, 6]] },
      },
    },
    attack: {
      duration: 0.82,
      loop: false,
      tracks: {
        Pelvis: { tz: [[0, 0], [0.22, -0.16], [0.5, 0.58], [0.78, 0.18], [1, 0]] },
        Breast: { rx: [[0, 0], [0.22, -10], [0.5, 17], [1, 0]] },
        Jaw: { rx: [[0, 0], [0.32, 14], [0.52, -18], [1, 0]] },
        TailA: { ry: [[0, 0], [0.25, 14], [0.55, -11], [1, 0]] },
      },
    },
  },
};

const temporaryDirectories: string[] = [];
let installedCommand = "";

function npm(args: readonly string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required for packed-package tests");
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "creature-compile-package-"));
  temporaryDirectories.push(packageDirectory);
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", packageDirectory], resolve(".")),
  ) as Array<{ filename: string }>;
  const tarball = join(packageDirectory, packed[0]?.filename ?? "");
  const consumerDirectory = join(packageDirectory, "consumer");
  npm(["install", "--ignore-scripts", "--no-package-lock", "--prefix", consumerDirectory, tarball], resolve("."));
  installedCommand = join(consumerDirectory, "node_modules", ".bin", "threenative-asset-mcp");
  expect(existsSync(installedCommand)).toBe(true);
}, 30_000);

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function nextResponse(child: ChildProcessWithoutNullStreams, id: number, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}`)), timeoutMs);
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

async function startServer(projectRoot: string): Promise<{ child: ChildProcessWithoutNullStreams; stdout: string[] }> {
  const child = spawn(process.execPath, [installedCommand], {
    cwd: projectRoot,
    env: { ...process.env, XDG_CACHE_HOME: join(projectRoot, ".cache") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  const initialized = nextResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "creature-integration", version: "1.0.0" } },
  });
  await initialized;
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  return { child, stdout };
}

async function callTool(
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextResponse(child, id, 90_000);
  send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
  return response;
}

function structured(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("MCP response has no result");
  const content = (result as Record<string, unknown>).structuredContent;
  if (typeof content !== "object" || content === null || Array.isArray(content)) throw new Error("MCP response has no structuredContent");
  return content as Record<string, unknown>;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function glbDocument(bytes: Buffer): Record<string, unknown> {
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(
    bytes.subarray(20, 20 + jsonLength).toString("utf8").replace(/[\0 ]+$/u, ""),
  ) as Record<string, unknown>;
}

function cloneSpec(): Record<string, unknown> {
  return structuredClone(WYVERN_SPEC) as unknown as Record<string, unknown>;
}

function reviseWing(spec: Record<string, unknown>, color: string): void {
  const palette = spec.palette as Record<string, { color: string }>;
  const wing = palette.wing_membrane;
  if (!wing) throw new Error("wyvern fixture has no wing material");
  wing.color = color;
}

async function waitForCompilerChild(serverPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  const childrenPath = `/proc/${serverPid}/task/${serverPid}/children`;
  while (Date.now() < deadline) {
    const children = (await readFile(childrenPath, "utf8").catch(() => ""))
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number);
    const child = children.find((pid) => Number.isInteger(pid) && pid > 0);
    if (child) return child;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  throw new Error("Did not observe the fixed compiler subprocess");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Compiler process ${pid} survived cancellation`);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function createScaffold(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creature-clean-scaffold-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".threenative", "creatures"), { recursive: true });
  await mkdir(join(root, "assets", "creatures"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "creature-proof", private: true }));
  return root;
}

describe("creature_compile installed MCP", () => {
  it("compiles the original three-clip wyvern through the installed bin", async () => {
    const root = await createScaffold();
    const specPath = join(root, ".threenative", "creatures", "wyvern.json");
    await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
    const { child, stdout } = await startServer(root);

    try {
      const status = structured(await callTool(child, 2, "creature_status", {}));
      expect(status).toMatchObject({
        operations: { creature_compile: { available: true } },
        limits: {
          specBytes: 262_144,
          glbBytes: 33_554_432,
          diagnosticsBytes: 1_048_576,
          compileTimeoutMs: 60_000,
          maxActiveHeavyOperations: 1,
        },
      });

      const response = await callTool(child, 3, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      });

      if ((response.result as { isError?: boolean } | undefined)?.isError) {
        throw new Error(JSON.stringify(response, null, 2));
      }

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            operation: "creature_compile",
            specPath: ".threenative/creatures/wyvern.json",
            outputPath: "assets/creatures/wyvern.glb",
            payload: {
              version: "1.3.1",
              commit: "44e1abc2c7fe083f19f989c8437c44a141adc7f3",
              archiveSha256: "cc25c9a9c170d43741803d5531f853bc89ebfd58a98d9fdda90834c53822084d",
            },
            measurements: {
              clips: ["idle", "move", "attack"],
              bytes: expect.any(Number),
              joints: expect.any(Number),
              vertices: expect.any(Number),
              faces: expect.any(Number),
            },
            inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            checksSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            receiptPath: expect.stringContaining(".threenative/creatures/receipts/"),
          },
        },
      });
      const first = structured(response);
      const firstGlb = await readFile(join(root, "assets", "creatures", "wyvern.glb"));
      expect(firstGlb.subarray(0, 4).toString()).toBe("glTF");
      expect(glbDocument(firstGlb)).toMatchObject({
        asset: { extras: { source_spec: WYVERN_SPEC } },
      });
      const receipt = JSON.parse(await readFile(join(root, first.receiptPath as string), "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        inputSha256: hash(await readFile(specPath)),
        outputSha256: hash(firstGlb),
        checksSha256: first.checksSha256,
        measurements: first.measurements,
      });
      expect(hash(await readFile(join(root, first.sourceSnapshotPath as string)))).toBe(first.inputSha256);

      const revised = cloneSpec();
      reviseWing(revised, "#d6653a");
      await writeFile(specPath, JSON.stringify(revised, null, 2));
      const revision = structured(await callTool(child, 4, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
        expectedOutputSha256: first.outputSha256,
      }));
      expect(revision.outputSha256).not.toBe(first.outputSha256);
      expect(revision).toMatchObject({ measurements: { clips: ["idle", "move", "attack"] }, unchanged: false });
    } finally {
      await stopServer(child);
    }

    expect(() => stdout.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line))).not.toThrow();
  }, 120_000);

  it("should preserve the previous GLB when a revised spec is blocked", async () => {
    const root = await createScaffold();
    const specPath = join(root, ".threenative", "creatures", "wyvern.json");
    await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
    const { child } = await startServer(root);
    try {
      const first = structured(await callTool(child, 2, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      }));
      const previous = await readFile(join(root, "assets", "creatures", "wyvern.glb"));
      const blocked = cloneSpec();
      const volumes = blocked.volumes as Array<Record<string, unknown>>;
      if (!volumes[0]) throw new Error("wyvern fixture has no torso volume");
      volumes[0].faceted = true;
      await writeFile(specPath, JSON.stringify(blocked, null, 2));

      const failure = structured(await callTool(child, 3, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
        expectedOutputSha256: first.outputSha256,
      }));

      expect(failure).toMatchObject({
        operation: "creature_compile",
        code: "COMPILE_BLOCKED",
        detail: { checkIds: expect.arrayContaining(["faceted_body"]) },
      });
      expect(await readFile(join(root, "assets", "creatures", "wyvern.glb"))).toEqual(previous);
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("should reject an escaped output when a parent is a symlink", async () => {
    const root = await createScaffold();
    const outside = await mkdtemp(join(tmpdir(), "creature-output-escape-"));
    temporaryDirectories.push(outside);
    await writeFile(join(root, ".threenative", "creatures", "wyvern.json"), JSON.stringify(WYVERN_SPEC, null, 2));
    await symlink(outside, join(root, "assets", "escaped"), "dir");
    const { child } = await startServer(root);
    try {
      const failure = structured(await callTool(child, 2, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/escaped/wyvern.glb",
      }));
      expect(failure).toMatchObject({ code: "INVALID_SPEC", operation: "creature_compile" });
      expect(existsSync(join(outside, "wyvern.glb"))).toBe(false);
    } finally {
      await stopServer(child);
    }
  }, 30_000);

  it("should terminate the compiler when the call is cancelled", async () => {
    if (process.platform !== "linux") return;
    const root = await createScaffold();
    const specPath = join(root, ".threenative", "creatures", "wyvern.json");
    await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
    const { child } = await startServer(root);
    try {
      const first = structured(await callTool(child, 2, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      }));
      const previous = await readFile(join(root, "assets", "creatures", "wyvern.glb"));
      const revised = cloneSpec();
      reviseWing(revised, "#e27642");
      await writeFile(specPath, JSON.stringify(revised, null, 2));
      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "creature_compile",
          arguments: {
            specPath: ".threenative/creatures/wyvern.json",
            outputPath: "assets/creatures/wyvern.glb",
            expectedOutputSha256: first.outputSha256,
          },
        },
      });
      const compilerPid = await waitForCompilerChild(child.pid ?? 0);
      const busy = structured(await callTool(child, 4, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/other.glb",
      }));
      expect(busy).toMatchObject({ code: "BUSY", detail: { retryable: true } });
      send(child, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "integration cancellation" },
      });
      await waitForProcessExit(compilerPid);
      expect(await readFile(join(root, "assets", "creatures", "wyvern.glb"))).toEqual(previous);

      await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      const afterCancellation = structured(await callTool(child, 5, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      }));
      expect(afterCancellation).toMatchObject({ outputSha256: first.outputSha256, unchanged: true });
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("should reject a stale writer when the output hash changes", async () => {
    if (process.platform !== "linux") return;
    const root = await createScaffold();
    const specPath = join(root, ".threenative", "creatures", "wyvern.json");
    const outputPath = join(root, "assets", "creatures", "wyvern.glb");
    await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
    const { child } = await startServer(root);
    try {
      const first = structured(await callTool(child, 2, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      }));
      const revised = cloneSpec();
      reviseWing(revised, "#bd2d20");
      await writeFile(specPath, JSON.stringify(revised, null, 2));
      const response = nextResponse(child, 3, 90_000);
      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "creature_compile",
          arguments: {
            specPath: ".threenative/creatures/wyvern.json",
            outputPath: "assets/creatures/wyvern.glb",
            expectedOutputSha256: first.outputSha256,
          },
        },
      });
      await waitForCompilerChild(child.pid ?? 0);
      const externalBytes = Buffer.concat([await readFile(outputPath), Buffer.from("stale-writer")]);
      await writeFile(outputPath, externalBytes);

      expect(structured(await response)).toMatchObject({ code: "OUTPUT_CONFLICT", operation: "creature_compile" });
      expect(await readFile(outputPath)).toEqual(externalBytes);
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("runs the pinned green and red calibrations from their extracted reference paths", async () => {
    const root = await createScaffold();
    await writeFile(join(root, ".threenative", "creatures", "wyvern.json"), JSON.stringify(WYVERN_SPEC, null, 2));
    const { child } = await startServer(root);
    try {
      const compiled = structured(await callTool(child, 2, "creature_compile", {
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/wyvern.glb",
      }));
      expect(compiled.outputSha256).toEqual(expect.any(String));
    } finally {
      await stopServer(child);
    }
    const cacheParent = join(root, ".cache", "threenative-asset-mcp", "creature-toolchains");
    const toolchainName = (await readdir(cacheParent)).find((name) => name.startsWith("anyCreature-1.3.1-"));
    if (!toolchainName) throw new Error("verified toolchain cache was not created");
    const toolchain = join(cacheParent, toolchainName);
    expect(JSON.parse(await readFile(join(toolchain, "package.json"), "utf8"))).toMatchObject({ type: "commonjs" });
    const cli = join(toolchain, "engine", "cli.js");
    const green = spawnSync(process.execPath, [cli, join(toolchain, "calibration", "wolf_green.json"), join(root, ".threenative", "green.glb")], {
      cwd: join(toolchain, "engine"),
      encoding: "utf8",
    });
    const wolfRed = spawnSync(process.execPath, [cli, join(toolchain, "calibration", "wolf_red.json"), join(root, ".threenative", "wolf-red.glb")], {
      cwd: join(toolchain, "engine"),
      encoding: "utf8",
    });
    const proportionRed = spawnSync(process.execPath, [cli, join(toolchain, "calibration", "red_5050.json"), join(root, ".threenative", "proportion-red.glb")], {
      cwd: join(toolchain, "engine"),
      encoding: "utf8",
    });
    expect(green.status, green.stderr).toBe(0);
    expect(wolfRed.status).toBe(1);
    expect(wolfRed.stderr).toContain("BLOCK:");
    expect(proportionRed.status).toBe(1);
    expect(proportionRed.stderr).toContain("BLOCK: proportion:");
  }, 120_000);

  it("rejects a corrupt compiler artifact even when its summary and checks claim success", async () => {
    const root = await createScaffold();
    const specPath = join(root, ".threenative", "creatures", "wyvern.json");
    await writeFile(specPath, JSON.stringify(WYVERN_SPEC, null, 2));
    const fixtureCli = String.raw`
      require("zod");
      const fs = require("fs");
      const path = require("path");
      const [, , specPath, outPath] = process.argv;
      JSON.parse(fs.readFileSync(specPath, "utf8"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const bytes = Buffer.from("not-a-glb");
      fs.writeFileSync(outPath, bytes);
      fs.writeFileSync(outPath.replace(/\.glb$/i, "") + ".checks.json", JSON.stringify({
        passed: true,
        checks: [{ name: "fixture", passed: true }],
        blocking: [],
        measures: []
      }));
      console.log(JSON.stringify({
        ok: true, out: outPath, bytes: bytes.length,
        dims: { width: 1, height: 1, length: 1 },
        verts: 1, faces: 1, joints: 1, anims: ["idle"],
        checks: "all green", contract: "ok"
      }));
    `;
    const archiveWriter = new ZipWriter(new Uint8ArrayWriter());
    await archiveWriter.add("fixture/engine/cli.js", new TextReader(fixtureCli));
    const archive = Buffer.from(await archiveWriter.close());
    const archivePath = join(root, "fixture.zip");
    await writeFile(archivePath, archive);
    const runner = new CreatureRunner(
      {
        cacheDir: join(root, ".fixture-cache"),
        limits: {
          specBytes: 262_144,
          glbBytes: 33_554_432,
          diagnosticsBytes: 1_048_576,
          compileTimeoutMs: 60_000,
          maxActiveHeavyOperations: 1,
        },
      },
      root,
      {
        archivePath,
        archiveSha256: hash(archive),
        version: "fixture",
        commit: "fixture",
        root: "fixture/",
        files: ["engine/cli.js"],
      },
    );

    await expect(
      runner.compile({
        specPath: ".threenative/creatures/wyvern.json",
        outputPath: "assets/creatures/corrupt.glb",
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    expect(existsSync(join(root, "assets", "creatures", "corrupt.glb"))).toBe(false);
    await runner.close();
  }, 30_000);
});
