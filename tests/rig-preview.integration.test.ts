import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { previewAvailable } from "../src/rig/preview.js";
import { createAssetAutoRigHandler, createAssetPreviewAnimationHandler } from "../src/tools/rig.js";
import { unriggedBipedGlb } from "./helpers/rig-fixture.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-preview-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface HandlerResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function call(
  handler:
    | ReturnType<typeof createAssetAutoRigHandler>
    | ReturnType<typeof createAssetPreviewAnimationHandler>,
  input: unknown,
) {
  return (await handler(input as never)) as unknown as HandlerResult;
}

describe("asset_preview_animation", () => {
  it("renders a nonblank multi-angle sheet for a rigged model, or reports unavailable", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const rigged = join(directory, "rigged.glb");
    const riggedResult = await call(createAssetAutoRigHandler(), {
      target,
      output: rigged,
      projectRoot: directory,
    });
    expect(riggedResult.isError).toBeUndefined();

    const output = join(directory, "sheet.png");
    const result = await call(createAssetPreviewAnimationHandler(), {
      prepared: rigged,
      output,
      projectRoot: directory,
      times: [0],
      angles: 2,
      width: 128,
      height: 128,
      pose: { bone: "upper_arm.L", axis: "z", degrees: -45 },
    });
    expect(result.isError).toBeUndefined();

    if (previewAvailable()) {
      expect(result.structuredContent.status).toBe("rendered");
      expect(result.structuredContent.backend).toContain("playwright-chromium");
      const images = result.structuredContent.images as Array<{ nonBlank: boolean }>;
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.nonBlank)).toBe(true);
      expect(existsSync(output)).toBe(true);
    } else {
      expect(result.structuredContent.status).toBe("unavailable");
      expect(result.structuredContent.reason).toContain("Chromium");
    }
  });
});
