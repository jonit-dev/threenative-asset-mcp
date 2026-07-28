export type FabErrorCode =
  | "FAB_INVALID_INPUT"
  | "FAB_NOT_FOUND"
  | "FAB_RATE_LIMITED"
  | "FAB_CHALLENGE"
  | "FAB_BROWSER_ATTENTION_REQUIRED"
  | "FAB_ACCESS_DENIED"
  | "FAB_EULA_REQUIRED"
  | "FAB_FORMAT_UNAVAILABLE"
  | "FAB_LIBRARY_REQUIRED"
  | "FAB_ACQUISITION_REQUIRED"
  | "FAB_DOWNLOAD_TOO_LARGE"
  | "FAB_DOWNLOAD_FAILED"
  | "FAB_UPSTREAM_CHANGED"
  | "FAB_UPSTREAM_UNAVAILABLE"
  | "FAB_TIMEOUT"
  | "FAB_INTERNAL";

export class FabClientError extends Error {
  constructor(
    readonly code: FabErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "FabClientError";
  }
}

export type FabLogLevel = "debug" | "info" | "warn" | "error";

export interface FabLogger {
  enabled(level: FabLogLevel): boolean;
  log(
    level: FabLogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void;
  queryFields(query: string | undefined): Record<string, unknown>;
}

const LOG_PRIORITIES: Record<FabLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function safeLogValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map(safeLogValue);
  return undefined;
}

export function createStderrLogger(options: {
  level: FabLogLevel;
  logQueries: boolean;
  write?: (line: string) => void;
}): FabLogger {
  const write = options.write ?? ((line) => process.stderr.write(line));
  return {
    enabled(level) {
      return LOG_PRIORITIES[level] >= LOG_PRIORITIES[options.level];
    },
    log(level, event, fields = {}) {
      if (LOG_PRIORITIES[level] < LOG_PRIORITIES[options.level]) return;
      const safeFields = Object.fromEntries(
        Object.entries(fields).flatMap(([key, value]) => {
          const safe = safeLogValue(value);
          return safe === undefined ? [] : [[key, safe]];
        }),
      );
      write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          event,
          ...safeFields,
        })}\n`,
      );
    },
    queryFields(query) {
      if (!query) return {};
      return options.logQueries
        ? { query: query.slice(0, 200) }
        : { queryRedacted: true };
    },
  };
}

export const nullFabLogger: FabLogger = {
  enabled: () => false,
  log: () => {},
  queryFields: () => ({}),
};
