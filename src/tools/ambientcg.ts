import { z } from "zod";

import {
  AMBIENTCG_TYPES,
  AmbientCgClient,
  AmbientCgClientError,
} from "../ambientcg/client.js";

const TypeSchema = z.enum(AMBIENTCG_TYPES);
const DownloadSchema = z.object({
  attributes: z.string().max(100),
  extension: z.string().max(20),
  url: z.url().max(2_048),
  sizeBytes: z.number().int().nonnegative(),
});
export const AmbientCgAssetSchema = z.object({
  id: z.string().max(200),
  type: TypeSchema,
  title: z.string().max(500),
  description: z.string().max(12_000).optional(),
  url: z.url().max(2_048),
  tags: z.array(z.string().max(100)).max(100),
  releaseDate: z.string().max(20).optional(),
  technique: z.string().max(100).optional(),
  dimensions: z
    .object({ width: z.number(), height: z.number(), depth: z.number() })
    .optional(),
  downloadCount: z.number().nonnegative().optional(),
  thumbnailUrl: z.url().max(2_048).optional(),
  maps: z.array(z.string().max(100)).max(100),
  license: z.literal("CC0"),
  provider: z.literal("ambientCG"),
});

function assetOutput(asset: Awaited<ReturnType<AmbientCgClient["getAsset"]>>) {
  const { downloads: _downloads, ...metadata } = asset;
  return AmbientCgAssetSchema.parse({
    ...metadata,
    license: "CC0",
    provider: "ambientCG",
  });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof AmbientCgClientError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : {
          code: "AMBIENTCG_INTERNAL",
          message: "The ambientCG provider could not complete the request.",
          retryable: false,
        };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

function success<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export const AmbientCgSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  type: TypeSchema.optional(),
  sort: z
    .enum(["popular", "latest", "downloads", "oldest", "random", "alphabet"])
    .default("popular"),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const AmbientCgSearchOutputSchema = z.object({
  items: z.array(AmbientCgAssetSchema).max(100),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().max(10).optional(),
  provider: z.literal("ambientCG"),
});

export function createAmbientCgSearchHandler(client: AmbientCgClient) {
  return async (raw: z.input<typeof AmbientCgSearchInputSchema>) => {
    try {
      const input = AmbientCgSearchInputSchema.parse(raw);
      const result = await client.search({
        ...(input.query ? { query: input.query } : {}),
        ...(input.type ? { type: input.type } : {}),
        sort: input.sort,
        limit: input.limit,
        offset: Number(input.cursor ?? 0),
      });
      const output = AmbientCgSearchOutputSchema.parse({
        items: result.assets.map(assetOutput),
        total: result.total,
        ...(result.nextOffset !== undefined
          ? { nextCursor: String(result.nextOffset) }
          : {}),
        provider: "ambientCG",
      });
      return success(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AmbientCgGetAssetInputSchema = z.object({
  assetId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(200),
});
export const AmbientCgGetAssetOutputSchema = AmbientCgAssetSchema;

export function createAmbientCgGetAssetHandler(client: AmbientCgClient) {
  return async (raw: z.input<typeof AmbientCgGetAssetInputSchema>) => {
    try {
      const input = AmbientCgGetAssetInputSchema.parse(raw);
      return success(assetOutput(await client.getAsset(input.assetId)));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AmbientCgListFilesInputSchema = z.object({
  assetId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(200),
  attributes: z.string().trim().max(100).optional(),
  extension: z.string().trim().max(20).optional(),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const AmbientCgListFilesOutputSchema = z.object({
  files: z.array(DownloadSchema).max(200),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().max(10).optional(),
  provider: z.literal("ambientCG"),
  license: z.literal("CC0"),
});

export function createAmbientCgListFilesHandler(client: AmbientCgClient) {
  return async (raw: z.input<typeof AmbientCgListFilesInputSchema>) => {
    try {
      const input = AmbientCgListFilesInputSchema.parse(raw);
      const attributes = input.attributes?.toLocaleLowerCase();
      const extension = input.extension?.toLocaleLowerCase();
      const files = (await client.getAsset(input.assetId)).downloads.filter(
        (file) =>
          (!attributes ||
            file.attributes.toLocaleLowerCase().includes(attributes)) &&
          (!extension || file.extension.toLocaleLowerCase() === extension),
      );
      const offset = Number(input.cursor ?? 0);
      const page = files.slice(offset, offset + input.limit);
      const output = AmbientCgListFilesOutputSchema.parse({
        files: page,
        total: files.length,
        ...(offset + page.length < files.length
          ? { nextCursor: String(offset + page.length) }
          : {}),
        provider: "ambientCG",
        license: "CC0",
      });
      return success(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AmbientCgListCategoriesInputSchema = z.object({
  type: TypeSchema.optional(),
});
export const AmbientCgListCategoriesOutputSchema = z.object({
  categories: z.array(
    z.object({
      id: z.string().max(200),
      title: z.string().max(200),
      type: TypeSchema,
      assetCount: z.number().int().nonnegative(),
    }),
  ),
  provider: z.literal("ambientCG"),
});

export function createAmbientCgListCategoriesHandler(client: AmbientCgClient) {
  return async (raw: z.input<typeof AmbientCgListCategoriesInputSchema>) => {
    try {
      const input = AmbientCgListCategoriesInputSchema.parse(raw);
      const categories = (await client.listCategories()).filter(
        (category) => !input.type || category.type === input.type,
      );
      return success(
        AmbientCgListCategoriesOutputSchema.parse({
          categories,
          provider: "ambientCG",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
