import { Document, NodeIO } from "@gltf-transform/core";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleAssetClient } from "../src/bundle/client.js";
import type { ResolvedItchUpload } from "../src/itch/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-bundle-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function animationGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const node = document.createNode("Hips");
  // A reference body for the clips to drive, so the aggregate GLB has bounds to report.
  document
    .createScene("Scene")
    .addChild(node)
    .addChild(
      document
        .createNode("Body")
        .setMesh(
          document
            .createMesh("Body")
            .addPrimitive(
              document
                .createPrimitive()
                .setAttribute(
                  "POSITION",
                  document
                    .createAccessor("POSITION")
                    .setType("VEC3")
                    .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]))
                    .setBuffer(buffer),
                ),
            ),
        ),
    );

  for (const [name, distance] of [
    ["Idle_Loop", 0],
    ["Jog_Fwd_Loop", 2],
  ] as const) {
    const input = document
      .createAccessor(`${name}-time`)
      .setType("SCALAR")
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer);
    const output = document
      .createAccessor(`${name}-translation`)
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, distance, 0, 0]))
      .setBuffer(buffer);
    const sampler = document
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation("LINEAR");
    document
      .createAnimation(name)
      .addSampler(sampler)
      .addChannel(
        document
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(node)
          .setTargetPath("translation"),
      );
  }
  return new NodeIO().writeBinary(document);
}

async function zipFixture(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "Universal Animation Library/UAL1_Standard.glb",
    new Uint8ArrayReader(await animationGlb()),
  );
  await writer.add(
    "Universal Animation Library/License.txt",
    new Uint8ArrayReader(new TextEncoder().encode("CC0")),
  );
  const filler = new Uint8Array(128 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < filler.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    filler[index] = state & 0xff;
  }
  await writer.add(
    "Universal Animation Library/Unused.bin",
    new Uint8ArrayReader(filler),
  );
  return writer.close();
}

function rangeFetch(bytes: Uint8Array) {
  let transferred = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    if (!range) {
      return new Response(null, {
        status: 200,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(bytes.byteLength),
        },
      });
    }
    let start: number;
    let end: number;
    const suffix = range.match(/^bytes=-(\d+)$/);
    const explicit = range.match(/^bytes=(\d+)-(\d*)$/);
    if (suffix?.[1]) {
      const length = Number(suffix[1]);
      start = Math.max(0, bytes.byteLength - length);
      end = bytes.byteLength - 1;
    } else if (explicit?.[1]) {
      start = Number(explicit[1]);
      end = explicit[2] ? Number(explicit[2]) : bytes.byteLength - 1;
    } else {
      throw new Error(`Unsupported range ${range}`);
    }
    const body = bytes.slice(start, Math.min(end + 1, bytes.byteLength));
    transferred += body.byteLength;
    return new Response(body, {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(body.byteLength),
        "content-range": `bytes ${start}-${start + body.byteLength - 1}/${bytes.byteLength}`,
      },
    });
  });
  return { fetch, transferred: () => transferred };
}

async function fixtureClient() {
  const zip = await zipFixture();
  const ranged = rangeFetch(zip);
  const signedFileUrl =
    "https://itchio-mirror.0123456789abcdef.r2.cloudflarestorage.com/upload2/game/1/2?X-Amz-Signature=test";
  const resolved: ResolvedItchUpload = {
    pack: {
      id: "quaternius-universal-animation-library-1",
      name: "Quaternius Universal Animation Library 1",
      sourceId: "quaternius",
      pageUrl: "https://quaternius.itch.io/universal-animation-library",
      kind: "animation",
      license: "CC0",
      attributionRequired: false,
    },
    upload: {
      uploadId: "17958403",
      name: "Universal Animation Library[Standard].zip",
      suggestedFileName: "Universal Animation Library[Standard].zip",
    },
    signedFileUrl,
  };
  const resolver = {
    resolveUpload: vi.fn(async () => resolved),
  };
  const downloadDir = await temporaryDirectory();
  const client = new BundleAssetClient({
    itch: resolver,
    fetch: ranged.fetch,
    downloadDir,
  });
  return { client, zip, ranged, resolver, downloadDir };
}

describe("selective remote bundle access", () => {
  it("lists ZIP entries using ranges instead of downloading the full archive", async () => {
    const { client, zip, ranged } = await fixtureClient();
    const result = await client.listEntries(
      "quaternius-universal-animation-library-1",
      "17958403",
    );

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "Universal Animation Library/UAL1_Standard.glb",
      "Universal Animation Library/License.txt",
      "Universal Animation Library/Unused.bin",
    ]);
    expect(ranged.transferred()).toBeLessThan(zip.byteLength);
    expect(JSON.stringify(result)).not.toContain("X-Amz-Signature");
  });

  it("lists animation clips from only the ranged GLB entry", async () => {
    const { client } = await fixtureClient();
    const result = await client.listAnimations({
      packId: "quaternius-universal-animation-library-1",
      uploadId: "17958403",
      entryPath: "Universal Animation Library/UAL1_Standard.glb",
    });

    expect(result.animations.map((animation) => animation.name)).toEqual([
      "Idle_Loop",
      "Jog_Fwd_Loop",
    ]);
    expect(result.entryPath).toBe(
      "Universal Animation Library/UAL1_Standard.glb",
    );
  });

  it("exports one validated animation GLB and reuses the cached aggregate entry", async () => {
    const { client, ranged } = await fixtureClient();
    await client.listAnimations({
      packId: "quaternius-universal-animation-library-1",
      uploadId: "17958403",
      entryPath: "Universal Animation Library/UAL1_Standard.glb",
    });
    const beforeDownload = ranged.transferred();
    const result = await client.downloadAnimation({
      packId: "quaternius-universal-animation-library-1",
      uploadId: "17958403",
      entryPath: "Universal Animation Library/UAL1_Standard.glb",
      animationName: "Jog_Fwd_Loop",
    });

    expect(ranged.transferred()).toBe(beforeDownload);
    expect(result.animationName).toBe("Jog_Fwd_Loop");
    expect(result.sizeBytes).toBeLessThan(result.aggregateEntryBytes);
    const output = await new NodeIO().readBinary(
      new Uint8Array(await readFile(result.path)),
    );
    expect(output.getRoot().listAnimations().map((item) => item.getName())).toEqual([
      "Jog_Fwd_Loop",
    ]);
  });

  it("downloads one ordinary archive entry without saving the full ZIP", async () => {
    const { client, zip, ranged } = await fixtureClient();
    const result = await client.downloadEntry({
      packId: "quaternius-universal-animation-library-1",
      uploadId: "17958403",
      entryPath: "Universal Animation Library/License.txt",
    });

    expect(await readFile(result.path, "utf8")).toBe("CC0");
    expect(ranged.transferred()).toBeLessThan(zip.byteLength);
    expect(result).not.toHaveProperty("sizeMeters");
  });

  it("reports how big a downloaded GLB is", async () => {
    const { client } = await fixtureClient();
    const glb = await client.downloadEntry({
      packId: "quaternius-universal-animation-library-1",
      uploadId: "17958403",
      entryPath: "Universal Animation Library/UAL1_Standard.glb",
    });

    expect(glb.sizeMeters).toEqual({ x: 2, y: 4, z: 0 });
  });

  it("rejects a poisoned local entry cache instead of returning the wrong file", async () => {
    const { client } = await fixtureClient();
    const input = {
      packId: "quaternius-universal-animation-library-1" as const,
      uploadId: "17958403",
      entryPath: "Universal Animation Library/License.txt",
    };
    const first = await client.downloadEntry(input);
    await writeFile(first.path, "not the upstream license");

    await expect(client.downloadEntry(input)).rejects.toMatchObject({
      code: "BUNDLE_UNSAFE_PATH",
    });
  });
});
