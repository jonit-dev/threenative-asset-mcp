import { z } from "zod";

import {
  FabClientError,
  type FabDownloadFormat,
  type FabDownloadResult,
} from "../fab/direct-transport.js";
import { parseListingId } from "./get-asset.js";

export const DownloadFreeAssetInputSchema = z.object({
  listingIdOrUrl: z.string().trim().min(1).max(500),
  format: z.enum([
    "blender",
    "fbx",
    "glb",
    "gltf",
    "maya",
    "obj",
    "unity",
  ]),
  acceptFabEula: z.literal(true).describe(
    "Required acknowledgement that the user accepts the Fab EULA linked by the listing.",
  ),
});

export const DownloadFreeAssetOutputSchema = z.object({
  listingId: z.string().max(100),
  format: DownloadFreeAssetInputSchema.shape.format,
  fileName: z.string().max(180),
  path: z.string().max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyExisted: z.boolean(),
  authentication: z.literal("not-required"),
});

export type DownloadFreeAssetInput = z.output<
  typeof DownloadFreeAssetInputSchema
>;
export type DownloadFreeAssetOutput = z.output<
  typeof DownloadFreeAssetOutputSchema
>;

export interface FreeAssetDownloadClient {
  downloadFreeAsset(request: {
    listingId: string;
    format: FabDownloadFormat;
  }): Promise<FabDownloadResult>;
}

export function createDownloadFreeAssetHandler(
  client: FreeAssetDownloadClient,
) {
  return async (
    rawInput: z.input<typeof DownloadFreeAssetInputSchema>,
  ) => {
    try {
      const input = DownloadFreeAssetInputSchema.parse(rawInput);
      const listingId = parseListingId(input.listingIdOrUrl);
      const output = DownloadFreeAssetOutputSchema.parse(
        await client.downloadFreeAsset({
          listingId,
          format: input.format,
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof FabClientError
          ? {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            }
          : {
              code: "FAB_INTERNAL",
              message: "The Fab provider could not complete the download.",
              retryable: false,
            };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
