import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

const BooleanEnvironmentValue = z
  .enum(["0", "1", "false", "true"])
  .transform((value) => value === "1" || value === "true");

const EnvironmentSchema = z.object({
  FAB_DIRECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  FAB_BROWSER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(180_000)
    .default(30_000),
  FAB_BROWSER_MANUAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(10_000),
  FAB_BROWSER_HEADLESS: BooleanEnvironmentValue.default(true),
  FAB_BROWSER_PROFILE_DIR: z.string().trim().min(1).optional(),
  FAB_DOWNLOAD_DIR: z.string().trim().min(1).optional(),
  FAB_MAX_DOWNLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(21_474_836_480)
    .default(2_147_483_648),
  FAB_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("warn"),
  FAB_LOG_QUERIES: BooleanEnvironmentValue.default(false),
  FAB_CURL_IMPERSONATE: z.string().trim().min(1).optional(),
  FAB_MIN_REQUEST_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(1_000),
  FAB_DOWNLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(600_000),
});

export interface FabConfig {
  directTimeoutMs: number;
  browserTimeoutMs: number;
  browserManualTimeoutMs: number;
  browserHeadless: boolean;
  browserProfileDir: string;
  downloadDir: string;
  maxDownloadBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logQueries: boolean;
  /**
   * Explicit curl-impersonate wrapper override; "0"/"off"/"false" disables
   * impersonation. Resolution against PATH happens in the client.
   */
  curlImpersonate?: string;
  minRequestIntervalMs: number;
  downloadTimeoutMs: number;
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function canonicalPath(input: string): string {
  let candidate = resolve(input);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSegments);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(input);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function normalBrowserProfileRoots(
  environment: NodeJS.ProcessEnv,
): string[] {
  const userHome = homedir();
  if (process.platform === "darwin") {
    return [
      join(userHome, "Library", "Application Support", "Google", "Chrome"),
      join(userHome, "Library", "Application Support", "Google", "Chrome Beta"),
      join(userHome, "Library", "Application Support", "Google", "Chrome Canary"),
      join(userHome, "Library", "Application Support", "Chromium"),
      join(userHome, "Library", "Application Support", "Microsoft Edge"),
    ];
  }
  if (process.platform === "win32") {
    const localData = environment.LOCALAPPDATA?.trim();
    return localData
      ? [
          join(localData, "Google", "Chrome", "User Data"),
          join(localData, "Google", "Chrome Beta", "User Data"),
          join(localData, "Google", "Chrome SxS", "User Data"),
          join(localData, "Chromium", "User Data"),
          join(localData, "Microsoft", "Edge", "User Data"),
        ]
      : [];
  }
  return [
    join(userHome, ".config", "google-chrome"),
    join(userHome, ".config", "google-chrome-beta"),
    join(userHome, ".config", "google-chrome-unstable"),
    join(userHome, ".config", "chromium"),
    join(userHome, ".config", "microsoft-edge"),
  ];
}

export function loadFabConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FabConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const stateRoot =
    environment.XDG_STATE_HOME?.trim() ||
    join(homedir(), ".local", "state");

  const browserProfileDir = canonicalPath(
    parsed.FAB_BROWSER_PROFILE_DIR ??
      join(stateRoot, "fab-mcp", "browser-profile"),
  );
  if (
    normalBrowserProfileRoots(environment).some((root) =>
      isInside(browserProfileDir, canonicalPath(root)),
    )
  ) {
    throw new Error(
      "FAB_BROWSER_PROFILE_DIR must be an MCP-owned directory, not a normal browser profile.",
    );
  }
  const downloadDir = canonicalPath(
    parsed.FAB_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "fab-mcp"),
  );
  if (
    downloadDir === canonicalPath(homedir()) ||
    dirname(downloadDir) === downloadDir
  ) {
    throw new Error(
      "FAB_DOWNLOAD_DIR must be a dedicated asset directory, not a filesystem or home root.",
    );
  }

  return {
    directTimeoutMs: parsed.FAB_DIRECT_TIMEOUT_MS,
    browserTimeoutMs: parsed.FAB_BROWSER_TIMEOUT_MS,
    browserManualTimeoutMs: parsed.FAB_BROWSER_MANUAL_TIMEOUT_MS,
    browserHeadless: parsed.FAB_BROWSER_HEADLESS,
    browserProfileDir,
    downloadDir,
    maxDownloadBytes: parsed.FAB_MAX_DOWNLOAD_BYTES,
    logLevel: parsed.FAB_LOG_LEVEL,
    logQueries: parsed.FAB_LOG_QUERIES,
    ...(parsed.FAB_CURL_IMPERSONATE
      ? { curlImpersonate: parsed.FAB_CURL_IMPERSONATE }
      : {}),
    minRequestIntervalMs: parsed.FAB_MIN_REQUEST_INTERVAL_MS,
    downloadTimeoutMs: parsed.FAB_DOWNLOAD_TIMEOUT_MS,
  };
}
