import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { accessSync, constants as fsConstants } from "node:fs";

import { FabClientError, nullFabLogger, type FabLogger } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Ordered wrapper preference: newest Chrome first, then Firefox, then the
 * generic curl-impersonate binaries. The first match on PATH wins.
 */
const KNOWN_WRAPPERS = [
  "curl_chrome146",
  "curl_chrome145",
  "curl_chrome142",
  "curl_chrome136",
  "curl_chrome133a",
  "curl_chrome131",
  "curl_chrome124",
  "curl_chrome123",
  "curl_chrome120",
  "curl_chrome119",
  "curl_chrome116",
  "curl_chrome110",
  "curl_chrome107",
  "curl_chrome104",
  "curl_chrome101",
  "curl_chrome100",
  "curl_chrome99",
  "curl_firefox147",
  "curl_firefox144",
  "curl_firefox135",
  "curl_firefox133",
  "curl-impersonate-chrome",
  "curl-impersonate",
];

export interface ImpersonateFetchOptions {
  command: string;
  cookieJarPath: string;
  timeoutMs: number;
  maxChallengeRetries?: number;
  challengeWaitsMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  logger?: FabLogger;
  /** Test seam: replace the subprocess runner. */
  runCommand?: typeof execFileAsync;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the curl-impersonate command to use, or undefined when the host
 * has none. `FAB_CURL_IMPERSONATE` accepts an explicit wrapper name/path, or
 * "0"/"off"/"false" to disable impersonation entirely.
 */
export function resolveImpersonateCommand(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = environment.FAB_CURL_IMPERSONATE?.trim();
  if (explicit) {
    if (/^(0|off|false)$/i.test(explicit)) return undefined;
    return explicit;
  }
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    if (!directory) continue;
    for (const wrapper of KNOWN_WRAPPERS) {
      const candidate = join(directory, wrapper);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function parseHeaderBlock(raw: string): {
  status: number;
  headers: Headers;
} {
  // A dump can hold multiple blocks (redirects, HTTP/1.1 100); the last
  // block belongs to the final response.
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const last = blocks.at(-1) ?? "";
  const lines = last.split(/\r?\n/);
  const statusLine = lines.shift() ?? "";
  const statusMatch = /(\d{3})/.exec(statusLine);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name) headers.append(name, value);
  }
  return { status, headers };
}

export function isChallengeResponse(
  status: number,
  headers: Headers,
): boolean {
  return (
    status === 403 &&
    (headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
      (headers.get("content-type") ?? "").toLowerCase().includes("text/html"))
  );
}

/**
 * A `fetch`-compatible function backed by a curl-impersonate subprocess so
 * Fab sees a real browser TLS/HTTP fingerprint. Cloudflare challenge 403s
 * are retried with backoff inside the wrapper; the final response (possibly
 * still a challenge) is returned for the caller to classify.
 */
export function createImpersonateFetch(
  options: ImpersonateFetchOptions,
): typeof fetch {
  const maxChallengeRetries = options.maxChallengeRetries ?? 3;
  const challengeWaitsMs = options.challengeWaitsMs ?? [5_000, 15_000, 40_000];
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const random = options.random ?? Math.random;
  const logger = options.logger ?? nullFabLogger;
  const runCommand = options.runCommand ?? execFileAsync;
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (init?.method && init.method !== "GET") {
      throw new FabClientError(
        "FAB_INTERNAL",
        "The impersonated transport only performs anonymous GET reads.",
      );
    }

    for (let challengeAttempt = 0; ; challengeAttempt += 1) {
      const scratch = await mkdtemp(
        join(tmpdir(), "threenative-asset-mcp-fab-curl-"),
      );
      const headersPath = join(scratch, "headers.txt");
      const bodyPath = join(scratch, "body.bin");
      try {
        try {
          await runCommand(options.command, [
            "-sS",
            "-b",
            options.cookieJarPath,
            "-c",
            options.cookieJarPath,
            "-D",
            headersPath,
            "-o",
            bodyPath,
            "--max-time",
            String(timeoutSeconds),
            url,
          ]);
        } catch (error) {
          const failure = error as {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          // curl exit 28 is a timeout; other non-zero exits still may have
          // written partial header data we must not trust.
          if (failure.code === 28) {
            throw new FabClientError(
              "FAB_TIMEOUT",
              "Fab did not respond before the request timeout.",
              true,
            );
          }
          throw new FabClientError(
            "FAB_UPSTREAM_UNAVAILABLE",
            "Fab could not be reached.",
            true,
          );
        }

        const { status, headers } = parseHeaderBlock(
          await readFile(headersPath, "utf8").catch(() => ""),
        );
        if (status === 0) {
          throw new FabClientError(
            "FAB_UPSTREAM_UNAVAILABLE",
            "Fab could not be reached.",
            true,
          );
        }
        if (isChallengeResponse(status, headers)) {
          logger.log("debug", "fab_upstream_response", {
            transport: "direct",
            status,
            challenge: true,
            challengeAttempt,
          });
          if (challengeAttempt < maxChallengeRetries) {
            const base =
              challengeWaitsMs[
                Math.min(challengeAttempt, challengeWaitsMs.length - 1)
              ] ?? 5_000;
            const jitter = Math.floor(random() * 2_000);
            await sleep(base + jitter);
            continue;
          }
        }
        const body = await readFile(bodyPath);
        return new Response(new Uint8Array(body), { status, headers });
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }) as typeof fetch;

  return fetchImpl;
}

export interface ImpersonateDownloadOptions {
  command: string;
  cookieJarPath: string;
  timeoutMs: number;
  url: string;
  destinationPath: string;
  maxBytes: number;
  runCommand?: typeof execFileAsync;
}

/**
 * Streams a validated download URL to disk via curl-impersonate. Aborts when
 * the server announces a body larger than maxBytes (curl exit 63) and
 * re-checks the written size afterwards.
 */
export async function impersonateDownloadToFile(
  options: ImpersonateDownloadOptions,
): Promise<{ sizeBytes: number }> {
  const runCommand = options.runCommand ?? execFileAsync;
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1_000));
  try {
    await runCommand(options.command, [
      "-sS",
      "-L",
      "-b",
      options.cookieJarPath,
      "-c",
      options.cookieJarPath,
      "-o",
      options.destinationPath,
      "--max-time",
      String(timeoutSeconds),
      "--max-filesize",
      String(options.maxBytes),
      options.url,
    ]);
  } catch (error) {
    const failure = error as { code?: number };
    if (failure.code === 63) {
      throw new FabClientError(
        "FAB_DOWNLOAD_TOO_LARGE",
        "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
      );
    }
    if (failure.code === 28) {
      throw new FabClientError(
        "FAB_TIMEOUT",
        "Fab did not finish the download before the timeout.",
        true,
      );
    }
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "Fab could not complete the requested file download.",
      true,
    );
  }
  const metadata = await stat(options.destinationPath);
  if (!metadata.isFile()) {
    throw new FabClientError(
      "FAB_DOWNLOAD_FAILED",
      "The downloaded file could not be saved safely.",
      true,
    );
  }
  if (metadata.size > options.maxBytes) {
    throw new FabClientError(
      "FAB_DOWNLOAD_TOO_LARGE",
      "The downloaded file exceeds FAB_MAX_DOWNLOAD_BYTES.",
    );
  }
  return { sizeBytes: metadata.size };
}
