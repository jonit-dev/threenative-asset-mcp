import { describe, expect, it, vi } from "vitest";

import { SmithsonianClient } from "../src/smithsonian/client.js";
import {
  createSmithsonianGetAssetHandler,
  createSmithsonianListFilesHandler,
  createSmithsonianSearchHandler,
} from "../src/tools/smithsonian.js";

const MODEL_ID = "e7514eea-3f12-490d-a2d0-999f2a1a70f7";
const ROWS = [
  {
    title: "Hatch, Crew, Apollo 11",
    content: {
      usage: "Web3D",
      quality: "Thumb",
      uri: `https://3d-api.si.edu/content/document/3d_package:${MODEL_ID}/thumb.glb`,
      file_type: "glb",
      model_type: "glb",
      draco_compressed: true,
      model_url: `3d_package:${MODEL_ID}`,
      gltf_orientation_compliant: true,
    },
  },
  {
    title: "Hatch, Crew, Apollo 11",
    content: {
      usage: "Download",
      quality: "Full_resolution",
      uri: `https://3d-api.si.edu/content/document/3d_package:${MODEL_ID}/full.zip`,
      file_type: "zip",
      model_type: "obj",
      model_url: `3d_package:${MODEL_ID}`,
    },
  },
];

function fixture() {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ rows: ROWS, rowCount: 2, message: "content found" }),
  );
  return { client: new SmithsonianClient(fetchMock), fetchMock };
}

describe("Smithsonian MCP tools", () => {
  it("searches and groups file rows into model results", async () => {
    const { client, fetchMock } = fixture();
    const result = await createSmithsonianSearchHandler(client)({
      query: "apollo",
      fileType: "glb",
      quality: "Thumb",
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      totalFiles: 2,
      provider: "Smithsonian 3D",
      items: [
        {
          id: MODEL_ID,
          title: "Hatch, Crew, Apollo 11",
          fileTypes: ["glb", "zip"],
          license: "Smithsonian Open Access — verify item rights",
        },
      ],
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("q")).toBe("apollo");
    expect(url.searchParams.get("file_quality")).toBe("Thumb");
  });

  it("gets a model summary by package ID", async () => {
    const result = await createSmithsonianGetAssetHandler(fixture().client)({
      modelId: MODEL_ID,
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      id: MODEL_ID,
      modelTypes: ["glb", "obj"],
      qualities: ["Thumb", "Full_resolution"],
    });
  });

  it("lists and filters direct Open Access files", async () => {
    const result = await createSmithsonianListFilesHandler(fixture().client)({
      modelId: MODEL_ID,
      fileType: "glb",
    });
    if ("isError" in result) throw new Error("unexpected error");
    expect(result.structuredContent).toMatchObject({
      total: 1,
      license: "Smithsonian Open Access — verify item rights",
      files: [
        {
          fileType: "glb",
          quality: "Thumb",
          dracoCompressed: true,
        },
      ],
    });
  });
});
