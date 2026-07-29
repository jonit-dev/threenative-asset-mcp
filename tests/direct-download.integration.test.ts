import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { createDirectAssetDownloadHandler } from "../src/tools/direct-download.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-direct-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("direct provider file downloads", () => {
  it("streams a Poly Haven file returned by the MCP into guarded local storage", async () => {
    const downloadDir = await temporaryDirectory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4", "content-type": "application/zip" },
      }),
    );
    const handler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({ fetch, downloadDir, maxDownloadBytes: 100 }),
    );

    const result = await handler({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/file/ph-assets/Models/japanese_stone_lantern/japanese_stone_lantern_1k.blend.zip",
      fileName: "japanese_stone_lantern_1k.blend.zip",
      acceptLicense: true,
    });

    if ("isError" in result) throw new Error(JSON.stringify(result));
    expect(result.structuredContent).toMatchObject({
      provider: "polyhaven",
      fileName: "japanese_stone_lantern_1k.blend.zip",
      sizeBytes: 4,
      alreadyExisted: false,
    });
    expect(await readFile(result.structuredContent.path)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("supports ambientCG, Smithsonian, Game-icons, and Kenney URL contracts", async () => {
    const downloadDir = await temporaryDirectory();
    const handler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({
        downloadDir,
        fetch: async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-length": "1" },
          }),
      }),
    );

    const ambient = await handler({
      provider: "ambientcg",
      url: "https://ambientcg.com/get?file=Wood001_1K-PNG.zip",
      fileName: "Wood001_1K-PNG.zip",
      acceptLicense: true,
    });
    const smithsonian = await handler({
      provider: "smithsonian",
      url: "https://3d-api.si.edu/content/document/3d_package:abc/full.zip",
      fileName: "smithsonian-abc-full.zip",
      acceptLicense: true,
    });
    const gameIcons = await handler({
      provider: "game-icons",
      url: "https://game-icons.net/archives/ffffff/transparent/game-icons.net.svg.zip",
      fileName: "game-icons.net.svg.zip",
      acceptLicense: true,
    });
    const kenney = await handler({
      provider: "kenney",
      url: "https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip",
      fileName: "kenney_particle-pack.zip",
      acceptLicense: true,
    });

    expect("isError" in ambient).toBe(false);
    expect("isError" in smithsonian).toBe(false);
    expect("isError" in gameIcons).toBe(false);
    expect("isError" in kenney).toBe(false);
  });

  it("rejects arbitrary hosts and provider-path mismatches", async () => {
    const handler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({ downloadDir: await temporaryDirectory() }),
    );

    const badHost = await handler({
      provider: "polyhaven",
      url: "https://example.com/asset.zip",
      fileName: "asset.zip",
      acceptLicense: true,
    });
    const badPath = await handler({
      provider: "ambientcg",
      url: "https://ambientcg.com/api/v3/assets",
      fileName: "assets.json",
      acceptLicense: true,
    });

    expect(JSON.stringify(badHost)).toContain("ASSET_DOWNLOAD_URL_REJECTED");
    expect(JSON.stringify(badPath)).toContain("ASSET_DOWNLOAD_URL_REJECTED");
  });

  it("rejects redirects outside the provider allowlist and oversized streams", async () => {
    const downloadDir = await temporaryDirectory();
    const redirectHandler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({
        downloadDir,
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/file.zip" },
          }),
      }),
    );
    const oversizedHandler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({
        downloadDir,
        maxDownloadBytes: 2,
        fetch: async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-length": "3" },
          }),
      }),
    );

    const redirected = await redirectHandler({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/file.zip",
      fileName: "file.zip",
      acceptLicense: true,
    });
    const oversized = await oversizedHandler({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/file.zip",
      fileName: "file.zip",
      acceptLicense: true,
    });

    expect(JSON.stringify(redirected)).toContain("ASSET_DOWNLOAD_URL_REJECTED");
    expect(JSON.stringify(oversized)).toContain("ASSET_DOWNLOAD_TOO_LARGE");
  });

  it("isolates identical filenames from different source URLs", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }));
    const handler = createDirectAssetDownloadHandler(
      new DirectAssetDownloader({
        downloadDir: await temporaryDirectory(),
        fetch,
      }),
    );

    const first = await handler({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/one/asset.zip",
      fileName: "asset.zip",
      acceptLicense: true,
    });
    const second = await handler({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/two/asset.zip",
      fileName: "asset.zip",
      acceptLicense: true,
    });

    if ("isError" in first || "isError" in second) {
      throw new Error("unexpected error");
    }
    expect(first.structuredContent.path).not.toBe(second.structuredContent.path);
    expect(await readFile(first.structuredContent.path)).toEqual(Buffer.from([1]));
    expect(await readFile(second.structuredContent.path)).toEqual(Buffer.from([2]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
