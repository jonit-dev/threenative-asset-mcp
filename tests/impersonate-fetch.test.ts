import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FabClientError } from "../src/fab/direct-transport.js";
import {
  createImpersonateFetch,
  isChallengeResponse,
  resolveImpersonateCommand,
} from "../src/fab/impersonate-fetch.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratchDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fab-mcp-impersonate-"));
  temporaryDirectories.push(directory);
  return directory;
}

function headerDump(status: number, headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
  return `HTTP/2 ${status}\r\n${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Builds a fake subprocess runner that answers with the given sequence of
 * responses, writing the header/body files curl would write.
 */
function fakeRunner(
  responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body?: string;
    exitCode?: number;
  }>,
) {
  const calls: string[][] = [];
  const run = vi.fn(async (command: string, args?: readonly string[]) => {
    const argv = [...(args ?? [])];
    calls.push(argv);
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next.exitCode !== undefined) {
      const error = new Error("curl failed") as Error & { code?: number };
      error.code = next.exitCode;
      throw error;
    }
    const headersPath = argv[argv.indexOf("-D") + 1]!;
    const bodyPath = argv[argv.indexOf("-o") + 1]!;
    await writeFile(headersPath, headerDump(next.status, next.headers ?? {}));
    await writeFile(bodyPath, next.body ?? "");
    return { stdout: "", stderr: "" };
  });
  return { run: run as never, calls };
}

describe("resolveImpersonateCommand", () => {
  it("honors an explicit wrapper override", () => {
    expect(
      resolveImpersonateCommand({ FAB_CURL_IMPERSONATE: "/opt/bin/curl_chrome146" }),
    ).toBe("/opt/bin/curl_chrome146");
  });

  it("disables impersonation on off values", () => {
    for (const value of ["0", "off", "FALSE"]) {
      expect(resolveImpersonateCommand({ FAB_CURL_IMPERSONATE: value })).toBeUndefined();
    }
  });

  it("finds a known wrapper on PATH", async () => {
    const directory = await scratchDir();
    await writeFile(join(directory, "curl_chrome131"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    expect(
      resolveImpersonateCommand({ PATH: directory }),
    ).toBe(join(directory, "curl_chrome131"));
  });

  it("returns undefined when no wrapper exists", () => {
    expect(resolveImpersonateCommand({ PATH: "/nonexistent" })).toBeUndefined();
  });
});

describe("isChallengeResponse", () => {
  it("detects cf-mitigated challenges", () => {
    expect(
      isChallengeResponse(403, new Headers({ "cf-mitigated": "challenge" })),
    ).toBe(true);
  });

  it("detects html interstitials on 403", () => {
    expect(
      isChallengeResponse(403, new Headers({ "content-type": "text/html; charset=UTF-8" })),
    ).toBe(true);
  });

  it("does not flag a json api denial", () => {
    expect(
      isChallengeResponse(403, new Headers({ "content-type": "application/json" })),
    ).toBe(false);
  });

  it("does not flag success", () => {
    expect(
      isChallengeResponse(200, new Headers({ "content-type": "application/json" })),
    ).toBe(false);
  });
});

describe("createImpersonateFetch", () => {
  it("returns a response built from curl output", async () => {
    const { run } = fakeRunner([
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
    ]);
    const fetchImpl = createImpersonateFetch({
      command: "curl_chrome146",
      cookieJarPath: "/tmp/jar.txt",
      timeoutMs: 5_000,
      runCommand: run,
    });
    const response = await fetchImpl("https://www.fab.com/i/listings/search");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("retries challenge responses before returning", async () => {
    const { run, calls } = fakeRunner([
      {
        status: 403,
        headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
        body: "<html>challenge</html>",
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
    ]);
    const sleeps: number[] = [];
    const fetchImpl = createImpersonateFetch({
      command: "curl_chrome146",
      cookieJarPath: "/tmp/jar.txt",
      timeoutMs: 5_000,
      challengeWaitsMs: [100, 200],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      runCommand: run,
    });
    const response = await fetchImpl("https://www.fab.com/i/listings/search");
    expect(response.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it("returns the final challenge response after exhausting retries", async () => {
    const { run, calls } = fakeRunner([
      {
        status: 403,
        headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
      },
    ]);
    const fetchImpl = createImpersonateFetch({
      command: "curl_chrome146",
      cookieJarPath: "/tmp/jar.txt",
      timeoutMs: 5_000,
      maxChallengeRetries: 2,
      challengeWaitsMs: [1, 1],
      sleep: async () => {},
      random: () => 0,
      runCommand: run,
    });
    const response = await fetchImpl("https://www.fab.com/i/listings/search");
    expect(response.status).toBe(403);
    expect(response.headers.get("cf-mitigated")).toBe("challenge");
    expect(calls.length).toBe(3);
  });

  it("maps curl timeouts to FAB_TIMEOUT", async () => {
    const { run } = fakeRunner([{ status: 0, exitCode: 28 }]);
    const fetchImpl = createImpersonateFetch({
      command: "curl_chrome146",
      cookieJarPath: "/tmp/jar.txt",
      timeoutMs: 5_000,
      runCommand: run,
    });
    const error = await fetchImpl("https://www.fab.com/").catch((e) => e);
    expect(error).toBeInstanceOf(FabClientError);
    expect((error as FabClientError).code).toBe("FAB_TIMEOUT");
  });

  it("refuses non-GET requests", async () => {
    const { run } = fakeRunner([{ status: 200 }]);
    const fetchImpl = createImpersonateFetch({
      command: "curl_chrome146",
      cookieJarPath: "/tmp/jar.txt",
      timeoutMs: 5_000,
      runCommand: run,
    });
    const error = await fetchImpl("https://www.fab.com/", {
      method: "POST",
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_INTERNAL");
  });
});
