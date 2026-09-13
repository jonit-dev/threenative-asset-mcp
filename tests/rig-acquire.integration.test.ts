import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RigConfig } from "../src/config.js";
import { acquireVerifiedSource } from "../src/rig/acquire.js";
import { sha256 } from "../src/rig/inspect.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cacheConfig(maxDownloadBytes = 1024 * 1024): Promise<RigConfig> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-acquire-"));
  temporaryDirectories.push(directory);
  return { cacheDir: directory, maxDownloadBytes, downloadTimeoutMs: 5_000 };
}

const SOURCE_URL =
  "https://raw.githubusercontent.com/RamonLinares/atlas-09/1b8fb9d54160215c071c5a29a49b1c36dc01f0df/public/models/aether-02.glb";

function fakeResponse(bytes: Uint8Array, chunk = bytes.byteLength): Response {
  let offset = 0;
  return {
    url: SOURCE_URL,
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.byteLength) return { done: true, value: undefined };
          const value = bytes.subarray(offset, Math.min(offset + chunk, bytes.byteLength));
          offset += value.byteLength;
          return { done: false, value };
        },
      }),
    },
  } as unknown as Response;
}

describe("acquireVerifiedSource", () => {
  it("streams a pinned source, verifies the digest and reuses the cache offline", async () => {
    const config = await cacheConfig();
    const payload = new TextEncoder().encode("glb-payload");
    const fetchMock = async () => fakeResponse(payload, 4);

    const first = await acquireVerifiedSource({
      id: "aether-02",
      sourceUrl: SOURCE_URL,
      sha256: sha256(payload),
      config,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(first.alreadyCached).toBe(false);
    expect(first.bytes).toBe(payload.byteLength);
    expect(sha256(new Uint8Array(await readFile(first.path)))).toBe(sha256(payload));

    const offline = async () => {
      throw new Error("network is down");
    };
    const second = await acquireVerifiedSource({
      id: "aether-02",
      sourceUrl: SOURCE_URL,
      sha256: sha256(payload),
      config,
      fetchImpl: offline as unknown as typeof fetch,
    });
    expect(second.alreadyCached).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it("publishes nothing when the digest does not match", async () => {
    const config = await cacheConfig();
    const payload = new TextEncoder().encode("corrupt");
    await expect(
      acquireVerifiedSource({
        id: "aether-02",
        sourceUrl: SOURCE_URL,
        sha256: "0".repeat(64),
        config,
        fetchImpl: (async () => fakeResponse(payload)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "RIG_DIGEST_MISMATCH" });

    const directory = join(config.cacheDir, "samples");
    const entries = await stat(directory).then(
      async () => (await import("node:fs/promises")).readdir(directory),
      () => [],
    );
    expect(entries.filter((entry) => entry.endsWith(".glb"))).toHaveLength(0);
  });

  it("fails closed past the byte cap", async () => {
    const config = await cacheConfig(4);
    const payload = new TextEncoder().encode("glb-payload");
    await expect(
      acquireVerifiedSource({
        id: "aether-02",
        sourceUrl: SOURCE_URL,
        sha256: sha256(payload),
        config,
        fetchImpl: (async () => fakeResponse(payload, 4)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "RIG_INPUT_TOO_LARGE" });
  });
});
