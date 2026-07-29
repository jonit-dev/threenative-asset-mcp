import { z } from "zod";

import { DirectAssetDownloadError } from "../download/direct-asset-downloader.js";
import { ItchAssetClient, ItchAssetError } from "../itch/client.js";

export const PackIdSchema = z.enum([
  "tallbeard-music-loop-bundle",
  "quaternius-universal-animation-library-1",
  "quaternius-universal-animation-library-2",
  "brackeys-vfx-bundle",
  "kaykit-platformer",
]);

const DownloadEntrySchema = z.object({
  uploadId: z.string().regex(/^\d+$/).max(30),
  name: z.string().max(300),
  sizeLabel: z.string().max(50).optional(),
  suggestedFileName: z.string().max(220),
});

function success<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  const safe =
    error instanceof ItchAssetError || error instanceof DirectAssetDownloadError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : error instanceof z.ZodError
        ? {
            code: "ITCH_INVALID_INPUT",
            message: "The itch.io asset input is invalid.",
            retryable: false,
          }
        : {
            code: "ITCH_INTERNAL",
            message: "The asset MCP could not complete the itch.io request.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export const ItchListDownloadsInputSchema = z.object({
  packId: PackIdSchema,
});
export const ItchListDownloadsOutputSchema = z.object({
  packId: PackIdSchema,
  name: z.string().max(300),
  sourcePageUrl: z.url().max(2_048),
  license: z.literal("CC0"),
  attributionRequired: z.literal(false),
  caution: z.string().max(1_000).optional(),
  downloads: z.array(DownloadEntrySchema).max(100),
});

export function createItchListDownloadsHandler(client: ItchAssetClient) {
  return async (raw: z.input<typeof ItchListDownloadsInputSchema>) => {
    try {
      const input = ItchListDownloadsInputSchema.parse(raw);
      const { pack, downloads } = await client.listDownloads(input.packId);
      return success(
        ItchListDownloadsOutputSchema.parse({
          packId: pack.id,
          name: pack.name,
          sourcePageUrl: pack.pageUrl,
          license: pack.license,
          attributionRequired: pack.attributionRequired,
          ...(pack.caution ? { caution: pack.caution } : {}),
          downloads,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const ItchDownloadInputSchema = z.object({
  packId: PackIdSchema,
  uploadId: z.string().regex(/^\d+$/).max(30),
  acceptLicense: z.literal(true).describe(
    "Required acknowledgement that the caller accepts the CC0 terms and any pack-specific cautions returned by itch_list_downloads.",
  ),
});
export const ItchDownloadOutputSchema = z.object({
  packId: PackIdSchema,
  uploadId: z.string().regex(/^\d+$/).max(30),
  name: z.string().max(300),
  fileName: z.string().max(220),
  path: z.string().max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyExisted: z.boolean(),
  sourcePageUrl: z.url().max(2_048),
  license: z.literal("CC0"),
  attributionRequired: z.literal(false),
});

export function createItchDownloadHandler(client: ItchAssetClient) {
  return async (raw: z.input<typeof ItchDownloadInputSchema>) => {
    try {
      const input = ItchDownloadInputSchema.parse(raw);
      const { pack, upload, result } = await client.download(
        input.packId,
        input.uploadId,
      );
      return success(
        ItchDownloadOutputSchema.parse({
          packId: pack.id,
          uploadId: upload.uploadId,
          name: upload.name,
          fileName: result.fileName,
          path: result.path,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
          alreadyExisted: result.alreadyExisted,
          sourcePageUrl: pack.pageUrl,
          license: pack.license,
          attributionRequired: pack.attributionRequired,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
