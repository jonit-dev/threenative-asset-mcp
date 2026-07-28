import { z } from "zod";

import { FabClientError } from "../fab/client.js";

export const ListLimitedTimeFreeInputSchema = z.object({
  limit: z.number().int().min(1).max(24).default(24),
});

export const LimitedTimeFreeItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.url(),
  thumbnailUrl: z.url().optional(),
  promotionEndsAt: z.string().optional(),
});

export const ListLimitedTimeFreeOutputSchema = z.object({
  items: z.array(LimitedTimeFreeItemSchema),
  source: z.enum(["configured-curated", "live-curated", "browser-curated"]),
  warnings: z.array(z.string()),
});

export type ListLimitedTimeFreeInput = z.output<
  typeof ListLimitedTimeFreeInputSchema
>;
export type ListLimitedTimeFreeOutput = z.output<
  typeof ListLimitedTimeFreeOutputSchema
>;

export interface LimitedTimeFreeClient {
  listLimitedTimeFree(
    input: ListLimitedTimeFreeInput,
  ): Promise<ListLimitedTimeFreeOutput>;
}

export function createListLimitedTimeFreeHandler(
  client: LimitedTimeFreeClient,
) {
  return async (rawInput: z.input<typeof ListLimitedTimeFreeInputSchema>) => {
    try {
      const input = ListLimitedTimeFreeInputSchema.parse(rawInput);
      const output = ListLimitedTimeFreeOutputSchema.parse(
        await client.listLimitedTimeFree(input),
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
