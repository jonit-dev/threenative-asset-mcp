import { z } from "zod";

import { FabClient, FabClientError } from "../fab/client.js";

const dedupedValues = z
  .array(z.string().trim().min(1).max(100))
  .max(20)
  .transform((values) => [...new Set(values)]);

export const SearchToolInputSchema = z.object({
    query: z.string().trim().max(200).optional(),
    priceMode: z.enum(["free", "any", "range"]).default("free"),
    minPrice: z.number().finite().nonnegative().optional(),
    maxPrice: z.number().finite().nonnegative().optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .default("USD"),
    channels: dedupedValues.optional(),
    listingTypes: dedupedValues.optional(),
    categories: dedupedValues.optional(),
    tags: dedupedValues.optional(),
    licenses: dedupedValues.optional(),
    publisher: z.string().trim().min(1).max(200).optional(),
    minimumRating: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]).optional(),
    publishedSince: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    aiGenerated: z.boolean().optional(),
    allowsAiUse: z.boolean().optional(),
    sort: z
      .enum([
        "relevance",
        "rating",
        "newest",
        "oldest",
        "price_asc",
        "price_desc",
        "discount_desc",
        "recently_updated",
      ])
      .default("relevance"),
    limit: z.number().int().min(1).max(24).default(24),
    cursor: z.string().min(1).max(2048).optional(),
  });

export const SearchInputSchema = SearchToolInputSchema.superRefine(
  (input, context) => {
    const hasRangeValue =
      input.minPrice !== undefined || input.maxPrice !== undefined;
    if (input.priceMode !== "range" && hasRangeValue) {
      context.addIssue({
        code: "custom",
        message: "minPrice and maxPrice require priceMode=range",
        path: ["priceMode"],
      });
    }
    if (input.priceMode === "range" && !hasRangeValue) {
      context.addIssue({
        code: "custom",
        message: "priceMode=range requires minPrice or maxPrice",
        path: ["priceMode"],
      });
    }
    if (
      input.minPrice !== undefined &&
      input.maxPrice !== undefined &&
      input.minPrice > input.maxPrice
    ) {
      context.addIssue({
        code: "custom",
        message: "minPrice must not exceed maxPrice",
        path: ["minPrice"],
      });
    }
  },
);

const PriceSchema = z.object({
  amount: z.number(),
  currency: z.string().max(10),
  effectiveAmount: z.number().optional(),
});

const SearchItemSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(500),
  url: z.url().max(500),
  publisher: z
    .object({
      id: z.string().max(200).optional(),
      name: z.string().max(200),
      url: z.url().max(1_024).optional(),
    })
    .optional(),
  listingType: z.string().max(200).optional(),
  category: z
    .object({
      name: z.string().max(200).optional(),
      slug: z.string().max(200).optional(),
    })
    .optional(),
  formats: z.array(z.string().max(100)).max(20).optional(),
  tags: z
    .array(
      z.object({
        name: z.string().max(100),
        slug: z.string().max(100).optional(),
      }),
    )
    .max(20),
  thumbnailUrl: z.url().max(1_024).optional(),
  rating: z
    .object({ average: z.number(), count: z.number() })
    .optional(),
  startingPrice: PriceSchema.optional(),
  isFree: z.boolean(),
  isDiscounted: z.boolean().optional(),
  isAiGenerated: z.boolean().optional(),
  allowsAiUse: z.boolean().optional(),
  isMature: z.boolean().optional(),
  publishedAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});

export const SearchOutputSchema = z.object({
  items: z.array(SearchItemSchema).max(24),
  nextCursor: z.string().max(2_048).optional(),
  appliedFilters: z.record(z.string(), z.unknown()),
  transport: z.enum(["direct", "browser"]),
  warnings: z.array(z.string().max(500)).max(20),
});

export type SearchInput = z.output<typeof SearchInputSchema>;
export type SearchOutput = z.output<typeof SearchOutputSchema>;

export function createSearchAssetsHandler(client: FabClient) {
  return async (rawInput: z.input<typeof SearchInputSchema>) => {
    const parsed = SearchInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const error = {
        code: "FAB_INVALID_INPUT",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
        retryable: false,
      };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(error) }],
      };
    }

    try {
      const output = SearchOutputSchema.parse(await client.search(parsed.data));
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
              ...(error.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: error.retryAfterSeconds }),
            }
          : {
              code: "FAB_INTERNAL",
              message: "The Fab provider could not complete the request.",
              retryable: false,
            };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
