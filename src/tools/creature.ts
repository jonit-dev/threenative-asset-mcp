import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CREATURE_LIMITS, type CreatureConfig } from "../config.js";
import {
  CreatureOperationError,
  CreatureRunner,
  type CreatureCompileResult,
} from "../creature/runner.js";
import {
  previewCreature,
  previewError,
} from "../creature/preview.js";

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

export const CreatureCompileInputSchema = z
  .object({
    specPath: z.string().trim().min(1).max(1_000),
    outputPath: z.string().trim().min(1).max(1_000),
    expectedOutputSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

const CreatureLimitsOutputSchema = z.object({
  specBytes: z.literal(CREATURE_LIMITS.specBytes),
  glbBytes: z.literal(CREATURE_LIMITS.glbBytes),
  diagnosticsBytes: z.literal(CREATURE_LIMITS.diagnosticsBytes),
  compileTimeoutMs: z.literal(CREATURE_LIMITS.compileTimeoutMs),
  maxActiveHeavyOperations: z.literal(CREATURE_LIMITS.maxActiveHeavyOperations),
});

const CreatureCompileSuccessSchema = z.object({
  operation: z.literal("creature_compile"),
  specPath: z.string(),
  outputPath: z.string(),
  sourceSnapshotPath: z.string(),
  checksPath: z.string(),
  diagnosticsPath: z.string(),
  receiptPath: z.string(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  checksSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.object({
    version: z.literal(PAYLOAD_VERSION),
    commit: z.literal(PAYLOAD_COMMIT),
    archiveSha256: z.literal(PAYLOAD_ARCHIVE_SHA256),
  }),
  measurements: z.object({
    bytes: z.number().int().positive(),
    bounds: z.object({
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      length: z.number().finite().nonnegative(),
    }),
    vertices: z.number().int().positive(),
    faces: z.number().int().positive(),
    joints: z.number().int().positive(),
    clips: z.array(z.string().min(1)),
  }),
  limits: CreatureLimitsOutputSchema,
  durationMs: z.number().int().nonnegative(),
  unchanged: z.boolean(),
});

const CreatureCompileFailureSchema = z.object({
  operation: z.literal("creature_compile"),
  code: z.enum([
    "INVALID_SPEC",
    "COMPILE_BLOCKED",
    "OUTPUT_INVALID",
    "OUTPUT_CONFLICT",
    "TOOLCHAIN_UNAVAILABLE",
    "TIMEOUT",
    "CANCELLED",
    "BUSY",
  ]),
  message: z.string().min(1).max(2_000),
  detail: z.record(z.string(), z.unknown()),
});

export const CreatureCompileOutputSchema = z.union([
  CreatureCompileSuccessSchema,
  CreatureCompileFailureSchema,
]);

export const CreaturePreviewInputSchema = z
  .object({
    glbPath: z.string().trim().min(1).max(1_000),
    mode: z.enum(["silhouettes", "hero"]),
    previousPreviewId: z.string().regex(/^[a-z0-9-]{8,80}$/u).optional(),
  })
  .strict();

const PreviewArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().positive(),
  included: z.boolean(),
  omittedReason: z.string().max(500).optional(),
});

const PreviewViewSchema = z.object({
  name: z.string().min(1),
  image: PreviewArtifactSchema,
  thumbnail: PreviewArtifactSchema,
  measurements: z.record(z.string(), z.unknown()),
});

const PreviewBackendSchema = z.object({
  id: z.enum(["python-outline", "browser-silmetrics", "browser-hero"]),
  nativeViewNames: z.array(z.string().min(1)).min(1),
  camera: z.object({
    projection: z.literal("perspective"),
    fovDegrees: z.number().finite().positive(),
    resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    distanceMultiplier: z.number().finite().positive().optional(),
    initialDistanceMultiplier: z.number().finite().positive().optional(),
    fitFraction: z.number().finite().positive().optional(),
  }),
});

const CreaturePreviewSuccessSchema = z.object({
  operation: z.literal("creature_preview"),
  mode: z.enum(["silhouettes", "hero"]),
  glbPath: z.string().min(1),
  glbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  previewId: z.string().regex(/^[a-z0-9-]{8,80}$/u),
  receiptPath: z.string().min(1),
  backend: PreviewBackendSchema,
  views: z.array(PreviewViewSchema).min(1),
  encodedImageBudgetBytes: z.literal(4 * 1_024 * 1_024),
  visualReview: z.literal("notReviewed"),
  comparison: z.object({ previousPreviewId: z.string(), compatible: z.literal(true) }).optional(),
});

const CreaturePreviewFailureSchema = z.object({
  operation: z.literal("creature_preview"),
  code: z.enum([
    "INVALID_SPEC",
    "TOOLCHAIN_UNAVAILABLE",
    "TIMEOUT",
    "CANCELLED",
    "BUSY",
    "PREVIEW_COMPARISON",
  ]),
  message: z.string().min(1).max(2_000),
  detail: z.record(z.string(), z.unknown()),
});

export const CreaturePreviewOutputSchema = z.union([
  CreaturePreviewSuccessSchema,
  CreaturePreviewFailureSchema,
]);

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
  limits: CreatureLimitsOutputSchema,
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

let compileRunner: CreatureRunner | undefined;

class CreaturePayloadError extends Error {}

interface Payload {
  readonly guides: Readonly<Record<GuideSection, string>>;
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

async function readPayloadText(
  entries: ReadonlyMap<string, FileEntry>,
  filename: string,
  description: string,
): Promise<string> {
  const entry = entries.get(`${PAYLOAD_ROOT}${filename}`);
  if (!entry) {
    throw new CreaturePayloadError(`The packaged anyCreature ${description} entry is missing.`);
  }
  if (entry.uncompressedSize > 128_000) {
    throw new CreaturePayloadError(`The packaged anyCreature ${description} entry exceeds its size limit.`);
  }
  return entry.getData(new TextWriter());
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
    const fileEntries = new Map(
      entries.filter(isFileEntry).map((entry) => [entry.filename, entry]),
    );
    const version = (await readPayloadText(fileEntries, "VERSION", "version")).trim();
    if (version !== PAYLOAD_VERSION) {
      throw new CreaturePayloadError("The packaged anyCreature version does not match the pin.");
    }
    const guides = {} as Record<GuideSection, string>;
    for (const [section, filename] of Object.entries(GUIDE_FILES) as Array<
      [GuideSection, string]
    >) {
      guides[section] = await readPayloadText(fileEntries, filename, `${section} guide`);
    }
    return { guides };
  } finally {
    await reader.close();
  }
}

async function payload(): Promise<Payload> {
  payloadPromise ??= loadPayload();
  return payloadPromise;
}

function executableNames(executable: string): readonly string[] {
  if (process.platform !== "win32" || extname(executable)) return [executable];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return [executable, ...extensions.map((extension) => `${executable}${extension}`)];
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    await access(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function executableAvailable(executable: string): Promise<boolean> {
  const candidates = isAbsolute(executable)
    ? executableNames(executable)
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => executableNames(join(directory, executable)));
  for (const candidate of candidates) {
    if (await executableFile(candidate)) return true;
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
      creature_compile: compileRunner
        ? { available: true }
        : unavailable("Launch the asset MCP from a project root containing .threenative to enable project-local compilation."),
      creature_preview: compileRunner
        ? { available: true }
        : unavailable("Launch the asset MCP from a project root containing .threenative to enable project-local previews."),
      creature_check: unavailable("Creature inspection is not available until a later asset-MCP increment."),
    },
    tooling: {
      compiler: compileRunner
        ? { available: true }
        : unavailable("The pinned compiler is packaged; project-local compilation is inactive in this launch root."),
      pythonSilhouettes: pythonAvailable
        ? { available: true, executable: "python3" }
        : {
            available: false,
            executable: "python3",
            reason: "python3 is optional and was not found on PATH.",
          },
      chromiumRender: compileRunner
        ? { available: true, reason: "Chromium is probed when a browser preview is requested; missing browsers return an actionable operation error." }
        : unavailable("Chromium rendering is probed when the preview increment is active."),
    },
    limits: compileRunner?.limits ?? CREATURE_LIMITS,
    setup: [
      "Use creature_guide with section 'syntax' to author a pinned anyCreature 1.3.1 spec.",
      compileRunner
        ? "Use creature_compile with project-relative specPath and outputPath values; no browser, credential, setup script, or runtime download is required."
        : "Create .threenative/creatures in the project launch root and restart this server to activate creature_compile.",
      compileRunner
        ? "Use creature_preview with mode 'silhouettes' or 'hero'; missing optional render dependencies return an actionable failure and do not approve the image."
        : "Preview and inspection remain unavailable until a project-local compiler is active.",
    ],
  });
}

function compileFailure(error: unknown) {
  if (error instanceof CreatureOperationError) {
    return CreatureCompileFailureSchema.parse({
      operation: "creature_compile",
      code: error.code,
      message: error.message,
      detail: error.detail,
    });
  }
  return CreatureCompileFailureSchema.parse({
    operation: "creature_compile",
    code: "TOOLCHAIN_UNAVAILABLE",
    message: "The creature compiler could not complete the local operation.",
    detail: {},
  });
}

export function activateCreatureCompilation(
  config: CreatureConfig,
  launchRoot: string,
): CreatureRunner {
  compileRunner = new CreatureRunner(config, launchRoot, {
    archivePath: PAYLOAD_PATH,
    archiveSha256: PAYLOAD_ARCHIVE_SHA256,
    version: PAYLOAD_VERSION,
    commit: PAYLOAD_COMMIT,
    root: PAYLOAD_ROOT,
    files: PAYLOAD_FILES,
  });
  return compileRunner;
}

export function registerCreatureCompileTool(
  server: McpServer,
  runner: CreatureRunner,
): void {
  server.registerTool(
    "creature_compile",
    {
      title: "Compile a project creature",
      description:
        "Compile a bounded project-relative anyCreature JSON spec with the fixed packaged 1.3.1 compiler, validate its GLB, and publish it atomically with hash-bound evidence.",
      inputSchema: CreatureCompileInputSchema,
      outputSchema: CreatureCompileOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createCreatureCompileHandler(runner),
  );
  server.registerTool(
    "creature_preview",
    {
      title: "Preview a compiled creature",
      description:
        "Render fresh, bounded silhouettes or a hero image for a project-relative creature GLB and return image artifacts with backend and camera identity; visual approval remains independent.",
      inputSchema: CreaturePreviewInputSchema,
      outputSchema: CreaturePreviewOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createCreaturePreviewHandler(runner),
  );
}

export function createCreatureCompileHandler(runner: CreatureRunner) {
  return async (
    rawInput: z.input<typeof CreatureCompileInputSchema>,
    context: ServerContext,
  ) => {
    try {
      const input = CreatureCompileInputSchema.parse(rawInput);
      const output: CreatureCompileResult = await runner.compile(
        {
          specPath: input.specPath,
          outputPath: input.outputPath,
          ...(input.expectedOutputSha256
            ? { expectedOutputSha256: input.expectedOutputSha256 }
            : {}),
        },
        context.mcpReq.signal,
      );
      const validated = CreatureCompileSuccessSchema.parse(output);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(validated) }],
        structuredContent: validated,
      };
    } catch (error) {
      const output = compileFailure(error);
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  };
}

export function createCreaturePreviewHandler(runner: CreatureRunner) {
  return async (
    rawInput: z.input<typeof CreaturePreviewInputSchema>,
    context: ServerContext,
  ) => {
    try {
      const input = CreaturePreviewInputSchema.parse(rawInput);
      const result = await previewCreature(
        runner,
        {
          glbPath: input.glbPath,
          mode: input.mode,
          ...(input.previousPreviewId
            ? { previousPreviewId: input.previousPreviewId }
            : {}),
        },
        context.mcpReq.signal,
      );
      const output = CreaturePreviewSuccessSchema.parse(result.output);
      return {
        content: [
          ...result.content,
          { type: "text" as const, text: JSON.stringify(output) },
        ],
        structuredContent: output,
      };
    } catch (error) {
      const output = CreaturePreviewOutputSchema.parse(previewError(error));
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  };
}

async function guide(section: GuideSection): Promise<CreatureGuideOutput> {
  const archive = await payload();
  return CreatureGuideOutputSchema.parse({
    section,
    guide: archive.guides[section],
    ...metadata(),
  });
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
