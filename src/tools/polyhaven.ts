import { z } from "zod";

import {
  PolyHavenClient,
  PolyHavenClientError,
  type PolyHavenAsset,
} from "../polyhaven/client.js";

const AssetTypeSchema = z.enum(["hdris", "textures", "models"]);
const AttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

export const PolyHavenAssetSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  description: z.string().max(12_000).optional(),
  type: AssetTypeSchema,
  url: z.url().max(500),
  category: z.string().max(500).optional(),
  categoryId: z.string().max(100).optional(),
  tags: z.array(z.string().max(100)).max(100),
  authors: z.record(z.string(), z.string().max(500)),
  attributes: z.record(z.string(), AttributeValueSchema),
  thumbnailUrl: z.url().max(2_048).optional(),
  maxResolution: z.array(z.number()).max(3).optional(),
  dimensions: z.array(z.number()).max(3).optional(),
  polycount: z.number().nonnegative().optional(),
  downloadCount: z.number().nonnegative().optional(),
  publishedAt: z.string().max(100).optional(),
  filesHash: z.string().max(100).optional(),
  donated: z.boolean().optional(),
  lods: z.boolean().optional(),
  license: z.literal("CC0"),
  provider: z.literal("Poly Haven"),
});

function outputAsset(asset: PolyHavenAsset) {
  return PolyHavenAssetSchema.parse({
    ...asset,
    url: `https://polyhaven.com/a/${encodeURIComponent(asset.id)}`,
    license: "CC0",
    provider: "Poly Haven",
  });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof PolyHavenClientError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : {
          code: "POLYHAVEN_INTERNAL",
          message: "The asset MCP could not complete the Poly Haven request.",
          retryable: false,
        };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

function successResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export const PolyHavenSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  type: z.enum(["all", "hdris", "textures", "models"]).default("all"),
  categories: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .default([]),
  sort: z.enum(["relevance", "popular", "newest", "name"]).default("relevance"),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});

export const PolyHavenSearchOutputSchema = z.object({
  items: z.array(PolyHavenAssetSchema).max(100),
  nextCursor: z.string().max(10).optional(),
  total: z.number().int().nonnegative(),
  provider: z.literal("Poly Haven"),
  attribution: z.literal("Powered by Poly Haven"),
});

export function createPolyHavenSearchHandler(client: PolyHavenClient) {
  return async (rawInput: z.input<typeof PolyHavenSearchInputSchema>) => {
    try {
      const input = PolyHavenSearchInputSchema.parse(rawInput);
      const query = input.query?.toLocaleLowerCase();
      const categories = input.categories.map((value) =>
        value.toLocaleLowerCase(),
      );
      let items = (await client.listAssets(input.type)).filter((asset) => {
        const haystack = [
          asset.id,
          asset.name,
          asset.description ?? "",
          asset.category ?? "",
          ...asset.tags,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return (
          (!query || haystack.includes(query)) &&
          categories.every((category) => haystack.includes(category))
        );
      });
      if (input.sort === "popular") {
        items.sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0));
      } else if (input.sort === "newest") {
        items.sort((a, b) =>
          (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
        );
      } else if (input.sort === "name") {
        items.sort((a, b) => a.name.localeCompare(b.name));
      } else if (query) {
        items.sort((a, b) => {
          const rank = (asset: PolyHavenAsset) =>
            asset.id.toLocaleLowerCase() === query ||
            asset.name.toLocaleLowerCase() === query
              ? 0
              : asset.name.toLocaleLowerCase().includes(query)
                ? 1
                : 2;
          return rank(a) - rank(b) || (b.downloadCount ?? 0) - (a.downloadCount ?? 0);
        });
      }
      const offset = Number(input.cursor ?? 0);
      const page = items.slice(offset, offset + input.limit).map(outputAsset);
      const output = PolyHavenSearchOutputSchema.parse({
        items: page,
        ...(offset + page.length < items.length
          ? { nextCursor: String(offset + page.length) }
          : {}),
        total: items.length,
        provider: "Poly Haven",
        attribution: "Powered by Poly Haven",
      });
      return successResult(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const PolyHavenGetAssetInputSchema = z.object({
  assetId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(200),
});
export const PolyHavenGetAssetOutputSchema = PolyHavenAssetSchema;

export function createPolyHavenGetAssetHandler(client: PolyHavenClient) {
  return async (rawInput: z.input<typeof PolyHavenGetAssetInputSchema>) => {
    try {
      const input = PolyHavenGetAssetInputSchema.parse(rawInput);
      return successResult(outputAsset(await client.getAsset(input.assetId)));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const PolyHavenListCategoriesInputSchema = z.object({
  type: AssetTypeSchema,
});
export const PolyHavenListCategoriesOutputSchema = z.object({
  categories: z.array(
    z.object({
      name: z.string().max(200),
      assetCount: z.number().int().nonnegative(),
    }),
  ),
  provider: z.literal("Poly Haven"),
});

export function createPolyHavenListCategoriesHandler(client: PolyHavenClient) {
  return async (
    rawInput: z.input<typeof PolyHavenListCategoriesInputSchema>,
  ) => {
    try {
      const input = PolyHavenListCategoriesInputSchema.parse(rawInput);
      const output = PolyHavenListCategoriesOutputSchema.parse({
        categories: await client.listCategories(input.type),
        provider: "Poly Haven",
      });
      return successResult(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const PolyHavenListFilesInputSchema = z.object({
  assetId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(200),
  resolution: z.string().trim().regex(/^\d+k$/i).max(10).optional(),
  format: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(30).optional(),
  includeDependencies: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
const PolyHavenFileSchema = z.object({
  path: z.string().max(1_000),
  url: z.url().max(2_048),
  sizeBytes: z.number().int().nonnegative(),
  md5: z.string().regex(/^[0-9a-f]{32}$/i),
  dependencyOf: z.string().max(1_000).optional(),
  relativePath: z.string().max(1_000).optional(),
});
export const PolyHavenListFilesOutputSchema = z.object({
  files: z.array(PolyHavenFileSchema).max(200),
  nextCursor: z.string().max(10).optional(),
  total: z.number().int().nonnegative(),
  provider: z.literal("Poly Haven"),
});

export function createPolyHavenListFilesHandler(client: PolyHavenClient) {
  return async (rawInput: z.input<typeof PolyHavenListFilesInputSchema>) => {
    try {
      const input = PolyHavenListFilesInputSchema.parse(rawInput);
      const resolution = input.resolution?.toLocaleLowerCase();
      const format = input.format?.toLocaleLowerCase();
      const files = (await client.listFiles(input.assetId)).filter((file) => {
        const segments = file.path.toLocaleLowerCase().split("/");
        return (
          (!resolution || segments.includes(resolution)) &&
          (!format ||
            segments.includes(format) ||
            new URL(file.url).pathname.toLocaleLowerCase().endsWith(`.${format}`)) &&
          (input.includeDependencies || !file.dependencyOf)
        );
      });
      const offset = Number(input.cursor ?? 0);
      const page = files.slice(offset, offset + input.limit);
      const output = PolyHavenListFilesOutputSchema.parse({
        files: page,
        ...(offset + page.length < files.length
          ? { nextCursor: String(offset + page.length) }
          : {}),
        total: files.length,
        provider: "Poly Haven",
      });
      return successResult(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}
