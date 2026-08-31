import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { FabClient } from "../fab/client.js";
import { FabCli, FabCliError, preferredPlatform } from "../fab/fabcli.js";
import { classifyLicenses, type LicenseDecision } from "../fab/license.js";
import { normalizeListing } from "../fab/normalize.js";
import { ImportError, type ImportReport, importUnrealDirectory } from "../unreal/importer.js";
import { ToolchainError } from "../unreal/toolchain.js";
import { parseListingId } from "./get-asset.js";

const SummarySchema = z.object({
  outputDir: z.string().max(4_096),
  reportPath: z.string().max(4_096),
  materials: z.enum(["complete", "degraded"]),
  reused: z.boolean(),
  counts: z.object({
    packages: z.number().int().nonnegative(),
    exported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  materialCoverage: z.object({
    sections: z.number().int().nonnegative(),
    textured: z.number().int().nonnegative(),
    exact: z.number().int().nonnegative(),
    heuristic: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  license: z
    .object({
      verdict: z.string().max(40),
      slugs: z.array(z.string().max(60)).max(30),
      reason: z.string().max(600),
    })
    .optional(),
  models: z.array(
    z.object({
      name: z.string().max(200),
      glb: z.string().max(1_024),
      bytes: z.number().int().nonnegative(),
      vertices: z.number().int().nonnegative(),
      textured: z.boolean(),
    }),
  ),
  skipped: z.array(z.object({ package: z.string().max(1_024), reason: z.string().max(2_000) })),
  failed: z.array(z.object({ package: z.string().max(1_024), reason: z.string().max(2_000) })),
  warnings: z.array(z.string().max(500)),
  durationMs: z.number().int().nonnegative(),
});

export type ImportSummary = z.output<typeof SummarySchema>;

const OutputDirSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe(
    "Directory the source GLBs are written to, normally <game>/assets/fab/<listing-id>. It must not already hold a different import; this tool never overwrites one.",
  );

const MaxTextureSizeSchema = z.coerce
  .number()
  .int()
  .min(64)
  .max(8_192)
  .optional()
  .describe(
    "Optional longest edge for embedded textures. Leave unset to keep Unreal's own resolution and let the ThreeNative asset compiler cap it.",
  );

export const AssetImportUnrealInputSchema = z.object({
  sourceDir: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .describe("A local directory of Unreal .uasset files, for example an already downloaded Fab pack."),
  outputDir: OutputDirSchema,
  maxTextureSize: MaxTextureSizeSchema,
});

export const FabImportAssetInputSchema = z.object({
  listingIdOrUrl: z.string().trim().min(1).max(500),
  outputDir: OutputDirSchema,
  engine: z
    .string()
    .trim()
    .regex(/^UE_\d+\.\d+$/)
    .optional()
    .describe("Unreal engine selector, for example UE_4.21. Required when the listing publishes several artifacts."),
  maxTextureSize: MaxTextureSizeSchema,
  platform: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,32}$/)
    .optional()
    .describe("Platform build to download when the artifact publishes several, for example Windows."),
  acceptFabEula: z.literal(true).describe(
    "Required acknowledgement that the user accepts the Fab EULA for the listing they already own.",
  ),
});

export const ImportUnrealOutputSchema = SummarySchema;

export function summarize(report: ImportReport, outputDir: string): ImportSummary {
  return SummarySchema.parse({
    outputDir,
    reportPath: join(outputDir, "import-report.json"),
    materials: report.materials,
    reused: report.reused,
    counts: report.counts,
    materialCoverage: report.materialCoverage,
    ...(report.entitlement.license ? { license: report.entitlement.license } : {}),
    models: report.models.map((model) => ({
      name: model.name,
      glb: model.glb,
      bytes: model.bytes,
      vertices: model.vertices,
      textured: model.materials.some((section) => section.textured),
    })),
    skipped: report.skipped.slice(0, 400),
    failed: report.failed.slice(0, 400),
    warnings: report.warnings,
    durationMs: report.durationMs,
  });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof ImportError || error instanceof ToolchainError || error instanceof FabCliError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : error instanceof z.ZodError
        ? {
            code: "UNREAL_IMPORT_INVALID_INPUT",
            message: "The Unreal import input is invalid.",
            retryable: false,
          }
        : {
            code: "UNREAL_IMPORT_INTERNAL",
            message: "The asset MCP could not complete the Unreal import.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export interface ImportUnrealDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly importDirectory?: typeof importUnrealDirectory;
  readonly fabCli?: FabCli;
  /** Injected in tests; production reads the listing's published licences from Fab. */
  readonly readLicenses?: (listingId: string) => Promise<readonly string[]>;
}

/**
 * Reads the licences Fab publishes for a listing. Anonymous and read-only: the entitlement check
 * must not depend on the authenticated path it is guarding.
 */
async function readPublishedLicenses(listingId: string): Promise<readonly string[]> {
  const client = new FabClient();
  try {
    const result = await client.getListing(listingId, "USD");
    return normalizeListing(result.payload, "USD", result.transport).licenses.map(
      (license) => license.slug,
    );
  } finally {
    await client.close();
  }
}

/**
 * Refuses anything but Fab Standard or CC-BY, before a byte is downloaded. A licence lookup that
 * fails is a refusal too: "could not check" is not "may use".
 */
export async function requirePermittedLicense(
  listingId: string,
  read: (listingId: string) => Promise<readonly string[]>,
): Promise<LicenseDecision> {
  let slugs: readonly string[];
  try {
    slugs = await read(listingId);
  } catch (error) {
    throw new FabCliError(
      "FABCLI_LICENSE_UNVERIFIED",
      `The licence for listing ${listingId} could not be read (${error instanceof Error ? error.name : "lookup failed"}), so the import stopped before downloading anything. Only Fab Standard (Personal or Professional) and CC-BY assets are imported.`,
      true,
    );
  }
  const decision = classifyLicenses(slugs);
  if (decision.verdict === "allowed") return decision;
  throw new FabCliError(
    decision.verdict === "rejected"
      ? "FABCLI_LICENSE_NOT_PERMITTED"
      : "FABCLI_LICENSE_UNVERIFIED",
    decision.reason,
  );
}

export function createAssetImportUnrealHandler(dependencies: ImportUnrealDependencies = {}) {
  const runImport = dependencies.importDirectory ?? importUnrealDirectory;
  return async (rawInput: z.input<typeof AssetImportUnrealInputSchema>) => {
    try {
      const input = AssetImportUnrealInputSchema.parse(rawInput);
      const outputDir = resolve(input.outputDir);
      const report = await runImport({
        sourceDir: resolve(input.sourceDir),
        outputDir,
        maxTextureSize: input.maxTextureSize,
        sourceKind: "local-directory",
        ...(dependencies.environment ? { environment: dependencies.environment } : {}),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
      const output = summarize(report, outputDir);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function fabDownloadRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.THREENATIVE_FAB_DOWNLOAD_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "fab-downloads",
    )
  );
}

/**
 * The composed Fab flow: verify the session the user already established, resolve which Unreal
 * artifact the engine selector names, download it into an MCP-owned staging directory outside the
 * game, and hand that directory to the same importer a local pack takes. No step here logs in,
 * claims, purchases, or reads a token; a session that cannot be used stops the flow before any
 * download begins.
 */
export function createFabImportAssetHandler(dependencies: ImportUnrealDependencies = {}) {
  const runImport = dependencies.importDirectory ?? importUnrealDirectory;
  const environment = dependencies.environment ?? process.env;
  const log = dependencies.log ?? (() => {});
  return async (rawInput: z.input<typeof FabImportAssetInputSchema>) => {
    try {
      const input = FabImportAssetInputSchema.parse(rawInput);
      const listingId = parseListingId(input.listingIdOrUrl);
      // The licence gate runs first, on the anonymous public listing, so a refusal costs nothing
      // and no unusable entitlement is ever downloaded.
      const license = await requirePermittedLicense(
        listingId,
        dependencies.readLicenses ?? readPublishedLicenses,
      );
      log(`Licence check: ${license.reason}`);
      const fabCli =
        dependencies.fabCli ?? new FabCli({ environment, log });
      const tool = await fabCli.tool();
      await fabCli.requireAuthenticatedSession();

      const versions = await fabCli.unrealVersions(listingId);
      const selected = FabCli.selectVersion(versions, input.engine);
      const stagingDir = join(fabDownloadRoot(environment), listingId, selected.artifactId);
      await mkdir(stagingDir, { recursive: true });

      const marker = join(stagingDir, ".fabcli-asset.json");
      const cached = await readFile(marker, "utf8").catch(() => undefined);
      const extraWarnings: string[] = [];
      if (cached === undefined || (await readdir(stagingDir)).length <= 1) {
        log(`Downloading ${selected.artifactId} from the Fab library…`);
        try {
          await fabCli.download({
            listingId,
            outputDir: stagingDir,
            engine: input.engine,
            platform: input.platform,
          });
        } catch (error) {
          // A multi-platform artifact needs a platform picked. The source .uasset files are the
          // same whichever build is fetched, so refusing here would stop the flow over a choice
          // that does not change the meshes. The choice is made once, reported, and overridable.
          const ambiguous =
            error instanceof FabCliError &&
            /platform/i.test(error.message) &&
            input.platform === undefined;
          if (!ambiguous) throw error;
          const platform = preferredPlatform(selected.targetPlatforms) ?? "Windows";
          extraWarnings.push(
            `The ${selected.artifactId} artifact publishes several platform builds; downloaded the ${platform} build. Pass platform to choose another.`,
          );
          log(`Retrying the download with the ${platform} build…`);
          await fabCli.download({
            listingId,
            outputDir: stagingDir,
            engine: input.engine,
            platform,
          });
        }
      } else {
        log(`Reusing the already-downloaded ${selected.artifactId} pack.`);
      }

      const outputDir = resolve(input.outputDir);
      const report = await runImport({
        sourceDir: stagingDir,
        outputDir,
        listingId,
        engine: input.engine,
        sourceKind: "fab-listing",
        authenticatedDownload: true,
        fabcliVersion: tool.version,
        maxTextureSize: input.maxTextureSize,
        license: { verdict: license.verdict, slugs: license.slugs, reason: license.reason },
        extraWarnings,
        environment,
        log,
      });
      const output = summarize(report, outputDir);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}
