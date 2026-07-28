import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TtlLruCache } from "../src/fab/cache.js";
import { DirectFabTransport } from "../src/fab/direct-transport.js";
import { createStderrLogger } from "../src/fab/errors.js";

const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => []);
    }
  }
  children.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function jsonResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response ${id}`));
    }, timeoutMs);
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
          cleanup();
          reject(new Error(`Non-JSON stdout from MCP: ${line}`));
          return;
        }
        if (message.id === id) {
          cleanup();
          resolveResponse(message);
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
    };
    child.stdout.on("data", onData);
  });
}

function send(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function startInitializedServer(): Promise<{
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
}> {
  const profileDir = await mkdtemp(join(tmpdir(), "fab-mcp-smoke-"));
  temporaryDirectories.push(profileDir);
  const child = spawn(process.execPath, [resolve("dist/index.js")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      FAB_BROWSER_PROFILE_DIR: profileDir,
      FAB_LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const stdout: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
  });
  const initialized = jsonResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fab-mcp-smoke", version: "1.0.0" },
    },
  });
  expect(await initialized).toHaveProperty("result");
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  return { child, stdout };
}

async function stopServer(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MCP did not terminate")), 5_000),
    ),
  ]);
  children.delete(child);
}

describe("Phase 5 reliability", () => {
  it("should respect retry-after", async () => {
    let now = 0;
    const requestTimes: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        requestTimes.push(now);
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        });
      })
      .mockImplementationOnce(async () => {
        requestTimes.push(now);
        return Response.json({ results: [], cursors: {} });
      });
    const transport = new DirectFabTransport({
      fetch,
      now: () => now,
      random: () => 0,
      sleep,
    });

    await transport.search(
      new URL("https://www.fab.com/i/listings/search?q=forest"),
    );

    expect(requestTimes).toEqual([0, 2_000]);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("should stop after two transient retries", async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    const transport = new DirectFabTransport({
      fetch,
      now: () => now,
      random: () => 0,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      ),
    ).rejects.toMatchObject({
      code: "FAB_UPSTREAM_UNAVAILABLE",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("should evict cache entries at the configured bound", () => {
    const cache = new TtlLruCache<number>({ maxEntries: 999 });
    for (let index = 0; index < 501; index += 1) {
      cache.set(`key-${index}`, index, 60_000);
    }

    expect(cache.size).toBe(500);
    expect(cache.get("key-0")).toBeUndefined();
    expect(cache.get("key-500")).toBe(500);
  });

  it("redacts query text from structured logs by default", () => {
    const lines: string[] = [];
    const logger = createStderrLogger({
      level: "debug",
      logQueries: false,
      write: (line) => lines.push(line),
    });
    logger.log("debug", "search", {
      ...logger.queryFields("private search words"),
    });

    expect(lines.join("")).not.toContain("private search words");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      queryRedacted: true,
    });
  });
});

describe("built stdio package", () => {
  it("should start from the packaged binary and keep stdout protocol-clean", async () => {
    const { child, stdout } = await startInitializedServer();

    const listed = jsonResponse(child, 2);
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listResponse = await listed;
    expect(
      (listResponse.result as { tools?: Array<{ name: string }> }).tools?.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "fab_search_assets",
      "fab_get_asset",
      "fab_list_filters",
      "fab_list_limited_time_free",
      "fab_download_free_asset",
    ]);

    const called = jsonResponse(child, 3);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fab_list_filters", arguments: {} },
    });
    const callResponse = await called;
    expect(callResponse).toHaveProperty("result.structuredContent.filters");

    await stopServer(child);
    const lines = stdout.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it("should terminate cleanly", async () => {
    const { child } = await startInitializedServer();
    const startedAt = Date.now();

    await stopServer(child);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(child.exitCode).toBe(0);
  });
});
