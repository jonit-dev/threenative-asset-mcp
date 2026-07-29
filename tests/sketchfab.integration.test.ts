import { describe, expect, it, vi } from "vitest";

import { SketchfabClient } from "../src/sketchfab/client.js";
import {
  createSketchfabGetDownloadsHandler,
  createSketchfabGetModelHandler,
  createSketchfabListCategoriesHandler,
  createSketchfabSearchHandler,
} from "../src/tools/sketchfab.js";

const MODEL_ID = "9aea3b516d3e4e169710049b32282670";
const MODEL = {
  uid: MODEL_ID,
  name: "The Wizard's Chair",
  description: "A sculpted chair.",
  viewerUrl: `https://sketchfab.com/3d-models/chair-${MODEL_ID}`,
  embedUrl: `https://sketchfab.com/models/${MODEL_ID}/embed`,
  isDownloadable: true,
  isAgeRestricted: false,
  animationCount: 0,
  faceCount: 100,
  vertexCount: 60,
  viewCount: 1000,
  likeCount: 50,
  tags: [{ name: "chair" }],
  categories: [{ name: "Furniture & Home", slug: "furniture-home" }],
  user: {
    uid: "user-id",
    username: "artist",
    displayName: "Artist",
    profileUrl: "https://sketchfab.com/artist",
  },
  license: {
    label: "CC Attribution",
    slug: "by",
    url: "https://creativecommons.org/licenses/by/4.0/",
    requirements: "Author must be credited.",
  },
  archives: {
    gltf: {
      size: 10000,
      textureCount: 2,
      textureMaxResolution: 2048,
      faceCount: 100,
      vertexCount: 60,
    },
  },
  thumbnails: {
    images: [
      {
        width: 512,
        url: "https://media.sketchfab.com/models/chair.jpeg",
      },
    ],
  },
};

function fixture(token: string | null = null) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/download")) {
      return Response.json({
        gltf: {
          url: "https://example-download.sketchfab.com/model.zip",
          expires: 300,
          size: 10000,
        },
      });
    }
    if (url.pathname.endsWith("/categories")) {
      return Response.json({
        results: [{ name: "Furniture & Home", slug: "furniture-home" }],
      });
    }
    if (url.pathname.endsWith(`/models/${MODEL_ID}`)) {
      return Response.json(MODEL);
    }
    return Response.json({
      cursors: { next: "opaque-next", previous: null },
      results: [MODEL],
    });
  });
  return {
    client: new SketchfabClient(fetchMock, { token }),
    fetchMock,
  };
}

describe("Sketchfab MCP tools", () => {
  it("searches anonymously and preserves license requirements", async () => {
    const { client, fetchMock } = fixture();
    const result = await createSketchfabSearchHandler(client)({
      query: "chair",
      category: "furniture-home",
      limit: 10,
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      nextCursor: "opaque-next",
      downloadAuthentication: "SKETCHFAB_API_TOKEN",
      items: [
        {
          id: MODEL_ID,
          license: {
            slug: "by",
            requirements: "Author must be credited.",
          },
          archives: [{ format: "gltf", sizeBytes: 10000 }],
        },
      ],
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("downloadable")).toBe("true");
    expect(url.searchParams.get("categories")).toBe("furniture-home");
  });

  it("gets public model detail", async () => {
    const result = await createSketchfabGetModelHandler(fixture().client)({
      modelId: MODEL_ID,
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      name: "The Wizard's Chair",
      author: { username: "artist" },
      provider: "Sketchfab",
    });
  });

  it("requires an explicit user token for download metadata", async () => {
    const { client, fetchMock } = fixture();
    const result = await createSketchfabGetDownloadsHandler(client)({
      modelId: MODEL_ID,
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("SKETCHFAB_AUTH_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the token only as an Authorization header", async () => {
    const { client, fetchMock } = fixture("secret-token");
    const result = await createSketchfabGetDownloadsHandler(client)({
      modelId: MODEL_ID,
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent.downloads[0]).toMatchObject({
      format: "gltf",
      expiresInSeconds: 300,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.sketchfab.com/v3/models/${MODEL_ID}/download`,
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Token secret-token",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("lists public categories", async () => {
    const result = await createSketchfabListCategoriesHandler(
      fixture().client,
    )({});
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent.categories).toEqual([
      { name: "Furniture & Home", slug: "furniture-home" },
    ]);
  });
});
