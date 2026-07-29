import { describe, expect, it, vi } from "vitest";

import { PolyHavenClient } from "../src/polyhaven/client.js";
import {
  createPolyHavenGetAssetHandler,
  createPolyHavenListCategoriesHandler,
  createPolyHavenListFilesHandler,
  createPolyHavenSearchHandler,
} from "../src/tools/polyhaven.js";

const ASSETS = {
  dirty_football: {
    name: "Dirty Football",
    description: "A weathered soccer ball.",
    type: 2,
    category: "Leisure/Sports/Balls",
    category_id: "category-id",
    tags: ["soccer", "ball", "weathered"],
    attributes: { condition: ["weathered", "worn"], rigged: false },
    authors: { "Rohit Seervi": "All" },
    max_resolution: [8192, 8192],
    dimensions: [221, 220, 220],
    polycount: 37486,
    download_count: 7895,
    date_published: 1697846400,
    files_hash: "b27ae02f28eda2ef7e2b5ee925fdad06b3346617",
    thumbnail_url:
      "https://cdn.polyhaven.com/asset_img/thumbs/dirty_football.png?width=256",
  },
  studio_small_09: {
    name: "Studio Small 09",
    description: "A small studio HDRI.",
    type: 0,
    category: "Studio",
    tags: ["studio", "indoor"],
    attributes: { indoor: true },
    authors: { "Greg Zaal": "All" },
    download_count: 100,
  },
};

const FILES = {
  gltf: {
    "1k": {
      gltf: {
        url: "https://dl.polyhaven.org/file/model_1k.gltf",
        size: 1200,
        md5: "11111111111111111111111111111111",
        include: {
          "textures/diff.jpg": {
            url: "https://dl.polyhaven.org/file/diff_1k.jpg",
            size: 800,
            md5: "22222222222222222222222222222222",
          },
        },
      },
    },
    "2k": {
      gltf: {
        url: "https://dl.polyhaven.org/file/model_2k.gltf",
        size: 2400,
        md5: "33333333333333333333333333333333",
      },
    },
  },
};

function client() {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/assets") return Response.json(ASSETS);
    if (url.pathname === "/info/dirty_football") {
      return Response.json(ASSETS.dirty_football);
    }
    if (url.pathname === "/files/dirty_football") {
      return Response.json(FILES);
    }
    if (url.pathname === "/categories/models") {
      return Response.json({ all: 521, props: 176, sports: 10 });
    }
    return Response.json({ error: "missing" }, { status: 404 });
  });
  return {
    client: new PolyHavenClient(fetchMock, {
      userAgent: "threenative-asset-mcp-test/1.0",
    }),
    fetchMock,
  };
}

describe("Poly Haven MCP tools", () => {
  it("searches, filters, sorts, and paginates normalized assets", async () => {
    const fixture = client();
    const result = await createPolyHavenSearchHandler(fixture.client)({
      query: "ball",
      type: "all",
      limit: 1,
    });

    expect(result).not.toHaveProperty("isError");
    if ("isError" in result) throw new Error("unexpected tool error");
    expect(result.structuredContent).toMatchObject({
      total: 1,
      provider: "Poly Haven",
      attribution: "Powered by Poly Haven",
      items: [
        {
          id: "dirty_football",
          type: "models",
          license: "CC0",
          provider: "Poly Haven",
        },
      ],
    });
    expect(fixture.fetchMock).toHaveBeenCalledWith(
      "https://api.polyhaven.com/assets",
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": "threenative-asset-mcp-test/1.0",
        }),
      }),
    );
  });

  it("returns full normalized asset metadata", async () => {
    const result = await createPolyHavenGetAssetHandler(client().client)({
      assetId: "dirty_football",
    });
    if ("isError" in result) throw new Error("unexpected tool error");
    expect(result.structuredContent).toMatchObject({
      id: "dirty_football",
      name: "Dirty Football",
      category: "Leisure/Sports/Balls",
      polycount: 37486,
      maxResolution: [8192, 8192],
      attributes: { condition: ["weathered", "worn"], rigged: false },
    });
  });

  it("flattens file trees and preserves dependency relationships", async () => {
    const result = await createPolyHavenListFilesHandler(client().client)({
      assetId: "dirty_football",
      resolution: "1k",
      format: "gltf",
      includeDependencies: true,
    });
    if ("isError" in result) throw new Error("unexpected tool error");
    expect(result.structuredContent).toMatchObject({
      total: 2,
      files: [
        {
          path: "gltf/1k/gltf",
          sizeBytes: 1200,
        },
        {
          dependencyOf: "gltf/1k/gltf",
          relativePath: "textures/diff.jpg",
        },
      ],
    });
  });

  it("lists categories with counts", async () => {
    const result = await createPolyHavenListCategoriesHandler(client().client)({
      type: "models",
    });
    if ("isError" in result) throw new Error("unexpected tool error");
    expect(result.structuredContent.provider).toBe("Poly Haven");
    expect(result.structuredContent.categories.slice(0, 2)).toEqual([
      { name: "all", assetCount: 521 },
      { name: "props", assetCount: 176 },
    ]);
  });

  it("returns provider-specific safe errors", async () => {
    const result = await createPolyHavenGetAssetHandler(client().client)({
      assetId: "missing",
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("POLYHAVEN_NOT_FOUND");
  });
});
