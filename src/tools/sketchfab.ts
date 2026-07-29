import { z } from "zod";

import {
  SketchfabClient,
  SketchfabClientError,
  type SketchfabModel,
} from "../sketchfab/client.js";

const ArchiveSchema = z.object({
  format: z.string().max(30),
  sizeBytes: z.number().int().nonnegative().optional(),
  textureCount: z.number().int().nonnegative().optional(),
  textureMaxResolution: z.number().int().nonnegative().optional(),
  faceCount: z.number().int().nonnegative().optional(),
  vertexCount: z.number().int().nonnegative().optional(),
});
export const SketchfabModelSchema = z.object({
  id: z.string().max(100),
  name: z.string().max(500),
  description: z.string().max(12_000).optional(),
  viewerUrl: z.url().max(2_048),
  embedUrl: z.url().max(2_048).optional(),
  thumbnailUrl: z.url().max(2_048).optional(),
  author: z
    .object({
      id: z.string().max(100).optional(),
      username: z.string().max(200),
      displayName: z.string().max(200).optional(),
      profileUrl: z.url().max(2_048).optional(),
    })
    .optional(),
  tags: z.array(z.string().max(100)).max(100),
  categories: z.array(z.string().max(200)).max(50),
  license: z
    .object({
      label: z.string().max(200),
      slug: z.string().max(100).optional(),
      url: z.url().max(2_048).optional(),
      requirements: z.string().max(2_000).optional(),
    })
    .optional(),
  downloadable: z.boolean(),
  ageRestricted: z.boolean().optional(),
  animated: z.boolean(),
  faceCount: z.number().int().nonnegative().optional(),
  vertexCount: z.number().int().nonnegative().optional(),
  viewCount: z.number().int().nonnegative().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  downloadCount: z.number().int().nonnegative().optional(),
  publishedAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
  archives: z.array(ArchiveSchema).max(10),
  provider: z.literal("Sketchfab"),
});

function modelOutput(model: SketchfabModel) {
  return SketchfabModelSchema.parse({ ...model, provider: "Sketchfab" });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof SketchfabClientError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : {
          code: "SKETCHFAB_INTERNAL",
          message: "The Sketchfab provider could not complete the request.",
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

export const SketchfabSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  downloadable: z.boolean().default(true),
  animated: z.boolean().optional(),
  staffPicked: z.boolean().optional(),
  category: z.string().trim().regex(/^[a-z0-9-]+$/).max(100).optional(),
  licenses: z
    .array(z.string().trim().regex(/^[a-z0-9-]+$/).max(50))
    .max(10)
    .optional(),
  sortBy: z
    .enum(["relevance", "likeCount", "viewCount", "publishedAt"])
    .default("relevance"),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().trim().min(1).max(500).optional(),
});
export const SketchfabSearchOutputSchema = z.object({
  items: z.array(SketchfabModelSchema).max(100),
  nextCursor: z.string().max(500).optional(),
  provider: z.literal("Sketchfab"),
  downloadAuthentication: z.literal("SKETCHFAB_API_TOKEN"),
});

export function createSketchfabSearchHandler(client: SketchfabClient) {
  return async (raw: z.input<typeof SketchfabSearchInputSchema>) => {
    try {
      const input = SketchfabSearchInputSchema.parse(raw);
      const params = new URLSearchParams({
        type: "models",
        count: String(input.limit),
        downloadable: String(input.downloadable),
      });
      if (input.query) params.set("q", input.query);
      if (input.animated !== undefined) {
        params.set("animated", String(input.animated));
      }
      if (input.staffPicked !== undefined) {
        params.set("staffpicked", String(input.staffPicked));
      }
      if (input.category) params.set("categories", input.category);
      if (input.licenses) params.set("licenses", input.licenses.join(","));
      if (input.sortBy !== "relevance") params.set("sort_by", input.sortBy);
      if (input.cursor) params.set("cursor", input.cursor);
      const result = await client.search(params);
      return success(
        SketchfabSearchOutputSchema.parse({
          items: result.models.map(modelOutput),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          provider: "Sketchfab",
          downloadAuthentication: "SKETCHFAB_API_TOKEN",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const SketchfabGetModelInputSchema = z.object({
  modelId: z.string().trim().regex(/^[0-9a-f]{32}$/i),
});
export const SketchfabGetModelOutputSchema = SketchfabModelSchema;

export function createSketchfabGetModelHandler(client: SketchfabClient) {
  return async (raw: z.input<typeof SketchfabGetModelInputSchema>) => {
    try {
      const input = SketchfabGetModelInputSchema.parse(raw);
      return success(modelOutput(await client.getModel(input.modelId)));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const SketchfabListCategoriesInputSchema = z.object({});
export const SketchfabListCategoriesOutputSchema = z.object({
  categories: z.array(
    z.object({
      name: z.string().max(200),
      slug: z.string().max(200),
    }),
  ),
  provider: z.literal("Sketchfab"),
});

export function createSketchfabListCategoriesHandler(client: SketchfabClient) {
  return async (raw: z.input<typeof SketchfabListCategoriesInputSchema>) => {
    try {
      SketchfabListCategoriesInputSchema.parse(raw);
      return success(
        SketchfabListCategoriesOutputSchema.parse({
          categories: await client.listCategories(),
          provider: "Sketchfab",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

const DownloadSchema = z.object({
  format: z.string().max(30),
  url: z.url().max(4_096),
  expiresInSeconds: z.number().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export const SketchfabGetDownloadsInputSchema = z.object({
  modelId: z.string().trim().regex(/^[0-9a-f]{32}$/i),
});
export const SketchfabGetDownloadsOutputSchema = z.object({
  downloads: z.array(DownloadSchema).max(10),
  provider: z.literal("Sketchfab"),
  authentication: z.literal("user-token"),
  warning: z.literal(
    "Download URLs are temporary. Follow the model's Creative Commons license requirements.",
  ),
});

export function createSketchfabGetDownloadsHandler(client: SketchfabClient) {
  return async (raw: z.input<typeof SketchfabGetDownloadsInputSchema>) => {
    try {
      const input = SketchfabGetDownloadsInputSchema.parse(raw);
      return success(
        SketchfabGetDownloadsOutputSchema.parse({
          downloads: await client.getDownloads(input.modelId),
          provider: "Sketchfab",
          authentication: "user-token",
          warning:
            "Download URLs are temporary. Follow the model's Creative Commons license requirements.",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
