import { z } from "zod";

import { FabClientError } from "../fab/client.js";

export const FilterKindSchema = z.enum([
  "channels",
  "listing_types",
  "formats",
  "categories",
  "licenses",
]);

export type FilterKind = z.output<typeof FilterKindSchema>;

export const FilterValueSchema = z.object({
  label: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
});

export const FilterGroupsSchema = z.object({
  channels: z.array(FilterValueSchema),
  listing_types: z.array(FilterValueSchema),
  formats: z.array(FilterValueSchema),
  categories: z.array(FilterValueSchema),
  licenses: z.array(FilterValueSchema),
});

export const ListFiltersInputSchema = z.object({
  kinds: z
    .array(FilterKindSchema)
    .max(5)
    .transform((values) => [...new Set(values)])
    .optional(),
  refresh: z.boolean().default(false),
});

export const ListFiltersOutputSchema = z.object({
  filters: FilterGroupsSchema.partial(),
  source: z.enum(["live", "cache", "fallback", "stale-cache"]),
  capturedAt: z.string(),
  contractVersion: z.string(),
  warnings: z.array(z.string()),
});

export type FilterGroups = z.output<typeof FilterGroupsSchema>;
export type ListFiltersInput = z.output<typeof ListFiltersInputSchema>;
export type ListFiltersOutput = z.output<typeof ListFiltersOutputSchema>;

export interface FilterDiscoveryClient {
  listFilters(input: ListFiltersInput): Promise<ListFiltersOutput>;
}

function safeToolError(error: unknown) {
  return error instanceof FabClientError
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
}

export function createListFiltersHandler(client: FilterDiscoveryClient) {
  return async (rawInput: z.input<typeof ListFiltersInputSchema>) => {
    try {
      const input = ListFiltersInputSchema.parse(rawInput);
      const output = ListFiltersOutputSchema.parse(
        await client.listFilters(input),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe = safeToolError(error);
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
