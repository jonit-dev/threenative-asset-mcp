import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import { z } from "zod";

const PAYLOAD_VERSION = "1.3.1";
const PAYLOAD_COMMIT = "44e1abc2c7fe083f19f989c8437c44a141adc7f3";
const PAYLOAD_ARCHIVE_SHA256 =
  "cc25c9a9c170d43741803d5531f853bc89ebfd58a98d9fdda90834c53822084d";
const PAYLOAD_ROOT = `anyCreature-${PAYLOAD_VERSION}/`;
const PAYLOAD_PATH = fileURLToPath(
  new URL("../../vendor/anycreature-1.3.1.zip", import.meta.url),
);

const PAYLOAD_FILES = [
  ".github/workflows/smoke.yml",
  ".gitignore",
  "CHANGELOG.md",
  "LICENSE",
  "MANUAL.md",
  "README.md",
  "SECURITY.md",
  "THIRD-PARTY-NOTICES.md",
  "VERSION",
  "assets/hero.png",
  "assets/silhouettes.png",
  "calibration/red_5050.json",
  "calibration/wolf_green.json",
  "calibration/wolf_red.json",
  "cards/00_START.md",
  "cards/01_LOW.md",
  "cards/02_MID.md",
  "cards/03_HIGH.md",
  "cards/04_SHIP.md",
  "cards/SYNTAX.md",
  "docs/HANDOVER_sanitize.md",
  "docs/OUTPUT_CONTRACT.md",
  "engine/cli.js",
  "engine/core/anim.js",
  "engine/core/ao.js",
  "engine/core/checks.js",
  "engine/core/compile.js",
  "engine/core/contract.js",
  "engine/core/geometry.js",
  "engine/core/glb.js",
  "engine/core/normals.js",
  "engine/core/relative.js",
  "engine/core/section.js",
  "engine/core/shade.js",
  "engine/core/skeleton.js",
  "engine/core/uv.js",
  "example/README.md",
  "example/wolf.glb",
  "example/wolf.json",
  "example/wolf_beauty.png",
  "example/wolf_silhouette.png",
  "example/wolf_thumb24.png",
  "harness/assets/showroom.html",
  "harness/assets/three-bundle.js",
  "harness/brief.py",
  "harness/calibrate.py",
  "harness/canary/answers.json",
  "harness/canary/ball.png",
  "harness/canary/spike.png",
  "harness/canary/wolf_side.png",
  "harness/claims.json",
  "harness/deliver.py",
  "harness/fit.py",
  "harness/gates.json",
  "harness/gates.py",
  "harness/glbcheck.mjs",
  "harness/gobkit.json",
  "harness/graft.py",
  "harness/hero.mjs",
  "harness/identity.py",
  "harness/judge.mjs",
  "harness/maskmetrics.py",
  "harness/outline.py",
  "harness/partreads.py",
  "harness/publish.mjs",
  "harness/pwlaunch.mjs",
  "harness/pwprobe.mjs",
  "harness/round.py",
  "harness/roundcheck.py",
  "harness/ship.py",
  "harness/silmetrics.mjs",
  "harness/specs/_TEMPLATE.json",
  "harness/synccheck.py",
  "harness/wash.py",
  "setup.ps1",
  "setup.sh",
  "tools/sync-contract.mjs",
] as const;

const GUIDE_FILES = {
  overview: "README.md",
  syntax: "cards/SYNTAX.md",
  low: "cards/01_LOW.md",
  mid: "cards/02_MID.md",
  high: "cards/03_HIGH.md",
  delivery: "cards/04_SHIP.md",
} as const;

type GuideSection = keyof typeof GUIDE_FILES;

export const CreatureStatusInputSchema = z.object({}).strict();
export const CreatureGuideInputSchema = z
  .object({ section: z.enum(["overview", "syntax", "low", "mid", "high", "delivery"]) })
  .strict();

const AvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.string().max(1_000).optional(),
});

const IntegritySchema = z.object({
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().positive(),
  files: z.array(z.string().min(1)).min(1),
});

const AttributionSchema = z.object({
  upstream: z.string().max(200),
  license: z.literal("MIT"),
  copyright: z.string().max(1_000),
  notices: z.string().max(1_000),
});

const UpstreamSchema = z.object({
  repository: z.url(),
  version: z.literal(PAYLOAD_VERSION),
  commit: z.literal(PAYLOAD_COMMIT),
});

export const CreatureStatusOutputSchema = z.object({
  upstream: UpstreamSchema,
  integrity: IntegritySchema,
  attribution: AttributionSchema,
  operations: z.object({
    creature_status: AvailabilitySchema,
    creature_guide: AvailabilitySchema,
    creature_compile: AvailabilitySchema,
    creature_preview: AvailabilitySchema,
    creature_check: AvailabilitySchema,
  }),
  tooling: z.object({
    compiler: AvailabilitySchema,
    pythonSilhouettes: AvailabilitySchema.extend({ executable: z.literal("python3") }),
    chromiumRender: AvailabilitySchema,
  }),
  setup: z.array(z.string().max(1_000)).min(1).max(5),
});

export const CreatureGuideOutputSchema = z.object({
  section: z.enum(["overview", "syntax", "low", "mid", "high", "delivery"]),
  guide: z.string().min(1).max(128_000),
  upstream: UpstreamSchema,
  integrity: IntegritySchema,
  attribution: AttributionSchema,
});

type CreatureStatusOutput = z.output<typeof CreatureStatusOutputSchema>;
type CreatureGuideOutput = z.output<typeof CreatureGuideOutputSchema>;

class CreaturePayloadError extends Error {}

interface Payload {
  readonly entries: ReadonlyMap<string, Entry>;
}

let payloadPromise: Promise<Payload> | undefined;

function metadata() {
  return {
    upstream: {
      repository: "https://github.com/Ariescar/anyCreature",
      version: PAYLOAD_VERSION,
      commit: PAYLOAD_COMMIT,
    },
    integrity: {
      archiveSha256: PAYLOAD_ARCHIVE_SHA256,
      fileCount: PAYLOAD_FILES.length,
      files: [...PAYLOAD_FILES],
    },
    attribution: {
      upstream: "anyCreature by Ariescar",
      license: "MIT" as const,
      copyright: "Copyright (c) 2026 Alsomind Tech Co., Ltd.",
      notices:
        "The anyCreature engine and harness scripts are original work by Ariescar; bundled three.js retains its MIT notice.",
    },
  };
}

function sameInventory(actual: readonly string[]): boolean {
  return (
    actual.length === PAYLOAD_FILES.length &&
    actual.every((entry, index) => entry === PAYLOAD_FILES[index])
  );
}

function isFileEntry(entry: Entry): entry is FileEntry {
  return !entry.directory;
}

async function loadPayload(): Promise<Payload> {
  const archive = await readFile(PAYLOAD_PATH).catch(() => {
    throw new CreaturePayloadError("The packaged anyCreature payload is missing.");
  });
  if (createHash("sha256").update(archive).digest("hex") !== PAYLOAD_ARCHIVE_SHA256) {
    throw new CreaturePayloadError("The packaged anyCreature payload failed its SHA-256 check.");
  }

  const reader = new ZipReader(new Uint8ArrayReader(archive));
  try {
    const entries = await reader.getEntries();
    const files = entries
      .filter(isFileEntry)
      .map((entry) => entry.filename)
      .sort();
    const inventory = files.map((entry) => entry.slice(PAYLOAD_ROOT.length));
    if (
      files.some((entry) => !entry.startsWith(PAYLOAD_ROOT)) ||
      !sameInventory(inventory)
    ) {
      throw new CreaturePayloadError("The packaged anyCreature payload inventory is invalid.");
    }
    const versionEntry = entries.find(
      (entry) => entry.filename === `${PAYLOAD_ROOT}VERSION` && !entry.directory,
    );
    if (!versionEntry || !isFileEntry(versionEntry)) {
      throw new CreaturePayloadError("The packaged anyCreature version entry is missing.");
    }
    const version = (await versionEntry.getData(new TextWriter())).trim();
    if (version !== PAYLOAD_VERSION) {
      throw new CreaturePayloadError("The packaged anyCreature version does not match the pin.");
    }
    return { entries: new Map(entries.map((entry) => [entry.filename, entry])) };
  } finally {
    await reader.close();
  }
}

async function payload(): Promise<Payload> {
  payloadPromise ??= loadPayload();
  return payloadPromise;
}

async function executableAvailable(executable: string): Promise<boolean> {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = isAbsolute(executable) ? executable : join(directory, executable);
    try {
      await access(candidate);
      return true;
    } catch {
      // Continue through PATH; a missing optional tool must not prevent guide access.
    }
  }
  return false;
}

function unavailable(reason: string) {
  return { available: false, reason };
}

function safeError(error: unknown) {
  return {
    code: error instanceof CreaturePayloadError ? "CREATURE_PAYLOAD_UNAVAILABLE" : "CREATURE_INTERNAL",
    message:
      error instanceof CreaturePayloadError
        ? error.message
        : "The creature discovery tool could not complete the request.",
  };
}

async function status(): Promise<CreatureStatusOutput> {
  await payload();
  const pythonAvailable = await executableAvailable("python3");
  return CreatureStatusOutputSchema.parse({
    ...metadata(),
    operations: {
      creature_status: { available: true },
      creature_guide: { available: true },
      creature_compile: unavailable("Compilation is not available until the next asset-MCP increment."),
      creature_preview: unavailable("Preview rendering is not available until a later asset-MCP increment."),
      creature_check: unavailable("Creature inspection is not available until a later asset-MCP increment."),
    },
    tooling: {
      compiler: unavailable("The pinned compiler is packaged but intentionally not activated in this increment."),
      pythonSilhouettes: pythonAvailable
        ? { available: true, executable: "python3" }
        : {
            available: false,
            executable: "python3",
            reason: "python3 is optional and was not found on PATH.",
          },
      chromiumRender: unavailable("Chromium rendering is not available until the preview increment."),
    },
    setup: [
      "Use creature_guide with section 'syntax' to author a pinned anyCreature 1.3.1 spec.",
      "Compilation, preview, and inspection are intentionally unavailable in this increment; no browser, credential, or upstream setup is required for discovery.",
    ],
  });
}

async function guide(section: GuideSection): Promise<CreatureGuideOutput> {
  const archive = await payload();
  const entry = archive.entries.get(`${PAYLOAD_ROOT}${GUIDE_FILES[section]}`);
  if (!entry || !isFileEntry(entry)) {
    throw new CreaturePayloadError("The requested guide entry is missing from the packaged payload.");
  }
  const text = await entry.getData(new TextWriter());
  return CreatureGuideOutputSchema.parse({ section, guide: text, ...metadata() });
}

export function createCreatureStatusHandler() {
  return async (rawInput: z.input<typeof CreatureStatusInputSchema>) => {
    try {
      CreatureStatusInputSchema.parse(rawInput);
      const output = await status();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safeError(error)) }],
      };
    }
  };
}

export function createCreatureGuideHandler() {
  return async (rawInput: z.input<typeof CreatureGuideInputSchema>) => {
    try {
      const { section } = CreatureGuideInputSchema.parse(rawInput);
      const output = await guide(section);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safeError(error)) }],
      };
    }
  };
}
