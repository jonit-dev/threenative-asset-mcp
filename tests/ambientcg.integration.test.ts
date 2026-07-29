import { describe, expect, it, vi } from "vitest";

import { AmbientCgClient } from "../src/ambientcg/client.js";
import {
  createAmbientCgGetAssetHandler,
  createAmbientCgListCategoriesHandler,
  createAmbientCgListFilesHandler,
  createAmbientCgSearchHandler,
} from "../src/tools/ambientcg.js";

const ASSET = {
  id: "3DApple002",
  type: "3d-model",
  releaseDate: "2024-09-25",
  shortDescription: "A scanned apple.",
  title: "3D Apple 002",
  url: "https://ambientcg.com/a/3DApple002",
  tags: ["apple", "food"],
  technique: "model-photogrammetry",
  dimensions: { width: 10, height: 20, depth: 30 },
  downloadStatistics: { total: 12000 },
  maps: ["color", "normal"],
  downloads: [
    {
      attributes: "HQ-2K-PNG",
      extension: "zip",
      url: "https://ambientcg.com/get?file=3DApple002_HQ-2K-PNG.zip",
      size: 42000,
    },
    {
      attributes: "LQ-1K-JPG",
      extension: "zip",
      url: "https://ambientcg.com/get?file=3DApple002_LQ-1K-JPG.zip",
      size: 12000,
    },
  ],
  thumbnails: {
    "512-WEBP": "https://acg-media.struffelproductions.com/apple.webp",
  },
};

function fixture() {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/categories")) {
      return Response.json([
        {
          id: "3DFood",
          title: "3D Food",
          type: "3d-model",
          numberOfAssets: 10,
        },
      ]);
    }
    return Response.json({
      totalResults: 1,
      assets: [ASSET],
      nextPageHttp: null,
    });
  });
  return { client: new AmbientCgClient(fetchMock), fetchMock };
}

describe("ambientCG MCP tools", () => {
  it("searches the v3 API and normalizes CC0 metadata", async () => {
    const { client, fetchMock } = fixture();
    const result = await createAmbientCgSearchHandler(client)({
      query: "apple",
      type: "3d-model",
      limit: 10,
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent.items[0]).toMatchObject({
      id: "3DApple002",
      provider: "ambientCG",
      license: "CC0",
      maps: ["color", "normal"],
    });
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get("q")).toBe("apple");
    expect(calledUrl.searchParams.get("type")).toBe("3d-model");
  });

  it("gets metadata without embedding the large file list", async () => {
    const result = await createAmbientCgGetAssetHandler(fixture().client)({
      assetId: "3DApple002",
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      title: "3D Apple 002",
      technique: "model-photogrammetry",
      downloadCount: 12000,
    });
    expect(result.structuredContent).not.toHaveProperty("downloads");
  });

  it("filters official download variants", async () => {
    const result = await createAmbientCgListFilesHandler(fixture().client)({
      assetId: "3DApple002",
      attributes: "2k",
      extension: "zip",
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      total: 1,
      license: "CC0",
      files: [{ attributes: "HQ-2K-PNG", sizeBytes: 42000 }],
    });
  });

  it("lists typed categories", async () => {
    const result = await createAmbientCgListCategoriesHandler(fixture().client)({
      type: "3d-model",
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent.categories).toEqual([
      {
        id: "3DFood",
        title: "3D Food",
        type: "3d-model",
        assetCount: 10,
      },
    ]);
  });
});
