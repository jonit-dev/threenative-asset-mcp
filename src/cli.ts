import { relative, resolve } from "node:path";

import {
  createAssetImportUnrealHandler,
  createFabImportAssetHandler,
} from "./tools/import-unreal.js";

/**
 * A thin human/CI adapter over the same two handlers the MCP registers. It exists so a CI job, a
 * shell, or an agent without an MCP host can drive the identical code path — the parity test
 * asserts the CLI and the tool emit byte-identical GLBs from the same input.
 */
const USAGE = `threenative-asset-mcp import <fab-listing-url-or-uid | local-unreal-directory> --out <directory>

  --out <dir>              Where the source GLBs are written, normally <game>/assets/fab/<listing>.
  --engine <UE_x.y>        Unreal artifact selector for a Fab listing with more than one.
  --max-texture-size <n>   Longest edge for embedded textures. Omitted keeps Unreal's resolution.
  --json                   Print the machine-readable summary instead of a human one.

With no arguments the process starts the stdio MCP server instead.
Authentication is never performed here: run \`fabcli auth login\` yourself first.`;

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseFlags(argv: readonly string[]): {
  target: string | undefined;
  out: string | undefined;
  engine: string | undefined;
  maxTextureSize: number | undefined;
  json: boolean;
} {
  let target: string | undefined;
  let out: string | undefined;
  let engine: string | undefined;
  let maxTextureSize: number | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--out" || argument === "-o") {
      out = argv[(index += 1)];
      continue;
    }
    if (argument === "--engine") {
      engine = argv[(index += 1)];
      continue;
    }
    if (argument === "--max-texture-size") {
      const raw = argv[(index += 1)];
      maxTextureSize = raw === undefined ? undefined : Number(raw);
      continue;
    }
    if (argument.startsWith("-")) continue;
    target ??= argument;
  }
  return { target, out, engine, maxTextureSize, json };
}

function isFabTarget(target: string): boolean {
  return /^https?:\/\//i.test(target) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
}

export async function runImportCli(
  argv: readonly string[],
  log: (message: string) => void = () => {},
): Promise<CliResult> {
  const flags = parseFlags(argv);
  if (!flags.target || !flags.out) {
    return { exitCode: 2, stdout: "", stderr: `${USAGE}\n` };
  }

  const handler = isFabTarget(flags.target)
    ? createFabImportAssetHandler({ log })
    : createAssetImportUnrealHandler({ log });

  const result = isFabTarget(flags.target)
    ? await (handler as ReturnType<typeof createFabImportAssetHandler>)({
        listingIdOrUrl: flags.target,
        outputDir: flags.out,
        ...(flags.engine === undefined ? {} : { engine: flags.engine }),
        ...(flags.maxTextureSize === undefined ? {} : { maxTextureSize: flags.maxTextureSize }),
        acceptFabEula: true,
      })
    : await (handler as ReturnType<typeof createAssetImportUnrealHandler>)({
        sourceDir: flags.target,
        outputDir: flags.out,
        ...(flags.maxTextureSize === undefined ? {} : { maxTextureSize: flags.maxTextureSize }),
      });

  if ("isError" in result) {
    return { exitCode: 1, stdout: "", stderr: `${result.content[0]?.text ?? "import failed"}\n` };
  }

  const summary = result.structuredContent;
  if (flags.json) {
    return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: "" };
  }
  const lines = [
    `Imported ${summary.counts.exported} meshes into ${relative(process.cwd(), resolve(summary.outputDir)) || "."}`,
    `Materials: ${summary.materials} (${summary.materialCoverage.textured}/${summary.materialCoverage.sections} sections textured, ${summary.materialCoverage.exact} exact, ${summary.materialCoverage.heuristic} heuristic, ${summary.materialCoverage.unsupported} unsupported)`,
    `Skipped ${summary.counts.skipped}, failed ${summary.counts.failed}. Report: ${summary.reportPath}`,
    ...summary.warnings.map((warning) => `warning: ${warning}`),
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
