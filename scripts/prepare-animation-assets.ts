import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { NodeIO } from "@gltf-transform/core";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";

import { buildDonorGlb } from "../src/rig/donor.js";
import {
  inspectGltfDocument,
  RIG_LIMITS,
  sha256,
} from "../src/rig/inspect.js";

interface LibraryArgument {
  id: string;
  archivePath: string;
  sourceUrl: string;
}

interface CatalogClip {
  id: string;
  library: string;
  name: string;
  variant: "in_place" | "root_motion";
  entry: string;
  entrySha256: string;
  channels: number;
  durationSeconds: number | null;
  calibration: boolean;
  donor: { url: string; sha256: string; bytes: number; joints: number };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function isCalibration(name: string): boolean {
  return /t[\s_-]?pose/i.test(name);
}

async function readArchiveGlbs(
  archivePath: string,
): Promise<{ archiveBytes: Uint8Array; entries: Array<{ path: string; bytes: Uint8Array }> }> {
  const archiveBytes = new Uint8Array(await readFile(archivePath));
  const reader = new ZipReader(new Uint8ArrayReader(archiveBytes), { strictness: "strict" });
  try {
    const all = await reader.getEntries();
    const entries: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const entry of all as FileEntry[]) {
      if (entry.directory || !entry.filename.toLowerCase().endsWith(".glb")) continue;
      entries.push({
        path: entry.filename,
        bytes: await entry.getData(new Uint8ArrayWriter()),
      });
    }
    return { archiveBytes, entries };
  } finally {
    await reader.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      ual1: { type: "string" },
      ual2: { type: "string" },
      out: { type: "string" },
      "base-url": { type: "string" },
    },
  });
  const outputDir = values.out;
  const baseUrl = values["base-url"];
  if (!outputDir || !baseUrl) {
    throw new Error("Usage: prepare-animation-assets --out <dir> --base-url <release-url> [--ual1 <zip>] [--ual2 <zip>]");
  }

  const libraries: LibraryArgument[] = [];
  if (values.ual1) {
    libraries.push({
      id: "ual1",
      archivePath: values.ual1,
      sourceUrl: "https://quaternius.itch.io/universal-animation-library",
    });
  }
  if (values.ual2) {
    libraries.push({
      id: "ual2",
      archivePath: values.ual2,
      sourceUrl: "https://quaternius.itch.io/universal-animation-library-2",
    });
  }
  if (libraries.length === 0) {
    throw new Error("At least one of --ual1 or --ual2 is required.");
  }

  const io = new NodeIO();
  const clips: CatalogClip[] = [];
  const librarySummaries: Array<{
    id: string;
    sourceUrl: string;
    archiveSha256: string;
  }> = [];
  const exporterVersion = (
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;

  for (const library of libraries) {
    const { archiveBytes, entries } = await readArchiveGlbs(library.archivePath);
    const archiveSha256 = sha256(archiveBytes);
    librarySummaries.push({
      id: library.id,
      sourceUrl: library.sourceUrl,
      archiveSha256,
    });
    for (const entry of entries) {
      const document = await io.readBinary(entry.bytes);
      const report = inspectGltfDocument(document, RIG_LIMITS);
      if (report.animations.length === 0) continue;
      const variant = /_rm\.glb$/i.test(entry.path) ? "root_motion" : "in_place";
      const entrySha256 = sha256(entry.bytes);
      for (const animation of report.animations) {
        const donor = await buildDonorGlb(entry.bytes, animation.index, io);
        const fileName = `${library.id}__${variant}__${sanitize(animation.name)}.glb`;
        const outputPath = join(outputDir, fileName);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, donor.bytes);

        const reloaded = await io.readBinary(donor.bytes);
        const reloadedJoints = reloaded
          .getRoot()
          .listSkins()
          .reduce((sum, skin) => sum + skin.listJoints().length, 0);
        if (reloadedJoints !== donor.joints) {
          throw new Error(`${fileName}: donor joints ${reloadedJoints} != ${donor.joints}.`);
        }
        if (reloaded.getRoot().listAnimations().length !== 1) {
          throw new Error(`${fileName}: donor must carry exactly one animation.`);
        }
        if (reloaded.getRoot().listSkins()[0]?.getInverseBindMatrices() === null) {
          throw new Error(`${fileName}: donor lost its inverse-bind matrices.`);
        }

        clips.push({
          id: `${library.id}/${animation.name}`,
          library: library.id,
          name: animation.name,
          variant,
          entry: entry.path,
          entrySha256,
          channels: animation.channels,
          durationSeconds: animation.durationSeconds,
          calibration: isCalibration(animation.name),
          donor: {
            url: `${baseUrl.replace(/\/$/, "")}/${fileName}`,
            sha256: sha256(donor.bytes),
            bytes: donor.bytes.byteLength,
            joints: donor.joints,
          },
        });
      }
    }
  }

  clips.sort((left, right) => left.id.localeCompare(right.id) || left.variant.localeCompare(right.variant));
  const catalog = {
    exporterVersion,
    generatedBy: "scripts/prepare-animation-assets.ts",
    libraries: librarySummaries,
    clips,
    donorBytes: clips.reduce((sum, clip) => sum + clip.donor.bytes, 0),
  };
  await writeFile(join(outputDir, "animation-catalog.json"), `${JSON.stringify(catalog)}\n`);

  console.log(
    `Prepared ${clips.length} donor GLBs (${clips.reduce((sum, clip) => sum + clip.donor.bytes, 0)} bytes) from ${libraries.length} libraries.`,
  );
  console.log(`Catalog: ${join(outputDir, "animation-catalog.json")}`);
}

await main();
