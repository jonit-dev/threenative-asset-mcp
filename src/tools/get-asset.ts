import { z } from "zod";

import { FabClientError } from "../fab/client.js";
import { normalizeListing } from "../fab/normalize.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GetAssetInputSchema = z.object({
  listingIdOrUrl: z.string().trim().min(1).max(500),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default("USD"),
});

const MoneySchema = z.object({
  amount: z.number(),
  currency: z.string().max(10),
});

const NamedValueSchema = z.object({
  name: z.string().max(200),
  slug: z.string().max(200).optional(),
});

export const AssetOutputSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(500),
  url: z.url(),
  thumbnailUrl: z.url().max(2_048).optional(),
  publisher: z
    .object({
      id: z.string().max(200).optional(),
      name: z.string().max(200),
    })
    .optional(),
  description: z.string().max(12_000).optional(),
  descriptionTruncated: z.boolean(),
  category: NamedValueSchema.optional(),
  breadcrumb: z.array(NamedValueSchema).max(20),
  tags: z.array(NamedValueSchema).max(100),
  media: z.array(
    z.object({
      type: z.string().max(50),
      url: z.url().max(2_048),
      thumbnailUrl: z.url().max(2_048).optional(),
    }),
  ).max(50),
  formats: z.array(z.string().max(200)).max(50),
  files: z
    .array(
      z.object({
        name: z.string().max(300).optional(),
        url: z.url().max(2_048).optional(),
        sizeBytes: z.number().nonnegative().optional(),
        format: z.string().max(100).optional(),
      }),
    )
    .max(100),
  compatibility: z
    .array(
      z.object({
        name: z.string().max(200),
        version: z.string().max(100).optional(),
        platform: z.string().max(100).optional(),
      }),
    )
    .max(50),
  licenses: z.array(
    z.object({
      slug: z.string().max(200),
      name: z.string().max(200),
      offerId: z.string().max(200).optional(),
      basePrice: MoneySchema.optional(),
      effectivePrice: MoneySchema.optional(),
      isFree: z.boolean(),
    }),
  ),
  freeLicenseSlugs: z.array(z.string().max(200)).max(30),
  publishedAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
  hasChangelog: z.boolean().optional(),
  isMature: z.boolean().optional(),
  isAiGenerated: z.boolean().optional(),
  allowsAiUse: z.boolean().optional(),
  transport: z.enum(["direct", "browser"]),
  warnings: z.array(z.string().max(500)).max(20),
  rawContractVersion: z.string().max(100),
});

export type AssetOutput = z.output<typeof AssetOutputSchema>;

export interface AssetLookupClient {
  getListing(
    id: string,
    currency: string,
  ): Promise<{ payload: unknown; transport: "direct" | "browser" }>;
}

export function parseListingId(value: string): string {
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FabClientError(
      "FAB_INVALID_INPUT",
      "Use a Fab listing UUID or canonical Fab listing URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.fab.com" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new FabClientError(
      "FAB_INVALID_INPUT",
      "Only canonical https://www.fab.com/listings/{uuid} URLs are accepted.",
    );
  }
  const match = /^\/listings\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1] || !UUID_PATTERN.test(match[1])) {
    throw new FabClientError(
      "FAB_INVALID_INPUT",
      "The Fab listing URL does not contain a valid UUID.",
    );
  }
  return match[1].toLowerCase();
}

export function createGetAssetHandler(client: AssetLookupClient) {
  return async (rawInput: z.input<typeof GetAssetInputSchema>) => {
    try {
      const input = GetAssetInputSchema.parse(rawInput);
      const id = parseListingId(input.listingIdOrUrl);
      const result = await client.getListing(id, input.currency);
      const output = AssetOutputSchema.parse(
        normalizeListing(result.payload, input.currency, result.transport),
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
              message: "The Fab MCP could not complete the request.",
              retryable: false,
            };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
