import { z } from "zod";

import { BundleAssetClient, BundleAssetError } from "../bundle/client.js";
import { ItchAssetError } from "../itch/client.js";
import { PackIdSchema } from "./itch.js";

const UploadIdSchema = z.string().regex(/^\d+$/).max(30);
const EntryPathSchema = z.string().min(1).max(2_048);

function success<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  const safe =
    error instanceof BundleAssetError || error instanceof ItchAssetError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : error instanceof z.ZodError
        ? {
            code: "BUNDLE_INVALID_INPUT",
            message: "The selective bundle request is invalid.",
            retryable: false,
          }
        : {
            code: "BUNDLE_INTERNAL",
            message: "The asset MCP could not complete the selective bundle request.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

const LicenseOutputSchema = z.object({
  license: z.literal("CC0"),
  attributionRequired: z.literal(false),
});

export const BundleListEntriesInputSchema = z.object({
  packId: PackIdSchema,
  uploadId: UploadIdSchema,
});
export const BundleListEntriesOutputSchema = z
  .object({
    packId: PackIdSchema,
    uploadId: UploadIdSchema,
    name: z.string().max(300),
    sourcePageUrl: z.url().max(2_048),
    rangeBytesTransferred: z.number().int().nonnegative(),
    entries: z
      .array(
        z.object({
          path: EntryPathSchema,
          compressedBytes: z.number().int().nonnegative(),
          uncompressedBytes: z.number().int().nonnegative(),
          directory: z.boolean(),
        }),
      )
      .max(20_000),
  })
  .extend(LicenseOutputSchema.shape);

export function createBundleListEntriesHandler(client: BundleAssetClient) {
  return async (raw: z.input<typeof BundleListEntriesInputSchema>) => {
    try {
      const input = BundleListEntriesInputSchema.parse(raw);
      const result = await client.listEntries(input.packId, input.uploadId);
      return success(
        BundleListEntriesOutputSchema.parse({
          packId: result.pack.id,
          uploadId: result.upload.uploadId,
          name: result.upload.name,
          sourcePageUrl: result.pack.pageUrl,
          license: result.pack.license,
          attributionRequired: result.pack.attributionRequired,
          rangeBytesTransferred: result.rangeBytesTransferred,
          entries: result.entries,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const BundleDownloadEntryInputSchema = z.object({
  packId: PackIdSchema,
  uploadId: UploadIdSchema,
  entryPath: EntryPathSchema,
  acceptLicense: z.literal(true).describe(
    "Required acknowledgement of the pack license returned by itch_list_downloads or asset_list_bundle_entries.",
  ),
});
export const BundleDownloadEntryOutputSchema = z
  .object({
    packId: PackIdSchema,
    uploadId: UploadIdSchema,
    entryPath: EntryPathSchema,
    path: z.string().max(4_096),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    alreadyCached: z.boolean(),
    rangeBytesTransferred: z.number().int().nonnegative(),
  })
  .extend(LicenseOutputSchema.shape);

export function createBundleDownloadEntryHandler(client: BundleAssetClient) {
  return async (raw: z.input<typeof BundleDownloadEntryInputSchema>) => {
    try {
      const input = BundleDownloadEntryInputSchema.parse(raw);
      const result = await client.downloadEntry(input);
      return success(
        BundleDownloadEntryOutputSchema.parse({
          packId: input.packId,
          uploadId: input.uploadId,
          license: "CC0",
          attributionRequired: false,
          ...result,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const BundleListAnimationsInputSchema = z.object({
  packId: PackIdSchema,
  uploadId: UploadIdSchema,
  entryPath: EntryPathSchema.optional().describe(
    "Optional aggregate GLB path. Omit to select the standard non-root-motion GLB automatically.",
  ),
});
export const BundleListAnimationsOutputSchema = z
  .object({
    packId: PackIdSchema,
    uploadId: UploadIdSchema,
    entryPath: EntryPathSchema,
    aggregateEntryBytes: z.number().int().nonnegative(),
    alreadyCached: z.boolean(),
    rangeBytesTransferred: z.number().int().nonnegative(),
    animations: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        name: z.string().max(300),
        channels: z.number().int().nonnegative(),
        samplers: z.number().int().nonnegative(),
      }),
    ),
  })
  .extend(LicenseOutputSchema.shape);

export function createBundleListAnimationsHandler(client: BundleAssetClient) {
  return async (raw: z.input<typeof BundleListAnimationsInputSchema>) => {
    try {
      const input = BundleListAnimationsInputSchema.parse(raw);
      const result = await client.listAnimations({
        packId: input.packId,
        uploadId: input.uploadId,
        ...(input.entryPath ? { entryPath: input.entryPath } : {}),
      });
      return success(
        BundleListAnimationsOutputSchema.parse({
          packId: input.packId,
          uploadId: input.uploadId,
          license: "CC0",
          attributionRequired: false,
          ...result,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const BundleDownloadAnimationInputSchema = z.object({
  packId: PackIdSchema,
  uploadId: UploadIdSchema,
  entryPath: EntryPathSchema.optional(),
  animationName: z.string().min(1).max(300),
  acceptLicense: z.literal(true),
});
export const BundleDownloadAnimationOutputSchema = z
  .object({
    packId: PackIdSchema,
    uploadId: UploadIdSchema,
    entryPath: EntryPathSchema,
    animationName: z.string().max(300),
    path: z.string().max(4_096),
    sizeBytes: z.number().int().nonnegative(),
    aggregateEntryBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    alreadyExisted: z.boolean(),
    aggregateAlreadyCached: z.boolean(),
    rangeBytesTransferred: z.number().int().nonnegative(),
  })
  .extend(LicenseOutputSchema.shape);

export function createBundleDownloadAnimationHandler(client: BundleAssetClient) {
  return async (raw: z.input<typeof BundleDownloadAnimationInputSchema>) => {
    try {
      const input = BundleDownloadAnimationInputSchema.parse(raw);
      const result = await client.downloadAnimation({
        packId: input.packId,
        uploadId: input.uploadId,
        animationName: input.animationName,
        ...(input.entryPath ? { entryPath: input.entryPath } : {}),
      });
      return success(
        BundleDownloadAnimationOutputSchema.parse({
          packId: input.packId,
          uploadId: input.uploadId,
          license: "CC0",
          attributionRequired: false,
          ...result,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
