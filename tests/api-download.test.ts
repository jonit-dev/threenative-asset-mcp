import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadFreeAssetViaApi } from "../src/fab/api-download.js";
import { FabClientError } from "../src/fab/direct-transport.js";

const LISTING_ID = "2db0d283-6c8a-461d-b813-5e1aee85b79c";
const FILE_ID = "9769cdb0-965f-4a86-a93f-ceaf0c397a1a";
const SIGNED_URL =
  "https://content-download-emp.distro.on.epicgames.com/Builds/Org/o-example/x/y/file.glb?cf_token=abc";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function detailPayload(overrides: Record<string, unknown> = {}) {
  return {
    uid: LISTING_ID,
    title: "Test Asset",
    isFree: true,
    assetFormats: [
      { assetFormatType: { code: "gltf" } },
      { assetFormatType: { code: "converted-files" } },
    ],
    ...overrides,
  };
}

function formatsPayload(files: unknown[] = defaultFiles()) {
  return { files };
}

function defaultFiles() {
  return [
    {
      uid: FILE_ID,
      name: "test_asset.glb",
      size: 1_554_428,
      status: "ready",
      fileType: "generated",
    },
  ];
}

function downloadInfoPayload(url: string = SIGNED_URL) {
  return {
    downloadInfo: [
      {
        assetFormat: "asset-format/3d-exchange/glb",
        downloadUrl: url,
        expires: "2099-01-01T00:00:00.000Z",
        type: "binary",
      },
    ],
  };
}

function routeJson(routes: Record<string, unknown | FabClientError>) {
  return async (url: URL): Promise<unknown> => {
    const key = `${url.pathname}${url.search}`;
    const hit = Object.entries(routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([path]) => key.startsWith(path));
    if (!hit) {
      throw new FabClientError("FAB_NOT_FOUND", `no route for ${key}`);
    }
    if (hit[1] instanceof FabClientError) throw hit[1];
    return hit[1];
  };
}

async function setup(routes: Record<string, unknown | FabClientError>) {
  const downloadDir = await mkdtemp(join(tmpdir(), "fab-mcp-api-dl-"));
  temporaryDirectories.push(downloadDir);
  const downloader = vi.fn(async (_url: URL, destination: string) => {
    await writeFile(destination, "fake-glb-bytes");
  });
  return { downloadDir, downloader, fetchJson: routeJson(routes) };
}

function happyRoutes() {
  return {
    [`/i/listings/${LISTING_ID}?currency=USD`]: detailPayload(),
    [`/i/listings/${LISTING_ID}/asset-formats/converted-files`]:
      formatsPayload(),
    [`/i/listings/${LISTING_ID}/asset-formats/converted-files/files/${FILE_ID}/download-info`]:
      downloadInfoPayload(),
  };
}

describe("downloadFreeAssetViaApi", () => {
  it("resolves and stores a free GLB through the JSON contract", async () => {
    const { downloadDir, downloader, fetchJson } = await setup(happyRoutes());
    const result = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    });
    expect(result.alreadyExisted).toBe(false);
    expect(result.fileName).toBe("test_asset.glb");
    expect(result.authentication).toBe("not-required");
    expect(result.sizeBytes).toBe(14);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(downloader).toHaveBeenCalledOnce();
    const [url] = downloader.mock.calls[0]!;
    expect(url.hostname).toBe(
      "content-download-emp.distro.on.epicgames.com",
    );
    await expect(readFile(result.path, "utf8")).resolves.toBe(
      "fake-glb-bytes",
    );
  });

  it("reports alreadyExisted without re-downloading", async () => {
    const { downloadDir, downloader, fetchJson } = await setup(happyRoutes());
    const options = {
      request: { listingId: LISTING_ID, format: "glb" as const },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    };
    await downloadFreeAssetViaApi(options);
    const second = await downloadFreeAssetViaApi(options);
    expect(second.alreadyExisted).toBe(true);
    expect(downloader).toHaveBeenCalledOnce();
  });

  it("refuses listings that are not fully free", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      [`/i/listings/${LISTING_ID}?currency=USD`]: detailPayload({
        isFree: false,
      }),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_ACQUISITION_REQUIRED");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("refuses formats the listing does not expose", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      [`/i/listings/${LISTING_ID}?currency=USD`]: detailPayload({
        assetFormats: [{ assetFormatType: { code: "fbx" } }],
      }),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_FORMAT_UNAVAILABLE");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("maps a download-info denial to acquisition-required", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      ...happyRoutes(),
      [`/i/listings/${LISTING_ID}/asset-formats/converted-files/files/${FILE_ID}/download-info`]:
        new FabClientError("FAB_ACCESS_DENIED", "denied"),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_ACQUISITION_REQUIRED");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("accepts rotation across Epic distribution domain families", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      ...happyRoutes(),
      [`/i/listings/${LISTING_ID}/asset-formats/converted-files/files/${FILE_ID}/download-info`]:
        downloadInfoPayload(
          "https://emp-fastly-stitched.epicgamescdn.com/Builds/x/file.glb?cf_token=abc",
        ),
    });
    const result = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    });
    expect(result.alreadyExisted).toBe(false);
    const [url] = downloader.mock.calls[0]!;
    expect(url.hostname).toBe("emp-fastly-stitched.epicgamescdn.com");
  });

  it("rejects signed URLs outside the distribution allowlist", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      ...happyRoutes(),
      [`/i/listings/${LISTING_ID}/asset-formats/converted-files/files/${FILE_ID}/download-info`]:
        downloadInfoPayload("https://evil.example.com/file.glb?cf_token=x"),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_UPSTREAM_CHANGED");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("fails early when the declared file size exceeds the cap", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      ...happyRoutes(),
      [`/i/listings/${LISTING_ID}/asset-formats/converted-files`]:
        formatsPayload([
          { ...defaultFiles()[0], size: 50_000_000 },
        ]),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_DOWNLOAD_TOO_LARGE");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("skips non-ready files", async () => {
    const { downloadDir, downloader, fetchJson } = await setup({
      ...happyRoutes(),
      [`/i/listings/${LISTING_ID}/asset-formats/converted-files`]:
        formatsPayload([
          { ...defaultFiles()[0], status: "processing" },
        ]),
    });
    const error = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "glb" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    }).catch((e) => e);
    expect((error as FabClientError).code).toBe("FAB_FORMAT_UNAVAILABLE");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("uses a direct format code when the listing exposes one", async () => {
    const fbxFileId = "c4de9de9-dff5-4b7d-b454-898272517b99";
    const { downloadDir, downloader, fetchJson } = await setup({
      [`/i/listings/${LISTING_ID}?currency=USD`]: detailPayload({
        assetFormats: [{ assetFormatType: { code: "fbx" } }],
      }),
      [`/i/listings/${LISTING_ID}/asset-formats/fbx`]: formatsPayload([
        {
          uid: fbxFileId,
          name: "test_asset_raw.zip",
          size: 900,
          status: "ready",
          fileType: "source",
        },
      ]),
      [`/i/listings/${LISTING_ID}/asset-formats/fbx/files/${fbxFileId}/download-info`]:
        downloadInfoPayload(),
    });
    const result = await downloadFreeAssetViaApi({
      request: { listingId: LISTING_ID, format: "fbx" },
      fetchJson,
      downloader,
      downloadDir,
      maxBytes: 10_000_000,
    });
    expect(result.fileName).toBe("test_asset_raw.zip");
    expect(downloader).toHaveBeenCalledOnce();
  });
});
