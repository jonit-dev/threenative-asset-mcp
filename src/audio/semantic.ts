import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Optional local CLAP scoring: text/audio embedding similarity, used only as supporting evidence.
 *
 * Two things this module refuses to do. It never reports a similarity as a probability that the
 * sound is correct, and it never turns a missing model into a pass — an unavailable checker returns
 * `unverified` with the reason and the setup instruction, which the caller must treat as an
 * incomplete check. PyTorch is not an npm dependency; provisioning is explicit and out of band.
 */

/** Frozen with the prompts and thresholds it was calibrated against; a change here retires caches. */
export const CALIBRATION_ID = "clap-630k-audioset-best/v1-uncalibrated";

/** One versioned template for every mood hypothesis, so only the mood clause differs. */
export const MOOD_TEMPLATE_VERSION = "mood-v1";
export function moodHypothesis(sourceDescription: string, mood: string): string {
  return `The sound of ${sourceDescription}, with a ${mood} emotional tone.`;
}

const SEMANTIC_TIMEOUT_MS = 60_000;

export const SEMANTIC_SETUP_INSTRUCTION =
  "Local CLAP is not provisioned. Install the optional extras (see README 'Optional local CLAP setup') " +
  "and set AUDIO_CLAP_PYTHON to that interpreter; until then prompt and emotion fit stay unverified.";

export interface SemanticEmotionRequest {
  sourceDescription: string;
  targetMood: string;
  alternativeMoods: string[];
}

export interface SemanticRequest {
  expectedPrompt?: string;
  alternativePrompts?: string[];
  emotion?: SemanticEmotionRequest;
}

export interface SemanticScore {
  text: string;
  score: number;
}

export interface SemanticContentResult {
  requested: boolean;
  status: "consistent" | "possible_mismatch" | "unverified";
  reason: string;
  ranked: SemanticScore[];
  margin?: number;
  windows?: { startSeconds: number; endSeconds: number; ranked: SemanticScore[] }[];
  calibrationId: string;
}

export interface SemanticEmotionResult {
  status: "not_requested" | "consistent" | "possible_mismatch" | "unverified";
  requestedMood?: string;
  reason: string;
  ranked: SemanticScore[];
  margin?: number;
  windows?: { startSeconds: number; endSeconds: number; ranked: SemanticScore[] }[];
  calibrationId: string;
  moodTemplateVersion: string;
}

export interface SemanticResult {
  content: SemanticContentResult;
  emotionFit: SemanticEmotionResult;
  unavailableReason?: string;
}

function notRequested(): SemanticResult {
  return {
    content: {
      requested: false,
      status: "unverified",
      reason: "semantic_not_requested",
      ranked: [],
      calibrationId: CALIBRATION_ID,
    },
    emotionFit: {
      status: "not_requested",
      reason: "emotion_not_requested",
      ranked: [],
      calibrationId: CALIBRATION_ID,
      moodTemplateVersion: MOOD_TEMPLATE_VERSION,
    },
  };
}

function unavailable(request: SemanticRequest, reason: string): SemanticResult {
  const contentRequested = request.expectedPrompt !== undefined;
  return {
    content: {
      requested: contentRequested,
      status: "unverified",
      reason: contentRequested ? reason : "content_comparison_not_requested",
      ranked: [],
      calibrationId: CALIBRATION_ID,
    },
    emotionFit: {
      status: request.emotion === undefined ? "not_requested" : "unverified",
      ...(request.emotion === undefined ? {} : { requestedMood: request.emotion.targetMood }),
      reason: request.emotion === undefined ? "emotion_not_requested" : reason,
      ranked: [],
      calibrationId: CALIBRATION_ID,
      moodTemplateVersion: MOOD_TEMPLATE_VERSION,
    },
    unavailableReason: SEMANTIC_SETUP_INSTRUCTION,
  };
}

/** Absolute path of the adapter script shipped beside the built output. */
export function adapterScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "audio-semantic.py");
}

/** True when a caller could actually get a semantic verdict right now. Used by generation preflight. */
export async function semanticAvailable(): Promise<boolean> {
  const python = process.env.AUDIO_CLAP_PYTHON;
  if (!python) return false;
  try {
    await access(adapterScriptPath());
  } catch {
    return false;
  }
  return await new Promise<boolean>((done) => {
    execFile(
      python,
      [adapterScriptPath(), "--probe"],
      { timeout: 20_000, windowsHide: true },
      (error) => done(!error),
    );
  });
}

export async function inspectSemantics(
  request: SemanticRequest | undefined,
  audioPath: string,
): Promise<SemanticResult> {
  if (!request) return notRequested();

  const python = process.env.AUDIO_CLAP_PYTHON;
  if (!python) return unavailable(request, "semantic_model_unavailable");
  try {
    await access(adapterScriptPath());
  } catch {
    return unavailable(request, "semantic_adapter_missing");
  }

  const payload = {
    audioPath,
    ...(request.expectedPrompt === undefined
      ? {}
      : {
          content: {
            expected: request.expectedPrompt,
            alternatives: request.alternativePrompts ?? [],
          },
        }),
    ...(request.emotion === undefined
      ? {}
      : {
          emotion: {
            target: moodHypothesis(request.emotion.sourceDescription, request.emotion.targetMood),
            alternatives: request.emotion.alternativeMoods.map((mood) =>
              moodHypothesis(request.emotion!.sourceDescription, mood),
            ),
            targetMood: request.emotion.targetMood,
            alternativeMoods: request.emotion.alternativeMoods,
          },
        }),
  };

  const raw = await new Promise<string | undefined>((done) => {
    const child = execFile(
      python,
      [adapterScriptPath()],
      { timeout: SEMANTIC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => done(error ? undefined : stdout),
    );
    child.stdin?.end(JSON.stringify(payload));
  });
  // A timeout or a crashed adapter leaves fit unverified. It never becomes a pass.
  if (raw === undefined) return unavailable(request, "semantic_run_failed");

  let parsed: {
    content?: { ranked: SemanticScore[]; margin: number; windows?: SemanticContentResult["windows"] };
    emotion?: { ranked: SemanticScore[]; margin: number; windows?: SemanticEmotionResult["windows"] };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return unavailable(request, "semantic_output_unreadable");
  }

  return {
    content: contentResultOf(request, parsed.content),
    emotionFit: emotionResultOf(request, parsed.emotion),
  };
}

function contentResultOf(
  request: SemanticRequest,
  scored: { ranked: SemanticScore[]; margin: number; windows?: SemanticContentResult["windows"] } | undefined,
): SemanticContentResult {
  if (request.expectedPrompt === undefined || !scored) {
    return {
      requested: request.expectedPrompt !== undefined,
      status: "unverified",
      reason:
        request.expectedPrompt === undefined
          ? "content_comparison_not_requested"
          : "semantic_run_failed",
      ranked: [],
      calibrationId: CALIBRATION_ID,
    };
  }
  const winner = scored.ranked[0];
  const mismatch = winner !== undefined && winner.text !== request.expectedPrompt;
  return {
    requested: true,
    // No threshold is claimed: this reports which description ranked first and by how much.
    status: mismatch ? "possible_mismatch" : "unverified",
    reason: mismatch
      ? "A supplied alternative description ranked above the expected one."
      : "The expected description ranked first; this calibration does not qualify a positive verdict, so fit stays unverified.",
    ranked: scored.ranked,
    margin: scored.margin,
    ...(scored.windows === undefined ? {} : { windows: scored.windows }),
    calibrationId: CALIBRATION_ID,
  };
}

function emotionResultOf(
  request: SemanticRequest,
  scored: { ranked: SemanticScore[]; margin: number; windows?: SemanticEmotionResult["windows"] } | undefined,
): SemanticEmotionResult {
  if (request.emotion === undefined) {
    return {
      status: "not_requested",
      reason: "emotion_not_requested",
      ranked: [],
      calibrationId: CALIBRATION_ID,
      moodTemplateVersion: MOOD_TEMPLATE_VERSION,
    };
  }
  if (!scored) {
    return {
      status: "unverified",
      requestedMood: request.emotion.targetMood,
      reason: "semantic_run_failed",
      ranked: [],
      calibrationId: CALIBRATION_ID,
      moodTemplateVersion: MOOD_TEMPLATE_VERSION,
    };
  }
  const target = moodHypothesis(request.emotion.sourceDescription, request.emotion.targetMood);
  const winner = scored.ranked[0];
  const mismatch = winner !== undefined && winner.text !== target;
  return {
    // Until the held-out emotion gate in AC-9 qualifies a domain, a mood agreement stays unverified.
    status: mismatch ? "possible_mismatch" : "unverified",
    requestedMood: request.emotion.targetMood,
    reason: mismatch
      ? "An alternative mood hypothesis ranked above the requested one."
      : "This CLAP use is a proposed heuristic and is not a qualified emotion recogniser, so mood stays unverified.",
    ranked: scored.ranked,
    margin: scored.margin,
    ...(scored.windows === undefined ? {} : { windows: scored.windows }),
    calibrationId: CALIBRATION_ID,
    moodTemplateVersion: MOOD_TEMPLATE_VERSION,
  };
}
