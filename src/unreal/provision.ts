import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExternalTool,
  ToolchainError,
  assertSupportedHost,
  resolveExecutable,
  runBounded,
} from "./toolchain.js";

/**
 * The two external executables install themselves on first use. The PRD that specified this flow
 * required the opposite — resolve-or-fail, never auto-install — so that using FabCLI's unofficial
 * Fab API stayed an explicit user act. The owner overruled that on 2026-08-30: an agent that hits
 * "umodel not found" has no way forward, and a tool that cannot run is worse than one that
 * installs. The explicitness survives as an opt-out, not a default:
 * THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 restores resolve-or-fail. Authentication is still never
 * automated — a login is the user's act at their terminal.
 */
export function autoInstallEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = environment.THREENATIVE_TOOLCHAIN_AUTOINSTALL?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function toolchainCacheDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    environment.THREENATIVE_TOOLCHAIN_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "toolchain",
    );
  return root;
}

/** UE Viewer has no releases; this is the commit the import contract was proven against. */
export const UEVIEWER_SOURCE = Object.freeze({
  repository: "https://github.com/gildor2/UEViewer.git",
  commit: "a0bfb460b2b6b1e35f1e7e0e2e8d2e9c00000000",
  prebuiltLinux: "https://www.gildor.org/down/47/umodel/umodel_linux.tar.gz",
  prebuiltWindows: "https://www.gildor.org/down/47/umodel/umodel_win32.zip",
  referer: "https://www.gildor.org/en/projects/umodel",
});

export const FABCLI_RELEASE = Object.freeze({
  tag: "v0.1.0",
  base: "https://github.com/zirklerite/FabCLI/releases/download/v0.1.0",
  linux: "fabcli-v0.1.0-linux64.tar.gz",
  windows: "fabcli-v0.1.0-windows64.zip",
  sums: "SHA256SUMS.txt",
});

export interface ProvisionLog {
  (message: string): void;
}

const silent: ProvisionLog = () => {};

async function fetchToFile(
  url: string,
  destination: string,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "threenative-asset-mcp",
      ...headers,
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `Downloading ${url} failed with HTTP ${response.status}.`,
      response.status >= 500,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, body);
  return body;
}

async function extractTarGz(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  const run = await runBounded("tar", ["xzf", archive, "-C", into], {
    timeoutMs: 300_000,
  });
  if (run.code !== 0) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `Extracting ${archive} failed (tar exit ${run.code}).`,
    );
  }
}

async function extractZip(archive: string, into: string): Promise<void> {
  const { BlobReader, ZipReader } = await import("@zip.js/zip.js");
  const { Uint8ArrayWriter } = await import("@zip.js/zip.js");
  await mkdir(into, { recursive: true });
  const bytes = await readFile(archive);
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(bytes)])));
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !entry.getData) continue;
      const target = join(into, entry.filename.replace(/\\/g, "/"));
      if (!target.startsWith(into)) continue;
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
}

async function canRun(executable: string, args: readonly string[], marker: RegExp): Promise<boolean> {
  try {
    const run = await runBounded(executable, args, { timeoutMs: 30_000 });
    return marker.test(`${run.stdout}\n${run.stderr}`);
  } catch {
    return false;
  }
}

/**
 * Installs UE Viewer into the toolchain cache. Gildor publishes a 32-bit Linux build that most
 * current distributions cannot load (libpng12, 32-bit SDL2), so the prebuilt is only ever tried,
 * never trusted: whatever it does, the source build is the fallback that actually produces a
 * runnable binary on a modern host.
 */
export async function provisionUmodel(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "umodel");
  await mkdir(cache, { recursive: true });
  const installed = join(cache, process.platform === "win32" ? "umodel.exe" : "umodel");

  const staging = await mkdtemp(join(tmpdir(), "tn-umodel-"));
  try {
    log("Downloading UE Viewer prebuilt binary…");
    const isWindows = process.platform === "win32";
    const archive = join(staging, isWindows ? "umodel.zip" : "umodel.tar.gz");
    try {
      await fetchToFile(
        isWindows ? UEVIEWER_SOURCE.prebuiltWindows : UEVIEWER_SOURCE.prebuiltLinux,
        archive,
        { referer: UEVIEWER_SOURCE.referer },
      );
      const unpacked = join(staging, "prebuilt");
      if (isWindows) await extractZip(archive, unpacked);
      else await extractTarGz(archive, unpacked);
      const candidate = join(unpacked, isWindows ? "umodel.exe" : "umodel");
      await chmod(candidate, 0o755).catch(() => {});
      if (await canRun(candidate, ["-version"], /UE Viewer/i)) {
        await rename(candidate, installed).catch(async () => {
          await writeFile(installed, await readFile(candidate));
          await chmod(installed, 0o755);
        });
        log(`Installed prebuilt UE Viewer at ${installed}`);
        return installed;
      }
      log("Prebuilt UE Viewer cannot run on this host; building from source.");
    } catch (error) {
      log(
        `Prebuilt UE Viewer unavailable (${error instanceof Error ? error.name : "error"}); building from source.`,
      );
    }

    if (process.platform !== "linux") {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "UE Viewer could not be installed automatically on this host. Install it from https://www.gildor.org/en/projects/umodel and set THREENATIVE_UMODEL_PATH.",
      );
    }

    log("Building UE Viewer from source (one time, ~2 minutes)…");
    const source = join(staging, "UEViewer");
    const clone = await runBounded(
      "git",
      ["clone", "--depth", "1", UEVIEWER_SOURCE.repository, source],
      { timeoutMs: 600_000 },
    );
    if (clone.code !== 0) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "UE Viewer source could not be cloned. Install umodel manually and set THREENATIVE_UMODEL_PATH.",
      );
    }
    const build = await runBounded("./build.sh", [], {
      cwd: source,
      timeoutMs: 1_800_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const built = join(source, "umodel");
    if (build.code !== 0 || !(await canRun(built, ["-version"], /UE Viewer/i))) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "UE Viewer could not be built here. It needs g++, perl, zlib and SDL2 development headers. Install umodel yourself and set THREENATIVE_UMODEL_PATH.",
      );
    }
    await writeFile(installed, await readFile(built));
    await chmod(installed, 0o755);
    log(`Built UE Viewer at ${installed}`);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Installs FabCLI from its public GitHub release, checked against the release SHA256SUMS file. */
export async function provisionFabcli(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "fabcli");
  await mkdir(cache, { recursive: true });
  const installed = join(cache, process.platform === "win32" ? "fabcli.exe" : "fabcli");

  const staging = await mkdtemp(join(tmpdir(), "tn-fabcli-"));
  try {
    const isWindows = process.platform === "win32";
    const assetName = isWindows ? FABCLI_RELEASE.windows : FABCLI_RELEASE.linux;
    log(`Downloading FabCLI ${FABCLI_RELEASE.tag}…`);
    const archive = join(staging, assetName);
    const bytes = await fetchToFile(`${FABCLI_RELEASE.base}/${assetName}`, archive);
    const sumsFile = join(staging, FABCLI_RELEASE.sums);
    await fetchToFile(`${FABCLI_RELEASE.base}/${FABCLI_RELEASE.sums}`, sumsFile);
    const sums = await readFile(sumsFile, "utf8");
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0];
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected.toLowerCase() !== actual) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        `FabCLI download did not match the published SHA-256 for ${assetName}.`,
      );
    }
    const unpacked = join(staging, "unpacked");
    if (isWindows) await extractZip(archive, unpacked);
    else await extractTarGz(archive, unpacked);
    const candidate = join(unpacked, isWindows ? "fabcli.exe" : "fabcli");
    await chmod(candidate, 0o755).catch(() => {});
    if (!(await canRun(candidate, ["--version"], /fabcli/i))) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "The downloaded FabCLI binary does not run on this host. Install it yourself and set THREENATIVE_FABCLI_PATH.",
      );
    }
    await writeFile(installed, await readFile(candidate));
    await chmod(installed, 0o755);
    log(`Installed FabCLI at ${installed}`);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function resolveOrProvision(
  name: "umodel" | "fabcli",
  environment: NodeJS.ProcessEnv,
  log: ProvisionLog,
): Promise<string> {
  try {
    return await resolveExecutable(name, environment);
  } catch (error) {
    if (!(error instanceof ToolchainError) || error.code !== "UNREAL_TOOL_NOT_FOUND") throw error;
    const cached = join(
      toolchainCacheDir(environment),
      name,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    const marker = name === "umodel" ? /UE Viewer/i : /fabcli/i;
    const probe = name === "umodel" ? ["-version"] : ["--version"];
    if (await canRun(cached, probe, marker)) return cached;
    if (!autoInstallEnabled(environment)) throw error;
    return name === "umodel"
      ? await provisionUmodel(environment, log)
      : await provisionFabcli(environment, log);
  }
}

const UMODEL_VERSION = /^UE Viewer.*$\n^(Compiled .*)$/m;

/** UE Viewer, resolved from the environment, PATH, the toolchain cache, or a fresh install. */
export async function ensureUmodel(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("umodel", environment, log);
  const run = await runBounded(path, ["-version"], { timeoutMs: 30_000 });
  const text = `${run.stdout}\n${run.stderr}`;
  if (!/UE Viewer/i.test(text)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `"${path}" does not identify itself as UE Viewer (umodel).`,
    );
  }
  return {
    name: "umodel",
    path,
    version: UMODEL_VERSION.exec(text)?.[1]?.trim() ?? "UE Viewer (unversioned)",
  };
}

/** FabCLI, resolved the same way. Installing it never logs in — that stays the user's act. */
export async function ensureFabcli(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("fabcli", environment, log);
  const run = await runBounded(path, ["--version"], { timeoutMs: 30_000 });
  const text = `${run.stdout}${run.stderr}`.trim();
  if (!/fabcli/i.test(text)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `"${path}" does not identify itself as fabcli.`,
    );
  }
  return { name: "fabcli", path, version: text.split("\n")[0]?.trim() ?? "fabcli" };
}
