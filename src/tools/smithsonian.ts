import { z } from "zod";

import {
  SMITHSONIAN_FILE_TYPES,
  SMITHSONIAN_MODEL_TYPES,
  SMITHSONIAN_QUALITIES,
  SmithsonianClient,
  SmithsonianClientError,
  type SmithsonianFile,
} from "../smithsonian/client.js";

const FileTypeSchema = z.enum(SMITHSONIAN_FILE_TYPES);
const ModelTypeSchema = z.enum(SMITHSONIAN_MODEL_TYPES);
const QualitySchema = z.enum(SMITHSONIAN_QUALITIES);
const FileSchema = z.object({
  modelId: z.string().max(100),
  title: z.string().max(500),
  url: z.url().max(2_048),
  fileType: z.string().max(30),
  modelType: z.string().max(30).optional(),
  quality: z.string().max(50).optional(),
  usage: z.string().max(100).optional(),
  dracoCompressed: z.boolean().optional(),
  gltfOrientationCompliant: z.boolean().optional(),
});
const AssetSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(500),
  url: z.url().max(500),
  fileTypes: z.array(z.string().max(30)).max(20),
  modelTypes: z.array(z.string().max(30)).max(20),
  qualities: z.array(z.string().max(50)).max(20),
  provider: z.literal("Smithsonian 3D"),
  license: z.literal("Smithsonian Open Access — verify item rights"),
});

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function groupFiles(files: SmithsonianFile[]) {
  const groups = new Map<string, SmithsonianFile[]>();
  for (const file of files) {
    groups.set(file.modelId, [...(groups.get(file.modelId) ?? []), file]);
  }
  return [...groups.entries()].map(([id, entries]) =>
    AssetSchema.parse({
      id,
      title: entries[0]?.title ?? id,
      url: entries[0]?.url,
      fileTypes: unique(entries.map((file) => file.fileType)),
      modelTypes: unique(entries.map((file) => file.modelType)),
      qualities: unique(entries.map((file) => file.quality)),
      provider: "Smithsonian 3D",
      license: "Smithsonian Open Access — verify item rights",
    }),
  );
}

function errorResult(error: unknown) {
  const safe =
    error instanceof SmithsonianClientError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : {
          code: "SMITHSONIAN_INTERNAL",
          message: "The Smithsonian provider could not complete the request.",
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

const ModelIdSchema = z
  .string()
  .trim()
  .regex(/^(?:3d_package:)?[0-9a-f]{8}-[0-9a-f-]{27}$/i)
  .max(100);

export const SmithsonianSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  fileType: FileTypeSchema.optional(),
  modelType: ModelTypeSchema.optional(),
  quality: QualitySchema.optional(),
  owningUnit: z.string().trim().regex(/^[A-Z]+$/).max(30).optional(),
  dracoCompressed: z.boolean().optional(),
  gltfOrientationCompliant: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const SmithsonianSearchOutputSchema = z.object({
  items: z.array(AssetSchema).max(100),
  totalFiles: z.number().int().nonnegative(),
  nextCursor: z.string().max(10).optional(),
  provider: z.literal("Smithsonian 3D"),
});

export function createSmithsonianSearchHandler(client: SmithsonianClient) {
  return async (raw: z.input<typeof SmithsonianSearchInputSchema>) => {
    try {
      const input = SmithsonianSearchInputSchema.parse(raw);
      const offset = Number(input.cursor ?? 0);
      const params = new URLSearchParams({
        start: String(offset),
        rows: String(input.limit),
      });
      if (input.query) params.set("q", input.query);
      if (input.fileType) params.set("file_type", input.fileType);
      if (input.modelType) params.set("model_type", input.modelType);
      if (input.quality) params.set("file_quality", input.quality);
      if (input.owningUnit) params.set("owning_unit", input.owningUnit);
      if (input.dracoCompressed !== undefined) {
        params.set("draco_compressed", String(input.dracoCompressed));
      }
      if (input.gltfOrientationCompliant !== undefined) {
        params.set(
          "gltf_orientation_compliant",
          String(input.gltfOrientationCompliant),
        );
      }
      const result = await client.search(params);
      return success(
        SmithsonianSearchOutputSchema.parse({
          items: groupFiles(result.files),
          totalFiles: result.totalFiles,
          ...(offset + input.limit < result.totalFiles
            ? { nextCursor: String(offset + input.limit) }
            : {}),
          provider: "Smithsonian 3D",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const SmithsonianGetAssetInputSchema = z.object({
  modelId: ModelIdSchema,
});
export const SmithsonianGetAssetOutputSchema = AssetSchema;

export function createSmithsonianGetAssetHandler(client: SmithsonianClient) {
  return async (raw: z.input<typeof SmithsonianGetAssetInputSchema>) => {
    try {
      const input = SmithsonianGetAssetInputSchema.parse(raw);
      const output = groupFiles(await client.listFiles(input.modelId))[0];
      if (!output) {
        throw new SmithsonianClientError(
          "SMITHSONIAN_NOT_FOUND",
          "The Smithsonian 3D model was not found.",
        );
      }
      return success(output);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const SmithsonianListFilesInputSchema = z.object({
  modelId: ModelIdSchema,
  fileType: FileTypeSchema.optional(),
  modelType: ModelTypeSchema.optional(),
  quality: QualitySchema.optional(),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const SmithsonianListFilesOutputSchema = z.object({
  files: z.array(FileSchema).max(200),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().max(10).optional(),
  provider: z.literal("Smithsonian 3D"),
  license: z.literal("Smithsonian Open Access — verify item rights"),
});

export function createSmithsonianListFilesHandler(client: SmithsonianClient) {
  return async (raw: z.input<typeof SmithsonianListFilesInputSchema>) => {
    try {
      const input = SmithsonianListFilesInputSchema.parse(raw);
      const files = (await client.listFiles(input.modelId)).filter(
        (file) =>
          (!input.fileType || file.fileType === input.fileType) &&
          (!input.modelType || file.modelType === input.modelType) &&
          (!input.quality || file.quality === input.quality),
      );
      const offset = Number(input.cursor ?? 0);
      const page = files.slice(offset, offset + input.limit);
      return success(
        SmithsonianListFilesOutputSchema.parse({
          files: page,
          total: files.length,
          ...(offset + page.length < files.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
          provider: "Smithsonian 3D",
          license: "Smithsonian Open Access — verify item rights",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
