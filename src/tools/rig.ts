import { z } from "zod";

import { loadRigConfig } from "../config.js";
import { acquirePinnedSample, type AcquiredSample } from "../rig/acquire.js";
import { RIG_CATALOG_SOURCES, buildAnimationCatalog, type RigClipDescriptor } from "../rig/catalog.js";
import {
  inspectLocalAsset,
  RIG_LIMITS,
  RigAssetError,
  type InspectedGlb,
  type RigLimits,
} from "../rig/inspect.js";

const PathSchema = z.string().min(1).max(4_096);

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const MeshSchema = z.object({
  name: z.string().max(300),
  primitives: z.number().int().nonnegative(),
  vertices: z.number().int().nonnegative(),
  attributes: z.array(z.string().max(64)).max(64),
  skinned: z.boolean(),
});

const SkinSchema = z.object({
  name: z.string().max(300),
  joints: z.number().int().nonnegative(),
  jointNames: z.array(z.string().max(300)).max(2_048),
  hasInverseBindMatrices: z.boolean(),
});

const AnimationSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().max(300),
  channels: z.number().int().nonnegative(),
  samplers: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
});

const BoneRoleSchema = z.object({
  role: z.string().max(64),
  side: z.enum(["left", "right"]).nullable(),
  joint: z.string().max(300).nullable(),
  candidates: z.array(z.string().max(300)).max(64),
  ambiguous: z.boolean(),
});

const RigReportSchema = z.object({
  meshes: z.array(MeshSchema).max(4_096),
  skins: z.array(SkinSchema).max(64),
  animations: z.array(AnimationSchema).max(1_024),
  materials: z
    .array(
      z.object({
        name: z.string().max(300),
        doubleSided: z.boolean(),
        alphaMode: z.string().max(32),
      }),
    )
    .max(4_096),
  textures: z.number().int().nonnegative(),
  extensionsUsed: z.array(z.string().max(128)).max(256),
  extensionsRequired: z.array(z.string().max(128)).max(256),
  bounds: z.object({ min: Vec3Schema, max: Vec3Schema }).nullable(),
  boneRoles: z.array(BoneRoleSchema).max(128),
  attachmentCandidates: z.array(z.string().max(300)).max(2_048),
});

const InspectedGlbSchema = z.object({
  path: z.string().max(4_096),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  report: RigReportSchema,
});

const ClipSchema = z.object({
  id: z.string().max(400),
  library: z.string().max(64),
  name: z.string().max(300),
  variant: z.enum(["in_place", "root_motion"]),
  entry: z.string().max(4_096),
  entrySha256: z.string().regex(/^[0-9a-f]{64}$/),
  channels: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  calibration: z.boolean(),
  donor: z.object({
    url: z.url().max(2_048).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  }),
});

const SourceSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(300),
  kind: z.enum(["sample", "library"]),
  license: z.literal("CC0"),
  attributionRequired: z.literal(false),
  sourceUrl: z.url().max(2_048),
  revision: z.string().max(64).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  archives: z
    .array(
      z.object({
        variant: z.enum(["in_place", "root_motion"]),
        archiveEntry: z.string().max(4_096),
      }),
    )
    .max(8),
});

const SampleTargetSchema = z.object({
  sourceId: z.literal("aether-02").describe("Explicitly acquire the pinned AETHER / 02 sample."),
});

export const AssetInspectRigInputSchema = z.object({
  target: z
    .union([PathSchema, SampleTargetSchema])
    .describe(
      "Absolute path to the humanoid GLB under inspection, or a pinned sample reference to acquire into the development cache.",
    ),
  libraries: z
    .array(PathSchema)
    .max(8)
    .optional()
    .describe("Optional local UAL ZIP archives or GLB libraries used as animation donors."),
});

export const AssetInspectRigOutputSchema = z.object({
  sources: z.array(SourceSchema).max(32),
  target: InspectedGlbSchema,
  acquisition: z
    .object({
      sourceId: z.string().max(64),
      sourceUrl: z.url().max(2_048),
      path: z.string().max(4_096),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      alreadyCached: z.boolean(),
    })
    .nullable(),
  libraries: z
    .array(
      z.object({
        path: z.string().max(4_096),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        entries: z.array(InspectedGlbSchema).max(64),
        clips: z.array(ClipSchema).max(2_048),
      }),
    )
    .max(8),
  catalog: z.array(ClipSchema).max(4_096),
  attachmentCandidates: z.array(z.string().max(300)).max(2_048),
  limits: z.object({
    maxGlbBytes: z.number().int().positive(),
    maxArchiveBytes: z.number().int().positive(),
  }),
});

function sourceOutput(source: (typeof RIG_CATALOG_SOURCES)[number]) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    license: source.license,
    attributionRequired: source.attributionRequired,
    sourceUrl: source.sourceUrl,
    revision: source.revision ?? null,
    bytes: source.bytes ?? null,
    sha256: source.sha256 ?? null,
    archives: [...(source.archives ?? [])],
  };
}

function libraryIdFor(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const lowered = base.toLowerCase();
  if (lowered.includes("ual1")) return "ual1";
  if (lowered.includes("ual2")) return "ual2";
  return base.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "library";
}

function variantFor(path: string): "in_place" | "root_motion" {
  return /_rm\.(glb|fbx)$/i.test(path) ? "root_motion" : "in_place";
}

export interface AssetInspectRigOptions {
  limits?: RigLimits;
  acquire?: (sourceId: string) => Promise<AcquiredSample>;
}

export function createAssetInspectRigHandler(options: AssetInspectRigOptions = {}) {
  const limits = options.limits ?? RIG_LIMITS;
  const acquire =
    options.acquire ?? ((sourceId: string) => acquirePinnedSample({ sourceId, config: loadRigConfig() }));
  return async (raw: z.input<typeof AssetInspectRigInputSchema>) => {
    try {
      const input = AssetInspectRigInputSchema.parse(raw);
      let targetPath: string;
      let acquisition: {
        sourceId: string;
        sourceUrl: string;
        path: string;
        bytes: number;
        sha256: string;
        alreadyCached: boolean;
      } | null = null;
      if (typeof input.target === "string") {
        targetPath = input.target;
      } else {
        const acquired = await acquire(input.target.sourceId);
        targetPath = acquired.path;
        acquisition = { sourceId: input.target.sourceId, ...acquired };
      }
      const target = await inspectLocalAsset(targetPath, limits);
      if (target.kind !== "glb") {
        throw new RigAssetError(
          "RIG_INVALID_INPUT",
          "The target must be a GLB, not an archive.",
        );
      }

      const libraries: Array<{
        path: string;
        bytes: number;
        sha256: string;
        entries: InspectedGlb[];
        clips: RigClipDescriptor[];
      }> = [];
      const catalog: RigClipDescriptor[] = [];

      for (const libraryPath of input.libraries ?? []) {
        const inspected = await inspectLocalAsset(libraryPath, limits);
        const library =
          inspected.kind === "archive"
            ? inspected.library
            : {
                path: inspected.glb.path,
                bytes: inspected.glb.bytes,
                sha256: inspected.glb.sha256,
                entries: [inspected.glb],
              };
        const clips = library.entries.flatMap((entry) => {
          const variant = variantFor(entry.path);
          return buildAnimationCatalog({
            libraryId: libraryIdFor(entry.path),
            variant,
            entryPath: entry.path,
            entrySha256: entry.sha256,
            animations: entry.report.animations,
          });
        });
        libraries.push({ ...library, clips });
        catalog.push(...clips);
      }

      const output = AssetInspectRigOutputSchema.parse({
        sources: RIG_CATALOG_SOURCES.map(sourceOutput),
        target: {
          path: target.glb.path,
          bytes: target.glb.bytes,
          sha256: target.glb.sha256,
          report: target.glb.report,
        },
        acquisition,
        libraries,
        catalog,
        attachmentCandidates: target.glb.report.attachmentCandidates,
        limits: {
          maxGlbBytes: limits.maxGlbBytes,
          maxArchiveBytes: limits.maxArchiveBytes,
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof RigAssetError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? {
                code: "RIG_INVALID_INPUT",
                message: "The rig inspection request is invalid.",
                retryable: false,
              }
            : {
                code: "RIG_INTERNAL",
                message: "The asset MCP could not complete the rig inspection.",
                retryable: false,
              };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
