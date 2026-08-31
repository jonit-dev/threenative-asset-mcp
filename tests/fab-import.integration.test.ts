import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import { FabCli, FabCliError, preferredPlatform } from "../src/fab/fabcli.js";
import { classifyLicenses } from "../src/fab/license.js";
import {
  createFabImportAssetHandler,
  requirePermittedLicense,
} from "../src/tools/import-unreal.js";
import { writeFakeFabCli, writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

const LISTING = "75f42402-40bb-4a1b-b557-18e2c9604273";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-fab-"));
  temporaryDirectories.push(directory);
  return directory;
}

const UNREAL_FORMAT = [
  {
    assetFormatType: { code: "unreal-engine" },
    versions: [
      {
        artifactId: "SoulCave418",
        engineVersions: ["UE_4.18", "UE_5.4"],
        targetPlatforms: ["Windows", "Mac"],
      },
    ],
  },
];

interface Harness {
  readonly handler: ReturnType<typeof createFabImportAssetHandler>;
  readonly outputDir: string;
  readonly argvLog: string;
  readonly root: string;
  invocations(): Promise<string[][]>;
}

async function harness(options: {
  readonly authStatus?: unknown;
  readonly formats?: unknown;
  readonly downloadExitCode?: number;
  readonly downloadStderr?: string;
  readonly requirePlatform?: boolean;
  readonly licenses?: readonly string[];
  readonly licenseError?: boolean;
  readonly umodelClasses?: Readonly<Record<string, readonly string[]>>;
} = {}): Promise<Harness> {
  const root = await temporaryDirectory();

  // What FabCLI "downloads": a minimal Unreal pack.
  const packSource = join(root, "pack-source", "Content", "Game");
  await mkdir(packSource, { recursive: true });
  await writeFile(join(packSource, "SM_Rock.uasset"), "package");

  const exported = join(root, "exported");
  await writeMeshFixture(exported, {
    name: "SM_Rock",
    materialName: "M_Rock",
    mat: "Diffuse=T_Rock_D\nNormal=T_Rock_N\n",
    props: "TwoSided = false\nBlendMode = BLEND_Opaque (0)\n",
    textures: ["T_Rock_D", "T_Rock_N"],
  });

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes: options.umodelClasses ?? { SM_Rock: ["StaticMesh"] },
    outputSubdirectory: "Game",
  });

  const argvLog = join(root, "fabcli-argv.log");
  await writeFile(argvLog, "");
  const fabcli = join(root, "fabcli");
  await writeFakeFabCli(fabcli, {
    argvLog,
    authStatus: options.authStatus ?? { authenticated: true, expires_at: "2099-01-01T00:00:00Z" },
    formats: options.formats ?? UNREAL_FORMAT,
    downloadInto: join(root, "pack-source"),
    ...(options.downloadExitCode === undefined
      ? {}
      : { downloadExitCode: options.downloadExitCode }),
    ...(options.downloadStderr === undefined ? {} : { downloadStderr: options.downloadStderr }),
    ...(options.requirePlatform === undefined ? {} : { requirePlatform: options.requirePlatform }),
  });

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    THREENATIVE_UMODEL_PATH: umodel,
    THREENATIVE_FABCLI_PATH: fabcli,
    THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"),
    THREENATIVE_FAB_DOWNLOAD_DIR: join(root, "downloads"),
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
  };

  return {
    root,
    argvLog,
    outputDir: join(root, "game", "assets", "fab", LISTING),
    handler: createFabImportAssetHandler({
      environment,
      readLicenses: async () => {
        if (options.licenseError) throw new Error("network down");
        return options.licenses ?? ["personal", "professional"];
      },
    }),
    async invocations() {
      const text = await readFile(argvLog, "utf8");
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

function errorOf(result: unknown): { code: string; message: string } {
  const content = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  if (!content) throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  return JSON.parse(content) as { code: string; message: string };
}

describe("Fab licence gate", () => {
  it("accepts Fab Standard and CC-BY", () => {
    expect(classifyLicenses(["personal", "professional"]).verdict).toBe("allowed");
    expect(classifyLicenses(["cc-by"]).verdict).toBe("allowed");
    expect(classifyLicenses(["CC_BY_4.0"]).verdict).toBe("allowed");
  });

  it("rejects Unreal-Engine-only and legacy entitlements by name", () => {
    const decision = classifyLicenses(["ue-only-non-commercial"]);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toMatch(/Unreal-Engine-only/);
    expect(classifyLicenses(["legacy-marketplace"]).verdict).toBe("rejected");
  });

  it("treats an unknown or absent licence as a refusal, not a warning", () => {
    expect(classifyLicenses([]).verdict).toBe("unverified");
    expect(classifyLicenses(["mystery-terms"]).verdict).toBe("rejected");
  });

  it("fails closed when the licence cannot be read at all", async () => {
    await expect(
      requirePermittedLicense(LISTING, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("refuses a non-permitted listing before FabCLI is touched at all", async () => {
    const test = await harness({ licenses: ["ue-only-non-commercial"] });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_LICENSE_NOT_PERMITTED");
    expect(await test.invocations()).toEqual([]);
    await expect(stat(test.outputDir)).rejects.toThrow();
  });
});

describe("Fab session handling", () => {
  it("downloads nothing and says what to run when there is no session", async () => {
    const test = await harness({ authStatus: { authenticated: false } });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    const error = errorOf(result);
    expect(error.code).toBe("FABCLI_UNAUTHENTICATED");
    expect(error.message).toMatch(/fabcli auth login/);
    const commands = (await test.invocations()).map((argv) => argv.join(" "));
    expect(commands.some((command) => command.startsWith("download"))).toBe(false);
    await expect(stat(test.outputDir)).rejects.toThrow();
  });

  it("treats an expired session as unusable rather than trying the download", async () => {
    const test = await harness({
      authStatus: { authenticated: true, expires_at: "2000-01-01T00:00:00Z" },
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_SESSION_EXPIRED");
    const commands = (await test.invocations()).map((argv) => argv.join(" "));
    expect(commands.some((command) => command.startsWith("download"))).toBe(false);
  });

  it("does not mistake a missing Fab web session for a missing Epic session", async () => {
    // `fab.session_present: false` blocks claim and ownership, never download.
    const test = await harness({
      authStatus: {
        authenticated: true,
        expires_at: "2099-01-01T00:00:00Z",
        fab: { needs_refresh: true, session_present: false },
      },
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    expect("isError" in result).toBe(false);
  });
});

describe("Fab import safety", () => {
  it("never runs a subcommand outside version, auth status, formats, and download", async () => {
    const test = await harness();
    await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    const verbs = (await test.invocations()).map((argv) =>
      argv[0] === "auth" ? `${argv[0]} ${argv[1]}` : (argv[0] ?? ""),
    );
    expect(new Set(verbs)).toEqual(new Set(["--version", "auth status", "formats", "download"]));
    expect(verbs).not.toContain("claim");
    expect(verbs).not.toContain("claim-batch");
    expect(verbs).not.toContain("auth login");
    expect(verbs).not.toContain("update");
    expect(FabCli.allowedSubcommands).toEqual([
      "--version",
      "auth status",
      "formats",
      "download",
    ]);
  });

  it("refuses an engine selector that is not a UE version instead of passing it through", () => {
    expect(() =>
      FabCli.selectVersion(
        [{ artifactId: "A", engineVersions: ["UE_4.18"], targetPlatforms: [] }],
        "; rm -rf /",
      ),
    ).toThrow(FabCliError);
  });

  it("refuses to guess when a listing publishes several Unreal artifacts", () => {
    expect(() =>
      FabCli.selectVersion(
        [
          { artifactId: "A", engineVersions: ["UE_4.18"], targetPlatforms: [] },
          { artifactId: "B", engineVersions: ["UE_5.4"], targetPlatforms: [] },
        ],
        undefined,
      ),
    ).toThrow(/Pass engine to choose one/);
  });

  it("reports a listing with no Unreal artifact rather than importing nothing", async () => {
    const test = await harness({
      formats: [{ assetFormatType: { code: "gltf" }, versions: [] }],
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_NO_UNREAL_FORMAT");
  });

  it("leaves the game's assets untouched when the download fails", async () => {
    const test = await harness({ downloadExitCode: 4 });
    const existing = join(test.root, "game", "assets", "fab", "existing.glb");
    await mkdir(join(test.root, "game", "assets", "fab"), { recursive: true });
    await writeFile(existing, "already here");

    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_DOWNLOAD_FAILED");
    expect(await readFile(existing, "utf8")).toBe("already here");
    await expect(stat(test.outputDir)).rejects.toThrow();
  });

  it("picks a platform once, reports it, and never retries a caller's explicit choice", async () => {
    const test = await harness({ requirePlatform: true });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.warnings.join(" ")).toMatch(/Windows build/);
    const downloads = (await test.invocations()).filter((argv) => argv[0] === "download");
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toContain("--platform");
    expect(downloads[1]).toContain("Windows");
    expect(preferredPlatform(["Mac", "Windows"])).toBe("Windows");
    expect(preferredPlatform(["Android"])).toBe("Android");
  });

  it("imports an owned listing end to end and records the entitlement without credentials", async () => {
    const test = await harness();
    const result = await test.handler({
      listingIdOrUrl: `https://www.fab.com/listings/${LISTING}`,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.counts.exported).toBe(1);
    expect(result.structuredContent.license).toMatchObject({
      verdict: "allowed",
      slugs: ["personal", "professional"],
    });

    const report = JSON.parse(
      await readFile(join(test.outputDir, "import-report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report.entitlement).toMatchObject({
      provider: "fab",
      authenticatedDownload: true,
      acquisition: "none",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/token|cookie|Bearer|password|secret/i);

    // The entitlement travels inside the GLB, where a game's asset health check reads it.
    const models = report.models as { glb: string }[];
    const glb = models[0];
    if (!glb) throw new Error("expected one model");
    const document = await new NodeIO().readBinary(
      new Uint8Array(await readFile(join(test.outputDir, glb.glb))),
    );
    expect(document.getRoot().getAsset().copyright).toMatch(/personal, professional/);
    expect(document.getRoot().getAsset().copyright).toMatch(/threenative-asset-mcp/);
  });

  it("reuses an already-downloaded pack instead of fetching it again", async () => {
    const test = await harness();
    const input = {
      listingIdOrUrl: LISTING,
      engine: "UE_4.18",
      acceptFabEula: true as const,
    };
    await test.handler({ ...input, outputDir: join(test.outputDir, "first") });
    await test.handler({ ...input, outputDir: join(test.outputDir, "second") });
    const downloads = (await test.invocations()).filter((argv) => argv[0] === "download");
    expect(downloads).toHaveLength(1);
  });
});
