import { z } from "zod";

import {
  AudioCatalogClient,
  AudioCatalogError,
} from "../audio/client.js";

const AudioSourceIdSchema = z.enum([
  "sonniss",
  "kenney",
  "tallbeard",
  "scott-buckley",
  "itch-io",
  "mixkit",
  "pixabay",
  "freesound",
  "opengameart",
  "abstraction",
]);
const AudioKindSchema = z.enum(["sfx", "music", "mixed"]);

const AudioSourceSchema = z.object({
  id: AudioSourceIdSchema,
  name: z.string().max(200),
  bestFor: z.string().max(1_000),
  kinds: z.array(AudioKindSchema).max(3),
  browseUrls: z.array(z.url().max(2_048)).max(5),
  licenseSummary: z.string().max(1_000),
  commercialUse: z.string().max(1_000),
  attribution: z.string().max(1_000),
  programmaticDownload: z.enum(["curated-direct", "provider-page"]),
  caution: z.string().max(1_000).optional(),
});

const AudioAssetSchema = z.object({
  id: z.string().max(200),
  sourceId: AudioSourceIdSchema,
  name: z.string().max(500),
  description: z.string().max(2_000),
  kind: AudioKindSchema,
  tags: z.array(z.string().max(100)).max(50),
  license: z.string().max(500),
  commercialUse: z.boolean(),
  attributionRequired: z.boolean(),
  attributionText: z.string().max(1_000).optional(),
  sourcePageUrl: z.url().max(2_048),
  downloadUrl: z.url().max(2_048),
  fileName: z.string().max(255),
  sizeBytes: z.number().int().nonnegative().optional(),
  directDownload: z.literal(true),
  redistributionAllowed: z.literal(false),
});

function successResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  const safe =
    error instanceof AudioCatalogError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : error instanceof z.ZodError
        ? {
            code: "AUDIO_INVALID_INPUT",
            message: "The audio tool input is invalid.",
            retryable: false,
          }
        : {
            code: "AUDIO_INTERNAL",
            message: "The asset MCP could not complete the audio request.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export const AudioListSourcesInputSchema = z.object({});
export const AudioListSourcesOutputSchema = z.object({
  sources: z.array(AudioSourceSchema).max(20),
  total: z.number().int().nonnegative(),
});

export function createAudioListSourcesHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioListSourcesInputSchema>) => {
    try {
      AudioListSourcesInputSchema.parse(rawInput);
      const sources = client.listSources();
      return successResult(
        AudioListSourcesOutputSchema.parse({ sources, total: sources.length }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AudioSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.enum(["all", "sfx", "music", "mixed"]).default("all"),
  source: z.union([z.literal("all"), AudioSourceIdSchema]).default("all"),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const AudioSearchOutputSchema = z.object({
  items: z.array(AudioAssetSchema).max(100),
  nextCursor: z.string().max(10).optional(),
  total: z.number().int().nonnegative(),
});

export function createAudioSearchHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioSearchInputSchema>) => {
    try {
      const input = AudioSearchInputSchema.parse(rawInput);
      const items = client.searchAssets({
        ...(input.query ? { query: input.query } : {}),
        kind: input.kind,
        source: input.source,
      });
      const offset = Number(input.cursor ?? 0);
      const page = items.slice(offset, offset + input.limit);
      return successResult(
        AudioSearchOutputSchema.parse({
          items: page,
          ...(offset + page.length < items.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
          total: items.length,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AudioDownloadInputSchema = z.object({
  assetId: z.string().trim().regex(/^[a-z0-9-]+$/).max(200),
  acceptLicense: z.literal(true).describe(
    "Required acknowledgement that the caller reviewed and accepts the asset license returned by audio_search_assets.",
  ),
});
export const AudioDownloadOutputSchema = z.object({
  assetId: z.string().max(200),
  sourceId: AudioSourceIdSchema,
  fileName: z.string().max(255),
  path: z.string().max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyExisted: z.boolean(),
  license: z.string().max(500),
  attributionRequired: z.boolean(),
  attributionText: z.string().max(1_000).optional(),
  sourcePageUrl: z.url().max(2_048),
});

export function createAudioDownloadHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioDownloadInputSchema>) => {
    try {
      const input = AudioDownloadInputSchema.parse(rawInput);
      return successResult(
        AudioDownloadOutputSchema.parse(await client.downloadAsset(input.assetId)),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
