import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { ItchAssetClient } from "../src/itch/client.js";
import {
  createItchDownloadHandler,
  createItchListDownloadsHandler,
} from "../src/tools/itch.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-itch-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture() {
  const signedPage =
    "https://brackeysgames.itch.io/brackeys-vfx-bundle/download/signed-page-token";
  const signedFile =
    "https://itchio-mirror.0123456789abcdef.r2.cloudflarestorage.com/upload2/game/4191627/16114075?X-Amz-Signature=test";
  const html = `
    <div class="upload">
      <a class="button download_btn" data-upload_id="16114075">Download</a>
      <div class="upload_name"><strong title="Brackeys VFX Bundle v1">Brackeys VFX Bundle v1</strong>
      <span class="file_size"><span>26 MB</span></span></div>
    </div>`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/download_url") && init?.method === "POST") {
      return Response.json({ url: signedPage });
    }
    if (url === signedPage) {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.includes("/file/16114075") && init?.method === "POST") {
      return Response.json({ external: false, url: signedFile });
    }
    if (url === signedFile) {
      return new Response(new Uint8Array([80, 75, 3, 4, 9]), {
        status: 200,
        headers: { "content-length": "5", "content-type": "application/zip" },
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  return { fetch, signedPage, signedFile };
}

describe("curated itch.io downloads", () => {
  it("lists no-account downloads without exposing the signed page token", async () => {
    const { fetch, signedPage } = fixture();
    const client = new ItchAssetClient({
      fetch,
      downloader: new DirectAssetDownloader({ fetch }),
    });
    const result = await createItchListDownloadsHandler(client)({
      packId: "brackeys-vfx-bundle",
    });

    if ("isError" in result) throw new Error(JSON.stringify(result));
    expect(result.structuredContent).toMatchObject({
      packId: "brackeys-vfx-bundle",
      license: "CC0",
      attributionRequired: false,
      downloads: [
        {
          uploadId: "16114075",
          name: "Brackeys VFX Bundle v1",
          sizeLabel: "26 MB",
          suggestedFileName: "Brackeys VFX Bundle v1.zip",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(signedPage);
  });

  it("resolves a fresh signed URL and downloads through guarded MCP storage", async () => {
    const { fetch, signedFile } = fixture();
    const downloadDir = await temporaryDirectory();
    const client = new ItchAssetClient({
      fetch,
      downloader: new DirectAssetDownloader({ fetch, downloadDir }),
    });
    const handler = createItchDownloadHandler(client);

    const result = await handler({
      packId: "brackeys-vfx-bundle",
      uploadId: "16114075",
      acceptLicense: true,
    });

    if ("isError" in result) throw new Error(JSON.stringify(result));
    expect(result.structuredContent).toMatchObject({
      packId: "brackeys-vfx-bundle",
      uploadId: "16114075",
      fileName: "Brackeys VFX Bundle v1.zip",
      sizeBytes: 5,
      license: "CC0",
      attributionRequired: false,
    });
    expect(result.structuredContent.sourcePageUrl).toBe(
      "https://brackeysgames.itch.io/brackeys-vfx-bundle",
    );
    expect(JSON.stringify(result)).not.toContain(signedFile);
    expect(await readFile(result.structuredContent.path)).toEqual(
      Buffer.from([80, 75, 3, 4, 9]),
    );
  });

  it("rejects upload IDs not present on the freshly resolved page", async () => {
    const { fetch } = fixture();
    const client = new ItchAssetClient({
      fetch,
      downloader: new DirectAssetDownloader({ fetch }),
    });
    const result = await createItchDownloadHandler(client)({
      packId: "brackeys-vfx-bundle",
      uploadId: "999",
      acceptLicense: true,
    });

    expect(JSON.stringify(result)).toContain("ITCH_UPLOAD_NOT_FOUND");
  });
});
