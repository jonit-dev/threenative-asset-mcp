import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  CreatureOperationError,
  type CreatureCompileEvidence,
  type CreatureGlbInspection,
  type CreatureJudgeResult,
  type CreatureRunner,
} from "./runner.js";

const CHECK_TIMEOUT_MS = 120_000;
const CLAIM_TYPES = [
  "part_exists",
  "part_visible",
  "part_signature",
  "style_dark",
  "style_light",
  "rig_skinned",
  "anim_named",
  "tri_budget",
  "share_hierarchy",
  "focal_contrast",
  "saturation_area",
] as const;
const CLAIM_STAGES = ["LOW", "MID", "HIGH"] as const;
const CLAIM_VIEWS = ["front", "side", "tq", "reartq", "top"] as const;
const CLAIM_ENFORCEMENT = ["block", "advise"] as const;

export type CreatureCheckMode = "structural" | "claims";
export type CreatureCheckStage = (typeof CLAIM_STAGES)[number];
type ClaimType = (typeof CLAIM_TYPES)[number];
type ClaimEnforcement = (typeof CLAIM_ENFORCEMENT)[number];
type RawClaim = Record<string, unknown>;
type ValidatedClaim = RawClaim & {
  readonly type: ClaimType;
  readonly stage?: CreatureCheckStage;
  readonly enforce: ClaimEnforcement;
};
type IndexedClaim = {
  readonly index: number;
  readonly claim: ValidatedClaim;
};
type ClaimsDocument = { readonly name?: string; readonly claims: readonly ValidatedClaim[] };
type MetricsDocument = Record<string, unknown>;

const CreatureCheckStructuralInputSchema = z
  .object({
    glbPath: z.string().trim().min(1).max(1_000),
    mode: z.literal("structural"),
  })
  .strict();

const CreatureCheckClaimsInputSchema = z
  .object({
    glbPath: z.string().trim().min(1).max(1_000),
    mode: z.literal("claims"),
    claimsPath: z.string().trim().min(1).max(1_000),
    stage: z.enum(CLAIM_STAGES),
  })
  .strict();

export const CreatureCheckInputSchema = z.discriminatedUnion("mode", [
  CreatureCheckStructuralInputSchema,
  CreatureCheckClaimsInputSchema,
]);

const BoundsSchema = z.object({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  length: z.number().finite().nonnegative(),
}).strict();

const ClipDetailSchema = z.object({
  name: z.string().min(1),
  channels: z.number().int().positive(),
  tracks: z.array(z.object({
    node: z.string().min(1),
    path: z.string().min(1),
    keyframes: z.number().int().positive(),
  }).strict()).min(1),
}).strict();

const MeasurementsSchema = z.object({
  bytes: z.number().int().positive(),
  vertices: z.number().int().positive(),
  faces: z.number().int().positive(),
  joints: z.number().int().positive(),
  bounds: BoundsSchema,
  materials: z.object({
    count: z.number().int().positive(),
    names: z.array(z.string().min(1)).min(1),
  }).strict(),
  meshes: z.array(z.object({
    name: z.string().min(1),
    primitives: z.number().int().positive(),
    vertices: z.number().int().positive(),
    faces: z.number().int().positive(),
    materials: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  rig: z.object({
    skinCount: z.number().int().positive(),
    skinnedMeshes: z.number().int().nonnegative(),
    joints: z.number().int().positive(),
  }).strict(),
  clips: z.array(z.string().min(1)),
  clipDetails: z.array(ClipDetailSchema),
}).strict();

const UpstreamCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  warned: z.boolean().optional(),
}).strict();

const UpstreamSchema = z.object({
  checks: z.array(UpstreamCheckSchema),
  advisories: z.array(z.string()),
  receiptPath: z.string().min(1).optional(),
}).strict();

const ClaimResultSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(CLAIM_TYPES),
  stage: z.enum(CLAIM_STAGES).optional(),
  enforce: z.enum(CLAIM_ENFORCEMENT),
  status: z.enum(["passed", "failed", "advisory"]),
  message: z.string().max(2_000).optional(),
}).strict();

const ObservationSchema = z.object({
  index: z.number().int().nonnegative(),
  metric: z.string().min(1),
  value: z.unknown(),
  required: z.literal(true),
}).strict();

const CreatureCheckSuccessBaseSchema = z.object({
  operation: z.literal("creature_check"),
  passed: z.boolean(),
  glbPath: z.string().min(1),
  glbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  measurements: MeasurementsSchema,
  sourceSpec: z.unknown().nullable(),
  sourceSpecReason: z.string().max(1_000).optional(),
  structuralErrors: z.array(z.string()),
  upstream: UpstreamSchema,
  receiptPath: z.string().min(1).optional(),
  visualReview: z.literal("notReviewed"),
}).strict();

const CreatureCheckStructuralSuccessSchema = CreatureCheckSuccessBaseSchema
  .extend({ mode: z.literal("structural") })
  .strict();

const CreatureCheckClaimsSuccessSchema = CreatureCheckSuccessBaseSchema
  .extend({
    mode: z.literal("claims"),
    claims: z.array(ClaimResultSchema),
    observations: z.array(ObservationSchema),
    metricsPath: z.string().min(1).optional(),
  })
  .strict();

const CreatureCheckSuccessSchema = z.discriminatedUnion("mode", [
  CreatureCheckStructuralSuccessSchema,
  CreatureCheckClaimsSuccessSchema,
]);

const CreatureCheckFailureSchema = z.object({
  operation: z.literal("creature_check"),
  code: z.enum([
    "INVALID_SPEC",
    "INVALID_CLAIMS",
    "COMPILE_BLOCKED",
    "OUTPUT_INVALID",
    "OUTPUT_CONFLICT",
    "TOOLCHAIN_UNAVAILABLE",
    "TIMEOUT",
    "CANCELLED",
    "BUSY",
    "PREVIEW_COMPARISON",
  ]),
  message: z.string().min(1).max(2_000),
  detail: z.record(z.string(), z.unknown()),
  visualReview: z.literal("notReviewed"),
}).strict();

export const CreatureCheckOutputSchema = z.union([
  CreatureCheckSuccessSchema,
  CreatureCheckFailureSchema,
]);

export type CreatureCheckSuccess = z.output<typeof CreatureCheckSuccessSchema>;
export type CreatureCheckFailure = z.output<typeof CreatureCheckFailureSchema>;
export type CreatureCheckOutput = z.output<typeof CreatureCheckOutputSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CreatureOperationError("INVALID_CLAIMS", label + " must be a finite number.", { field: label });
  }
  return value;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) {
    throw new CreatureOperationError("INVALID_CLAIMS", label + " must be a nonempty string.", { field: label });
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new CreatureOperationError("INVALID_CLAIMS", label + " must be a nonempty string array.", { field: label });
  }
  return value as string[];
}

function validateView(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "string" || !(CLAIM_VIEWS as readonly string[]).includes(value))) {
    throw new CreatureOperationError("INVALID_CLAIMS", label + " must be one of " + CLAIM_VIEWS.join(", ") + ".", { field: label });
  }
}

const COMMON_FIELDS = new Set(["type", "stage", "enforce", "when", "label"]);
const TYPE_FIELDS: Readonly<Record<ClaimType, readonly string[]>> = {
  part_exists: ["part"],
  part_visible: ["part", "view", "min_share"],
  part_signature: ["part", "view", "min_share", "or_min_span"],
  style_dark: ["view", "max_median_lum"],
  style_light: ["view", "min_median_lum"],
  rig_skinned: [],
  anim_named: ["names"],
  tri_budget: ["min", "max"],
  share_hierarchy: ["primary", "secondary", "tertiary", "view", "tolerance"],
  focal_contrast: ["a", "b", "view", "min_ratio"],
  saturation_area: ["view", "min", "max"],
};

const CLAIM_GUIDANCE: Readonly<Record<ClaimType, string>> = {
  part_exists: "part",
  part_visible: "part, min_share; view optional",
  part_signature: "part, min_share, or_min_span; view optional",
  style_dark: "max_median_lum; view optional",
  style_light: "min_median_lum; view optional",
  rig_skinned: "no type-specific fields",
  anim_named: "names",
  tri_budget: "min, max",
  share_hierarchy: "primary, secondary, tertiary; view and tolerance optional",
  focal_contrast: "a, b; view and min_ratio optional",
  saturation_area: "view, min and max optional",
};

export function creatureCheckGuide(): string {
  const claims = CLAIM_TYPES
    .map((type) => `- ${type}: ${CLAIM_GUIDANCE[type]}. Common optional fields: stage, enforce (block|advise), when (allocate|verify), label.`)
    .join("\n");
  return [
    "## ThreeNative MCP creature_check",
    "",
    "Call creature_check after creature_compile. All paths are project-relative and all wrapper fields are strict.",
    "",
    "Input:",
    "- structural: {\"glbPath\":\"assets/creatures/wyvern.glb\",\"mode\":\"structural\"}",
    "- claims: {\"glbPath\":\"assets/creatures/wyvern.glb\",\"mode\":\"claims\",\"claimsPath\":\".threenative/creatures/wyvern-claims.json\",\"stage\":\"LOW\"}",
    "- claimsPath and stage are required only for claims mode; stage is exactly LOW, MID or HIGH.",
    "",
    "A claims file is {\"name\":\"optional name\",\"claims\":[...]} with a nonempty claims array. Required fields by claim type:",
    claims,
    "part_visible and part_signature view values are front, side, tq, reartq or top; min_share and saturation bounds are 0..1; luminance is 0..255; tri_budget values are ordered nonnegative integers.",
    "",
    "Output always includes operation, mode, passed, glbPath, glbSha256, measurements (bytes, vertices, faces, joints, bounds, materials, meshes, rig, clips and clipDetails), sourceSpec, structuralErrors, upstream and visualReview: \"notReviewed\".",
    "Structural output is read-only and has no claims artifacts. Claims output also has claims and observations; a measured run writes metricsPath and receiptPath under .threenative/creatures/checks/.",
    "HIGH additionally requires a reachable positively weighted skin and actual nonempty idle, move and attack tracks. A structural pass never approves appearance: visualReview remains notReviewed.",
  ].join("\n");
}

function validateClaim(value: unknown, index: number, materials?: ReadonlySet<string>): ValidatedClaim {
  if (!isRecord(value)) throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " must be an object.", { index });
  if (typeof value.type !== "string" || !(CLAIM_TYPES as readonly string[]).includes(value.type)) {
    throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " has unknown type '" + String(value.type) + "'.", { index, type: value.type ?? null });
  }
  const type = value.type as ClaimType;
  const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[type]]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " has unknown field '" + unknown + "'.", { index, field: unknown });
  if (value.stage !== undefined && !(CLAIM_STAGES as readonly string[]).includes(value.stage as string)) {
    throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " has an invalid stage.", { index, stage: value.stage });
  }
  const enforce = value.enforce ?? "block";
  if (!(CLAIM_ENFORCEMENT as readonly string[]).includes(enforce as string)) {
    throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " has invalid enforce '" + String(enforce) + "'.", { index, enforce });
  }
  if (value.when !== undefined && !["allocate", "verify"].includes(value.when as string)) {
    throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " has invalid when.", { index, when: value.when });
  }
  if (value.label !== undefined) nonemptyString(value.label, "claims[" + index + "].label");
  const requiresPart = type === "part_exists" || type === "part_visible" || type === "part_signature";
  if (requiresPart) {
    const part = nonemptyString(value.part, "claims[" + index + "].part");
    if (materials && type !== "part_exists" && !materials.has(part)) {
      throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " references unknown material '" + part + "'.", { index, part });
    }
  }
  if (type === "part_visible" || type === "part_signature") {
    validateView(value.view, "claims[" + index + "].view");
    const share = finiteNumber(value.min_share, "claims[" + index + "].min_share");
    if (share < 0 || share > 1) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "].min_share must be between 0 and 1.");
    if (type === "part_signature") {
      const span = finiteNumber(value.or_min_span, "claims[" + index + "].or_min_span");
      if (span < 0) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "].or_min_span must be nonnegative.");
    }
  }
  if (type === "style_dark" || type === "style_light") {
    validateView(value.view, "claims[" + index + "].view");
    const lum = finiteNumber(type === "style_dark" ? value.max_median_lum : value.min_median_lum, "claims[" + index + "].luminance");
    if (lum < 0 || lum > 255) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "] luminance must be between 0 and 255.");
  }
  if (type === "anim_named") stringArray(value.names, "claims[" + index + "].names");
  if (type === "tri_budget") {
    const min = finiteNumber(value.min, "claims[" + index + "].min");
    const max = finiteNumber(value.max, "claims[" + index + "].max");
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "] triangle bounds must be ordered nonnegative integers.");
  }
  if (type === "share_hierarchy") {
    for (const group of ["primary", "secondary", "tertiary"] as const) {
      const names = stringArray(value[group], "claims[" + index + "]." + group);
      if (materials) for (const part of names) if (!materials.has(part)) throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " references unknown material '" + part + "'.", { index, part });
    }
    validateView(value.view, "claims[" + index + "].view");
    if (value.tolerance !== undefined) {
      const tolerance = finiteNumber(value.tolerance, "claims[" + index + "].tolerance");
      if (tolerance < 0 || tolerance > 1) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "].tolerance must be between 0 and 1.");
    }
  }
  if (type === "focal_contrast") {
    const a = nonemptyString(value.a, "claims[" + index + "].a");
    const b = nonemptyString(value.b, "claims[" + index + "].b");
    if (materials && (!materials.has(a) || !materials.has(b))) throw new CreatureOperationError("INVALID_CLAIMS", "Claim " + index + " references an unknown focal material.", { index });
    validateView(value.view, "claims[" + index + "].view");
    if (value.min_ratio !== undefined && finiteNumber(value.min_ratio, "claims[" + index + "].min_ratio") < 1) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "].min_ratio must be at least 1.");
  }
  if (type === "saturation_area") {
    validateView(value.view, "claims[" + index + "].view");
    const min = value.min === undefined ? 0.1 : finiteNumber(value.min, "claims[" + index + "].min");
    const max = value.max === undefined ? undefined : finiteNumber(value.max, "claims[" + index + "].max");
    if (min < 0 || min > 1 || (max !== undefined && (max < min || max > 1))) throw new CreatureOperationError("INVALID_CLAIMS", "claims[" + index + "] saturation bounds must be ordered values between 0 and 1.");
  }
  return { ...value, type, enforce: enforce as ClaimEnforcement } as ValidatedClaim;
}

async function readClaims(runner: CreatureRunner, requestPath: string): Promise<ClaimsDocument> {
  const file = await runner.resolveProjectFile(requestPath, "claimsPath").catch((error) => {
    if (error instanceof CreatureOperationError) throw new CreatureOperationError("INVALID_CLAIMS", error.message, error.detail);
    throw error;
  });
  const info = await stat(file.absolute).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0 || info.size > runner.limits.specBytes) {
    throw new CreatureOperationError("INVALID_CLAIMS", "The claims file must be a nonempty regular JSON file no larger than " + runner.limits.specBytes + " bytes.", { claimsPath: requestPath });
  }
  const bytes = await readFile(file.absolute);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CreatureOperationError("INVALID_CLAIMS", "The claims file must be well-formed UTF-8 JSON.");
  }
  if (!isRecord(value)) throw new CreatureOperationError("INVALID_CLAIMS", "The claims document must be an object.");
  const unknown = Object.keys(value).find((key) => key !== "name" && key !== "claims");
  if (unknown) throw new CreatureOperationError("INVALID_CLAIMS", "The claims document has unknown field '" + unknown + "'.");
  if (value.name !== undefined) nonemptyString(value.name, "claims.name");
  if (!Array.isArray(value.claims) || value.claims.length === 0) throw new CreatureOperationError("INVALID_CLAIMS", "The claims document must contain a nonempty claims array.");
  const claims = value.claims.map((claim, index) => validateClaim(claim, index));
  return { ...(typeof value.name === "string" ? { name: value.name } : {}), claims };
}

function selectClaims(claims: readonly ValidatedClaim[], stage: CreatureCheckStage): IndexedClaim[] {
  const selected = claims.flatMap((claim, index) =>
    claim.stage === undefined || claim.stage === stage ? [{ index, claim }] : [],
  );
  if (!selected.length) throw new CreatureOperationError("INVALID_CLAIMS", "No claims apply to stage " + stage + "; the selected claim set must be nonempty.");
  return selected;
}

function markedClaims(document: ClaimsDocument, selected: readonly IndexedClaim[]): { document: ClaimsDocument; markers: Map<number, string> } {
  const selectedIndexes = new Set(selected.map(({ index }) => index));
  const markers = new Map<number, string>();
  const claims = document.claims.map((claim, index) => {
    if (!selectedIndexes.has(index)) return claim;
    const marker = "__threenative_claim_" + index + "__";
    markers.set(index, marker);
    return { ...claim, label: (typeof claim.label === "string" ? claim.label + " " : "") + marker };
  });
  return { document: { ...document, claims }, markers };
}

function metricAt(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !(part in current)) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output is missing required observation '" + path + "'.", { observation: path });
    current = current[part];
  }
  if (current === null || current === undefined) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an empty required observation '" + path + "'.", { observation: path });
  if (typeof current === "number" && !Number.isFinite(current)) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has a non-finite required observation '" + path + "'.", { observation: path });
  return current;
}

function metricNumber(root: unknown, path: string): number {
  const value = metricAt(root, path);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid numeric observation '" + path + "'.", { observation: path });
  }
  return value;
}

function metricStrings(root: unknown, path: string): string[] {
  const value = metricAt(root, path);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid string-list observation '" + path + "'.", { observation: path });
  }
  return value;
}

function assertMetricsShape(metrics: MetricsDocument): void {
  const stats = metricAt(metrics, "stats");
  if (!isRecord(stats)) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid stats observation.", { observation: "stats" });
  for (const field of ["triangles", "skinnedMeshes"] as const) {
    const value = metricAt(metrics, "stats." + field);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid stats." + field + " observation.", { observation: "stats." + field });
  }
  const animations = metricAt(stats, "animations");
  if (!Array.isArray(animations) || animations.some((entry) => typeof entry !== "string")) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid stats.animations observation.", { observation: "stats.animations" });
  metricStrings(metrics, "names");
  if (!isRecord(metricAt(metrics, "parts"))) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid parts observation.", { observation: "parts" });
  if (!isRecord(metricAt(metrics, "lum"))) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid lum observation.", { observation: "lum" });
  if (!isRecord(metricAt(metrics, "hi_sat_share"))) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid hi_sat_share observation.", { observation: "hi_sat_share" });
  if (!isRecord(metricAt(metrics, "whole"))) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output has an invalid whole observation.", { observation: "whole" });
}

function assertJudgeMatchesInspection(
  metrics: MetricsDocument,
  inspection: CreatureGlbInspection,
): void {
  const observed = metricNumber(metrics, "stats.skinnedMeshes");
  if (observed !== inspection.skinnedMeshes) {
    throw new CreatureOperationError(
      "OUTPUT_INVALID",
      "Claims judge skinned mesh count does not match the actual reachable GLB skin bindings.",
      {
        observation: "stats.skinnedMeshes",
        inspected: inspection.skinnedMeshes,
        judged: observed,
      },
    );
  }
}

function claimObservations(metrics: MetricsDocument, selected: readonly IndexedClaim[]): z.output<typeof ObservationSchema>[] {
  assertMetricsShape(metrics);
  const observations: z.output<typeof ObservationSchema>[] = [];
  const add = (index: number, metric: string) => observations.push({ index, metric, value: metricNumber(metrics, metric), required: true });
  const addStrings = (index: number, metric: string) => observations.push({ index, metric, value: metricStrings(metrics, metric), required: true });
  selected.forEach(({ index, claim }) => {
    const view = (claim.view as string | undefined) ?? "side";
    switch (claim.type) {
      case "part_exists": addStrings(index, "names"); break;
      case "part_visible": add(index, "parts." + String(claim.part) + ".share." + view); break;
      case "part_signature":
        add(index, "parts." + String(claim.part) + ".share." + view);
        add(index, "parts." + String(claim.part) + ".span_ratio");
        break;
      case "style_dark":
      case "style_light": add(index, "lum." + view); break;
      case "rig_skinned": add(index, "stats.skinnedMeshes"); break;
      case "anim_named": addStrings(index, "stats.animations"); break;
      case "tri_budget": add(index, "stats.triangles"); break;
      case "share_hierarchy":
        for (const group of ["primary", "secondary", "tertiary"] as const) for (const part of claim[group] as string[]) add(index, "parts." + part + ".share." + view);
        break;
      case "focal_contrast":
        add(index, "parts." + String(claim.a) + ".share." + view);
        add(index, "parts." + String(claim.b) + ".share." + view);
        break;
      case "saturation_area": add(index, "hi_sat_share." + ((claim.view as string | undefined) ?? "tq")); break;
    }
  });
  return observations;
}

export function validateClaimsMetrics(metrics: unknown, claims: readonly RawClaim[]): z.output<typeof ObservationSchema>[] {
  if (!isRecord(metrics)) throw new CreatureOperationError("OUTPUT_INVALID", "Claims judge output is not a JSON object.");
  return claimObservations(metrics, claims.map((claim, index) => ({ index, claim: validateClaim(claim, index) })));
}

async function readMetrics(path: string, maxBytes: number): Promise<MetricsDocument> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) throw new CreatureOperationError("OUTPUT_INVALID", "The claims judge did not produce a safe, bounded metrics artifact.", { metricsPath: path });
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length <= 0 || bytes.length > maxBytes) {
    throw new CreatureOperationError("OUTPUT_INVALID", "The claims judge metrics artifact changed or exceeded its byte bound after inspection.", { metricsPath: path, maxBytes });
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CreatureOperationError("OUTPUT_INVALID", "The claims judge metrics artifact is malformed JSON.", { metricsPath: path });
  }
  if (!isRecord(value)) throw new CreatureOperationError("OUTPUT_INVALID", "The claims judge metrics artifact must be a JSON object.", { metricsPath: path });
  return value;
}

function markerLine(text: string, marker: string): string | undefined {
  return text.split("\n").map((line) => line.trim()).find((line) => line.includes(marker));
}

function claimResults(selected: readonly IndexedClaim[], markers: ReadonlyMap<number, string>, judge: CreatureJudgeResult): z.output<typeof ClaimResultSchema>[] {
  const text = judge.stdout + "\n" + judge.stderr;
  return selected.map(({ index, claim }) => {
    const marker = markers.get(index);
    const message = marker ? markerLine(text, marker) : undefined;
    const failed = message !== undefined;
    return {
      index,
      type: claim.type,
      ...(claim.stage ? { stage: claim.stage } : {}),
      enforce: claim.enforce,
      status: failed ? (claim.enforce === "advise" ? "advisory" : "failed") : "passed",
      ...(message ? { message: message.replace(" [" + marker + "]", "").slice(0, 2_000) } : {}),
    };
  });
}

function measurements(inspection: CreatureGlbInspection): z.output<typeof MeasurementsSchema> {
  return {
    bytes: inspection.bytes,
    vertices: inspection.vertices,
    faces: inspection.faces,
    joints: inspection.joints,
    bounds: inspection.bounds,
    materials: { count: inspection.materials.length, names: inspection.materials.map((material) => material.name) },
    meshes: inspection.meshes.map((mesh) => ({ ...mesh, materials: [...mesh.materials] })),
    rig: { skinCount: 1, skinnedMeshes: inspection.skinnedMeshes, joints: inspection.joints },
    clips: [...inspection.clips],
    clipDetails: inspection.clipDetails.map((clip) => ({ ...clip, tracks: clip.tracks.map((track) => ({ ...track })) })),
  };
}

function upstream(evidence: CreatureCompileEvidence): z.output<typeof UpstreamSchema> {
  const checks = Array.isArray(evidence.checks?.checks)
    ? evidence.checks.checks.filter(isRecord).flatMap((check) => typeof check.name === "string" && typeof check.passed === "boolean"
      ? [{ name: check.name, passed: check.passed, ...(typeof check.warned === "boolean" ? { warned: check.warned } : {}) }]
      : [])
    : [];
  return {
    checks,
    advisories: [...evidence.advisories],
    ...(evidence.receiptPath ? { receiptPath: evidence.receiptPath } : {}),
  };
}

function highErrors(inspection: CreatureGlbInspection): string[] {
  const errors: string[] = [];
  if (inspection.skinnedMeshes < 1) errors.push("HIGH delivery requires a mesh node bound to the actual skin.");
  const details = new Map(inspection.clipDetails.map((clip) => [clip.name, clip]));
  for (const name of ["idle", "move", "attack"] as const) {
    const clip = details.get(name);
    if (!clip) errors.push("HIGH delivery requires the actual '" + name + "' animation clip.");
    else if (clip.channels < 1 || clip.tracks.length < 1) errors.push("HIGH delivery requires '" + name + "' to contain a nonempty bound track.");
  }
  return errors;
}

function checkFailure(error: unknown): CreatureCheckFailure {
  if (error instanceof CreatureOperationError) {
    return CreatureCheckFailureSchema.parse({ operation: "creature_check", code: error.code, message: error.message, detail: error.detail, visualReview: "notReviewed" });
  }
  if (error instanceof z.ZodError) {
    return CreatureCheckFailureSchema.parse({
      operation: "creature_check",
      code: "INVALID_CLAIMS",
      message: "The creature check input or output did not match its strict schema.",
      detail: { issues: error.issues.slice(0, 20) },
      visualReview: "notReviewed",
    });
  }
  return CreatureCheckFailureSchema.parse({ operation: "creature_check", code: "TOOLCHAIN_UNAVAILABLE", message: "The creature check could not complete the local inspection.", detail: {}, visualReview: "notReviewed" });
}

export async function checkCreature(
  runner: CreatureRunner,
  rawInput: z.input<typeof CreatureCheckInputSchema>,
  callerSignal?: AbortSignal,
): Promise<CreatureCheckOutput> {
  const input = CreatureCheckInputSchema.parse(rawInput);
  const inspection = await runner.inspectCreature(input.glbPath);
  const evidence = await runner.collectCompileEvidence(inspection.glbPath, inspection.glbSha256);
  const structuralErrors = [...inspection.structuralErrors];
  const base = {
    operation: "creature_check" as const,
    mode: input.mode,
    glbPath: inspection.glbPath,
    glbSha256: inspection.glbSha256,
    measurements: measurements(inspection),
    sourceSpec: inspection.sourceSpec,
    ...(inspection.sourceSpecReason ? { sourceSpecReason: inspection.sourceSpecReason } : {}),
    structuralErrors,
    upstream: upstream(evidence),
    visualReview: "notReviewed" as const,
  };
  if (input.mode === "structural") return CreatureCheckOutputSchema.parse({ ...base, passed: structuralErrors.length === 0 });

  const document = await readClaims(runner, input.claimsPath as string);
  const claims = document.claims.map((claim, index) => validateClaim(claim, index, new Set(inspection.materials.map((material) => material.name))));
  const selected = selectClaims(claims, input.stage as CreatureCheckStage);
  const deliveryErrors = input.stage === "HIGH" ? highErrors(inspection) : [];
  structuralErrors.push(...deliveryErrors);
  if (deliveryErrors.length) {
    return CreatureCheckOutputSchema.parse({
      ...base,
      structuralErrors,
      passed: false,
      claims: selected.map(({ index, claim }) => ({ index, type: claim.type, ...(claim.stage ? { stage: claim.stage } : {}), enforce: claim.enforce, status: "failed" as const, message: deliveryErrors.join(" ") })),
      observations: [],
    });
  }

  const marked = markedClaims({ ...(document.name ? { name: document.name } : {}), claims }, selected);
  const claimsBytes = Buffer.from(JSON.stringify(marked.document, null, 2) + "\n");
  if (claimsBytes.length > runner.limits.specBytes) throw new CreatureOperationError("INVALID_CLAIMS", "The validated claims document exceeds " + runner.limits.specBytes + " bytes.");
  const checkDirectory = await runner.createCheckDirectory("check-" + randomUUID());
  const glbFile = await runner.resolveProjectFile(inspection.glbPath, "glbPath");
  const currentGlbBytes = await readFile(glbFile.absolute);
  const currentGlbSha256 = sha256(currentGlbBytes);
  if (currentGlbSha256 !== inspection.glbSha256) {
    throw new CreatureOperationError("OUTPUT_CONFLICT", "The creature GLB changed after inspection; rerun the check against the current artifact.", {
      glbPath: inspection.glbPath,
      inspectedSha256: inspection.glbSha256,
      observedSha256: currentGlbSha256,
    });
  }
  const stagedGlbPath = join(checkDirectory.directory, "input.glb");
  await writeFile(stagedGlbPath, currentGlbBytes, { flag: "wx", mode: 0o600 });
  const judge = await runner.withHeavyOperation(
    CHECK_TIMEOUT_MS,
    "Creature claims measurement exceeded " + CHECK_TIMEOUT_MS + " ms; retry with a smaller asset or when the machine is less loaded.",
    callerSignal,
    (signal) => runner.runClaimsJudge({
      glbAbsolute: stagedGlbPath,
      claims: claimsBytes,
      outputDirectory: checkDirectory.directory,
      name: "creature-check",
      stage: input.stage as CreatureCheckStage,
    }, signal),
  );
  if (judge.overflow || judge.spawnError || ![0, 1].includes(judge.exitCode ?? -1)) {
    throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The pinned claims judge could not complete its browser measurement; install Chromium or inspect the retained diagnostics and retry.", {
      exitCode: judge.exitCode,
      signal: judge.signalCode,
      overflow: judge.overflow,
      ...(judge.spawnError ? { spawnError: judge.spawnError } : {}),
      stderr: judge.stderr.slice(-2_000),
    });
  }
  const metrics = await readMetrics(judge.metricsPath, runner.limits.diagnosticsBytes);
  assertJudgeMatchesInspection(metrics, inspection);
  const observations = claimObservations(metrics, selected);
  const results = claimResults(selected, marked.markers, judge);
  if (judge.exitCode === 1 && !results.some((result) => result.status !== "passed")) throw new CreatureOperationError("OUTPUT_INVALID", "The claims judge failed without identifying a validated claim.", { stdout: judge.stdout.slice(-2_000), stderr: judge.stderr.slice(-2_000) });
  const passed = structuralErrors.length === 0 && results.every((result) => result.status !== "failed");
  const metricsBytes = await readFile(judge.metricsPath);
  const receiptPath = join(checkDirectory.directory, "receipt.json");
  const receipt = {
    schemaVersion: 1,
    operation: "creature_check",
    createdAt: new Date().toISOString(),
    mode: input.mode,
    stage: input.stage,
    glbPath: inspection.glbPath,
    glbSha256: inspection.glbSha256,
    inputGlbPath: checkDirectory.relative + "/input.glb",
    claimsSha256: createHash("sha256").update(claimsBytes).digest("hex"),
    metricsPath: checkDirectory.relative + "/creature-check_metrics.json",
    metricsSha256: createHash("sha256").update(metricsBytes).digest("hex"),
    judgeExitCode: judge.exitCode,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return CreatureCheckOutputSchema.parse({
    ...base,
    structuralErrors,
    passed,
    claims: results,
    observations,
    metricsPath: checkDirectory.relative + "/creature-check_metrics.json",
    receiptPath: checkDirectory.relative + "/receipt.json",
  });
}

export function creatureCheckError(error: unknown): CreatureCheckFailure {
  return checkFailure(error);
}
