import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserFabTransport,
  type BrowserLocator,
} from "../src/fab/browser-transport.js";
import { createDownloadFreeAssetHandler } from "../src/tools/download-free-asset.js";

const LISTING_ID = "ef194997-eb8c-4fc0-9d11-dad28d00eaa2";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function locator(options: {
  count?: number;
  click?: () => Promise<void>;
  waitFor?: () => Promise<void>;
} = {}): BrowserLocator {
  return {
    count: vi.fn(async () => options.count ?? 0),
    click: vi.fn(async () => options.click?.()),
    waitFor: vi.fn(async () => options.waitFor?.()),
  };
}

async function downloadTransport(options: {
  buyNow?: boolean;
  libraryOnly?: boolean;
  eulaRequired?: boolean;
} = {}) {
  const downloadDir = await mkdtemp(
    join(tmpdir(), "threenative-asset-mcp-fab-download-"),
  );
  temporaryDirectories.push(downloadDir);
  let currentUrl = "https://www.fab.com/";
  const saveAs = vi.fn(async (path: string) => {
    await writeFile(path, "verified-free-glb");
  });
  const openDownload = locator({
    count: options.buyNow || options.libraryOnly ? 0 : 1,
  });
  const formatDownload = locator({
    count: options.eulaRequired ? 0 : 1,
    ...(options.eulaRequired
      ? {
          waitFor: async () => {
            throw new Error("EULA shown");
          },
        }
      : {}),
  });
  let evaluateCalls = 0;
  const page = {
    url: () => currentUrl,
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    evaluate: vi.fn(async () => {
      evaluateCalls += 1;
      if (options.eulaRequired && evaluateCalls > 1) {
        return { eulaVisible: true };
      }
      return {
        origin: "https://www.fab.com",
        challengeVisible: false,
      };
    }),
    getByRole: vi.fn((_role: string, roleOptions: { name: string }) => {
      if (roleOptions.name === "Download") return openDownload;
      if (roleOptions.name === "Download GLB asset") {
        return formatDownload;
      }
      if (roleOptions.name === "Buy now") {
        return locator({ count: options.buyNow ? 1 : 0 });
      }
      if (roleOptions.name === "Add to My Library") {
        return locator({ count: options.libraryOnly ? 1 : 0 });
      }
      return locator();
    }),
    waitForEvent: vi.fn(async () => ({
      suggestedFilename: () => "glb.zip",
      saveAs,
      failure: vi.fn(async () => null),
    })),
  };
  const context = {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const transport = new BrowserFabTransport({
    timeoutMs: 1_000,
    headless: true,
    profileDir: join(downloadDir, "profile"),
    downloadDir,
    launchContext: vi.fn(async () => context),
  });
  return { transport, downloadDir, saveAs };
}

describe("free Fab downloads", () => {
  it("requires explicit Fab EULA acknowledgement in the MCP input", async () => {
    const client = {
      downloadFreeAsset: vi.fn(async () => {
        throw new Error("must not run");
      }),
    };
    const handler = createDownloadFreeAssetHandler(client);

    const result = await handler({
      listingIdOrUrl: LISTING_ID,
      format: "glb",
      acceptFabEula: false as true,
    });

    expect(result).toMatchObject({ isError: true });
    expect(client.downloadFreeAsset).not.toHaveBeenCalled();
  });

  it("downloads a public free format into the dedicated directory", async () => {
    const { transport, downloadDir } = await downloadTransport();

    const result = await transport.downloadFreeAsset({
      listingId: LISTING_ID,
      format: "glb",
    });

    expect(result).toMatchObject({
      listingId: LISTING_ID,
      format: "glb",
      fileName: "glb.zip",
      sizeBytes: 17,
      alreadyExisted: false,
      authentication: "not-required",
    });
    expect(result.path.startsWith(downloadDir)).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(result.path, "utf8")).toBe("verified-free-glb");
    await transport.close();
  });

  it("does not overwrite a file that was already downloaded", async () => {
    const { transport, saveAs } = await downloadTransport();
    const request = { listingId: LISTING_ID, format: "glb" as const };

    const first = await transport.downloadFreeAsset(request);
    const second = await transport.downloadFreeAsset(request);

    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(saveAs).toHaveBeenCalledTimes(1);
    await transport.close();
  });

  it("refuses to turn a download into an acquisition", async () => {
    const { transport } = await downloadTransport({ buyNow: true });

    await expect(
      transport.downloadFreeAsset({
        listingId: LISTING_ID,
        format: "glb",
      }),
    ).rejects.toMatchObject({ code: "FAB_ACQUISITION_REQUIRED" });
    await transport.close();
  });

  it("classifies library-only formats separately", async () => {
    const { transport } = await downloadTransport({ libraryOnly: true });

    await expect(
      transport.downloadFreeAsset({
        listingId: LISTING_ID,
        format: "glb",
      }),
    ).rejects.toMatchObject({ code: "FAB_LIBRARY_REQUIRED" });
    await transport.close();
  });

  it("requires visible EULA completion when Fab presents it", async () => {
    const { transport } = await downloadTransport({ eulaRequired: true });

    await expect(
      transport.downloadFreeAsset({
        listingId: LISTING_ID,
        format: "glb",
      }),
    ).rejects.toMatchObject({ code: "FAB_EULA_REQUIRED" });
    await transport.close();
  });
});
