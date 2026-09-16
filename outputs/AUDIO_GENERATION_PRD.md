# PRD-AUDIO-001 — Generate and inspect audio through Asset MCP

**Status:** IN PROGRESS — Phases 1 and 2 complete; Phase 3 partially complete
**Complexity:** 5 → MEDIUM; risk override: none (existing local MCP trust boundary)
**Owner:** Asset MCP maintainer
**Depends on:** None for planning; implementation prerequisites below
**Research date:** 2026-09-16
**Progress:** Phases 1-2 complete and verified; Phase 3 shipped except the two model-dependent calibrations. AC-1-5 and AC-7 pass; AC-6, AC-8 and AC-9 remain open on unmet prerequisites.

## Context

Agents can discover and download audio packs through Asset MCP, but cannot generate a missing sound or ask this MCP whether a candidate contains obvious defects. Add two tools: `audio_generate_sound` and independently callable `audio_inspect_asset`. Generation automatically runs the same inspection implementation.

User-confirmed scope is **sound effects and ambience**, including loops and checking their perceived emotional tone. Spoken dialogue, voice cloning, full music generation, runtime synthesis, automatic mixing/mastering, provider abstraction layers, and an audio editor are out of scope. The inspection tool can examine existing local audio independently of ElevenLabs, but its prompt-fit and emotion calibration covers SFX/ambience, not speech intelligibility or musical quality.

This request authorizes **only this PRD**: no implementation, skill installation, paid requests, asset generation, release, or game changes. Complexity scores the future implementation: approximately 6–10 implementation files (+2), new generation/inspection module (+2), external API (+1). Existing package consumption does not require an engine release or a new trust boundary.

### Existing implementation and ownership

| Surface | Observed behavior and decision |
| --- | --- |
| [MCP registration](../src/server.ts) (`audio_list_sources` at line 613; `audio_download_asset` at 647) | Extend the existing server and injected clients. Preserve the three catalog tools and their schemas. |
| [Audio handlers](../src/tools/audio.ts), [catalog client](../src/audio/client.ts) | Reuse Zod validation, structured MCP results, sanitized errors, hashes, dedicated directories, exclusive writes and no-overwrite publication. Catalog download URLs remain curated; generated assets use a separate result type. |
| [Existing inspector CLI](../../threenative-engine/packages/playtest/src/runner/cli.ts) (line 263), [audio runner](../../threenative-engine/packages/playtest/src/runner/audioRun.ts) | `threenative-playtest audio` already decodes files with FFmpeg, measures audio, emits JSON and spectrograms, and distinguishes bad audio from an unavailable decoder. Wrap its public CLI; do not copy its DSP. |
| [Audio measurements](../../threenative-engine/packages/playtest/src/runner/audio.ts), [asset conditioning](../../threenative-engine/packages/assets/src/passes/audio.ts) | Existing silence, peak, DC, band and relative loop-seam measurements. The compiler accepts WAV/Ogg Vorbis, rejects MP3, and can condition audio separately. Inspection must not silently repair it. |
| [Package scripts](../package.json), [stdio tests](../tests/mcp-smoke.test.ts), [catalog tests](../tests/audio.integration.test.ts) | Node 20+, TypeScript, native `fetch`, Zod and Vitest already exist. Use these; no ElevenLabs SDK is necessary for one endpoint. |

Capability discovery ran `engine_search_capabilities` for generation and inspection, then `engine_capability_detail` for `audioPass` and `compileAssets`. Those are build-time mechanisms, not an ElevenLabs generation API. Source inspection additionally found the existing audio CLI. Its package binary is present in the installed Midway dependency. The exact distributable version to pin remains a Phase 1 check. `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` are present; no credential values or account access were inspected.

Asset MCP owns provider calls, persistence, inspection orchestration and agent-facing results. The existing engine packages retain DSP and conditioning ownership. No new game runtime mechanism is proposed, so this PRD does not claim desktop, Android or iOS playback qualification.

## Solution

### Consumer flow

1. The agent describes one sound, its duration and whether it loops, then invokes `audio_generate_sound` once.
2. The tool validates prerequisites, reserves a request ID, calls ElevenLabs, and saves the original response plus a playable WAV in its own directory.
3. The same inspector used by `audio_inspect_asset` checks the saved WAV and returns measurements, findings, a spectrogram, prompt-fit status and a separate emotion-fit result when requested.
4. The agent uses the findings to accept the technical result, revise the prompt, or request listening review. Another generation is a separate, billable invocation.
5. The selected WAV enters the game's existing asset compilation path. If compilation changes the bytes, inspect the compiled output before describing that output as checked.

### ElevenLabs contract, checked 2026-09-16

Use `POST https://api.elevenlabs.io/v1/sound-generation`, authenticate with server-side `ELEVENLABS_API_KEY` in `xi-api-key`, send JSON, and consume the binary response. Never put credentials in tool inputs or game assets. [API reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).

| Tool field | HTTP mapping and behavior |
| --- | --- |
| `prompt` | Required nonblank string, locally capped at 2,000 characters; maps to `text`. This cap is our policy, not a claimed provider maximum. |
| `durationSeconds` | Default 5; 0.5–30 inclusive; maps to `duration_seconds`. Explicit duration keeps one invocation bounded. |
| `loop` | Default `false`; maps unchanged. Explicitly send `model_id: "eleven_text_to_sound_v2"`. |
| `promptInfluence` | Default 0.3, inclusive range 0–1; maps to `prompt_influence`. |
| Output | Fix `output_format=mp3_44100_128` for v1. Preserve the MP3 and decode to PCM16 WAV without resampling, channel changes, normalization, trimming or fades. |

The API reference documents a 0.5-second minimum; the overview currently says 0.1. **Use the endpoint contract's 0.5 minimum.** MP3 is the common supported output, while other formats have model/loop/plan restrictions. Do not claim that converting MP3 to WAV restores lost fidelity. Billing metadata may include the `character-cost` response header; preserve it as provider-reported units, not a dollar amount. [API reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert), [capability overview](https://elevenlabs.io/docs/overview/capabilities/sound-effects).

### Skill worth absorbing

Use ElevenLabs' own [sound-effects skill](https://github.com/elevenlabs/skills/blob/9edcbd4b80ed57b8e07a3f86ea520333969fbc3c/sound-effects/SKILL.md), reviewed at commit `9edcbd4b80ed57b8e07a3f86ea520333969fbc3c`. It declares MIT licensing, matches the current v2 parameters, and covers concrete prompts, loops and prompt influence. Absorb those practices into this MCP's README recipe and tool descriptions; link and attribute the source rather than install an entire plugin. If text/code is copied, preserve its MIT notice.

Useful example brief: “One short metal latch closing, close microphone, dry recording, single event with natural decay, no speech or music.” Describe source, action, material, distance and timing. These are prompting conventions, not guaranteed exclusion controls. The skill's examples are insufficient for production persistence, cancellation, billing safety or quality evaluation; the contracts below supply those. No skill is installed during planning.

### Tool 1: `audio_generate_sound`

Input adds a required UUID `requestId` to the fields above. An optional `inspection` object carries the same explicit expectations, `semantic` option, `alternativePrompts` and `emotion` object as Tool 2; generation supplies `loop`, requested duration, and `expectedPrompt` from its own input. Conflicting duplicate expectations fail validation before a provider call. Desired emotional tone is expressed in the actual ElevenLabs text prompt; `inspection.emotion` checks the result and is not an undocumented provider emotion parameter.

Return `requestId`, provider/model, normalized request, generation timestamp, original and WAV paths/hashes/byte counts, measured duration/sample rate/channels, provider request ID when supplied, billing units when supplied, provenance path, and the complete inspection result. Distinguish `generation: "saved"` from inspection quality: a saved candidate with defects remains inspectable and is not presented as approved.

Store under `<AUDIO_DOWNLOAD_DIR>/generated/<requestId>/`, using the existing audio directory default. Keep a single machine-consumed receipt containing request state, provenance and the latest inspection reference; do not create a second evidence ledger. Source MP3 and WAV are immutable. Return a recoverable saved path if inspection fails after generation; never charge again to repeat local inspection.

Billing and failure behavior:

1. Check key presence, writable destination, FFmpeg, the pinned inspector, and any explicitly requested semantic model **before** making a paid request. Missing generation credentials must not prevent catalog tools or local inspection from starting.
2. Reserve the request directory exclusively and persist the normalized request hash and `submitted` state before the POST. Same ID plus different options is a conflict; a completed identical request returns its saved, hash-verified result without another POST. Concurrent duplicates cannot both submit. Persist `source_saved` only after durable original bytes/hash, and `wav_saved` only after durable WAV bytes/hash; `complete` records a finished inspection, including a rejected candidate. Identical replays resume unfinished **local** conversion/inspection from those verified bytes. A saved-file hash mismatch fails without resubmission. Test failures between every persistence boundary.
3. Make at most one POST per invocation; no automatic retry or regeneration. An interrupted/ambiguous submission remains `outcome_unknown`, including after restart. Repeating that ID never resubmits; an intentional new attempt needs a new ID. Do not claim provider-side idempotency.
4. Use a 120-second generation deadline, 32 MiB response cap, bounded stderr/output, stream cancellation and exclusive final publication. Disallow redirects of authenticated requests. Return sanitized authentication, quota/rate-limit, invalid-input, upstream, timeout and storage errors without headers, keys or raw provider bodies.
5. Record provider terms URL and `commercialUse: "unverified"` unless generation-time entitlement is established. Never inherit a CC0 label from the catalog. Free and paid plans have different publication rights; current terms, plan and feature status govern use. [ElevenLabs publication guidance](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform).

The generation tool advertises that it spends provider credits and writes files. Set MCP annotations consistently with those effects; a fresh invocation is not advertised as idempotent merely because explicit request-ID replays are protected. Do not log prompts by default. This plan does not authorize a live paid call.

### Tool 2: `audio_inspect_asset`

Input: `path`, required `loop`, optional `expectedDurationSeconds`, `expectedPrompt`, `alternativePrompts`, `emotion`, `bands`, `peakMax`, `silenceRms`, `seamMaxRatio`, and `semantic: "off" | "clap"` (default `off`). Use the existing inspector's band names and bounds (`min`/`max` percentages); reject unknown keys. With `semantic: "clap"`, require a content comparison, an emotion comparison, or both. A content comparison requires a nonblank `expectedPrompt` and `alternativePrompts` containing 1–5 distinct, nonblank strings, each at most 2,000 characters and different from the expected prompt. These are concrete alternative sound descriptions, not instructions to the evaluator. An emotion-only request uses the object below and leaves `promptFit` unverified with reason `content_comparison_not_requested`; a generation-supplied prompt alone does not enable content comparison. Never derive spectral limits from the filename or guess that bass/noise is inherently bad.

The input is a regular local WAV, Ogg Vorbis, MP3 or FLAC file within the canonical audio download root or configured `AUDIO_INSPECT_ROOTS` (default additionally includes the MCP launch directory). Resolve containment, reject escaping symlinks and playlists, and inspect an immutable snapshot so the returned hash identifies the measured bytes. No arbitrary URL fetching or cloud upload. Restrict decoder protocols, bound probe/decode output, accept at most 64 MiB, 60 seconds, two channels and 96 kHz, and terminate child processes on cancellation. These are v1 limits, reported explicitly.

Create a one-clip expectation manifest and invoke the pinned package's declared binary using `process.execPath` and argument arrays, never a shell or an auto-installing `npx`:

```sh
node <resolved-package-bin> audio --root <private-input-directory> \
  --expect <expectations.json> --out <private-inspection-directory>
```

Consume its structured JSON, not formatted prose. Exit 1 means a completed inspection found defects; exit 69 means the decoder was unavailable; usage/run errors or invalid/missing JSON mean inspection was not completed. Never turn a missing decoder into a pass. Generate the PNG through the existing inspector; an image is supporting evidence, not the verdict. Reuse `@threenative/playtest` as an exact pinned dependency whose packed binary is tested; no internal module imports or sibling-checkout runtime paths.

Return `inputSha256`, analysis/tool versions, measured properties, effective expectations, individual findings with severity/reason/remedy, spectrogram path, `technicalStatus: "pass" | "warn" | "fail" | "unverified"`, `promptFit: "consistent" | "possible_mismatch" | "unverified"`, the separate `emotionFit` object below, and `artisticQuality: "unverified"`. Persist/cache under the hash of input bytes, expectations (including emotion descriptions) and analyzer/model/calibration versions; changed bytes or expectations cannot reuse an old result. Source hash must remain unchanged. The tool writes inspection artifacts, so its MCP annotation must not claim it is wholly read-only.

### What “does it suck?” can actually mean

| Question | V1 measurement and verdict |
| --- | --- |
| Is it broken or silent? | Decode integrity, finite samples and nonzero duration; existing RMS silence default `1e-4` (−80 dBFS). Corrupt/nonfinite input fails. Silence fails the declared floor; deliberately quiet audio can name a different floor, which is echoed. |
| Is it excessively hot, offset or unexpectedly quiet? | Reuse inspector peak ceiling 0.98, DC warning above 0.01 and quiet-peak warning below 0.1. A ceiling violation is a peak violation/possible clipping, **not proof** of distortion. No universal LUFS target or automatic loudness normalization. |
| Does it click when repeated, or have the wrong duration? | Existing seam ratio: boundary sample step relative to the 99th-percentile step within 50 ms of the ends; default maximum 1.5. Enforce only for declared loops. Requested duration tolerance is `max(0.10 seconds, 2%)`; report a mismatch, never silently trim. |
| Is its frequency content wrong for the requested purpose? | Existing five-band profile and explicit bounds; spectrogram reveals transients, hum or unexpected bandwidth. Broadband rain and tonal alarms are valid. Bounds come from the caller; spectral flatness alone is never a quality grade. |
| Is it the wrong sound, despite technically valid audio? | Opt-in local CLAP compares the expected description against supplied alternatives. Report cosine scores, rank and margin as diagnostic evidence; never describe them as a quality probability. Subjective realism, annoying repetition and mix fit still need listening review. |

Do not emit a single “quality 87/100” score or `soundsGood: true`. Definite technical failures yield `recommendation: "reject"`; warnings, a possible content/emotion mismatch, or incomplete requested checks yield `"review"`; technical passes with supporting evidence from all requested semantic checks yield `"audition"`. Technical-only inspection recommends audition without claiming content or emotional suitability. An unrequested check does not count as a failed/incomplete requested check. Even an audition recommendation does not certify artistic quality.

The relative seam check runs on the saved file at its **native sample rate**: resampling creates edge artifacts that can reverse the result. Keep CLAP's required resampling in a separate analysis copy. The existing build pass already pins parity with the inspector, so do not add an independent seam algorithm.

### Semantic check: one optional local model, bounded claims

[LAION CLAP](https://github.com/LAION-AI/CLAP) provides aligned text/audio embeddings suitable for similarity comparisons. Use its published `630k-audioset-best.pt` checkpoint through a small Python adapter, pinned package versions and checkpoint checksum. Model provisioning is explicit and outside normal inspection calls; no implicit downloads, GPU requirement or hosted service. Check code and weight licensing separately before packaging instructions.

Analyze a separate mono 48 kHz copy using the model's supported preprocessing. For long sounds, cover the entire input with bounded windows rather than scoring only its first ten seconds; report window scores as well as the aggregate. A distractor ranking above the intended sound flags `possible_mismatch`. A winning prompt is only supporting evidence; if margins are inconclusive under the calibrated policy, return `unverified`. No universal cosine threshold is claimed.

Build the adapter as opt-in functionality: no PyTorch dependency in the normal npm install. `semantic: "clap"` with a missing model returns technical results plus an explicit unavailable semantic result and setup instruction, never a semantic pass. Generation preflight rejects that missing requested prerequisite before spending. A 60-second semantic deadline bounds CPU inference; timeouts keep prompt fit unverified.

Calibrate with ten tuning clips, then a disjoint twenty-clip licensed/attributed holdout spanning impacts/foley, tonal cues, mechanical sounds and ambience. Freeze model, preprocessing, prompts and thresholds before holdout scoring. Require intended descriptions to outrank concrete wrong alternatives for at least 16/20 clips; disclose the full per-clip result, not just the average. A semantically wrong but technically clean clip must exercise the mismatch path. This is a small relevance benchmark, not evidence of universal audio quality detection. Record scores in the PRD's acceptance evidence; keep fixtures/configuration only where tests consume them.

Do **not** use [DNSMOS](https://github.com/microsoft/DNS-Challenge/tree/master/DNSMOS) as a general SFX judge: it evaluates speech/noise-suppression quality. Do not use dataset-level [Fréchet audio distance](https://arxiv.org/abs/1812.08466) to accept a single sound. Spectrograms and embedding similarity answer different questions; neither replaces ears.

### Emotion check: does the sound convey the intended mood?

Assess **perceived emotional tone of SFX/ambience**, not a person's feelings. Valence describes pleasant versus unpleasant; arousal describes calm versus activating. A tense alarm can be correct, and a pleasant sound can still be wrong for a horror scene. Environmental-sound research finds that source meaning and context affect emotional response, so a spectrogram or volume threshold is insufficient. [Emoacoustics study](https://www.isca-archive.org/pqs_2010/asutay10_pqs.html).

Add an optional `emotion` object to `audio_inspect_asset` and generation's `inspection` object:

```json
{
  "semantic": "clap",
  "emotion": {
    "sourceDescription": "ocean waves washing onto a beach",
    "targetMood": "calm and reassuring",
    "alternativeMoods": ["tense and threatening", "emotionally neutral"]
  }
}
```

All strings are trimmed/nonblank; cap `sourceDescription` at 500 characters, mood descriptions at 200, and alternatives at 1–5 distinct values excluding the target. Require `semantic: "clap"` when `emotion` is supplied. The source description identifies the audible source/action without an emotional adjective; the caller supplies it rather than an LLM silently rewriting the target.

Reuse the same CLAP audio embeddings and CPU deadline. Build otherwise identical hypotheses using one versioned template, `The sound of {sourceDescription}, with a {mood} emotional tone.`, changing only the mood clause. This prevents “ocean versus explosion” recognition from being presented as a successful “calm versus tense” check. **This use of CLAP is a proposed heuristic, not a demonstrated emotion-recognition capability.** Its mood status stays unverified until the separate calibration below qualifies the requested domain; source-recognition accuracy does not qualify emotion accuracy.

Return `emotionFit` with `status: "not_requested" | "consistent" | "possible_mismatch" | "unverified"`, requested mood, ranked mood similarities, target-versus-best-alternative margin, time-window results, reason and calibration ID. Scores are embedding similarities, not probabilities, clinical assessments or measured valence/arousal values. Close margins, unsupported mood/domain, conflicting time windows, missing model or timeout yield `unverified`. A clear alternative win yields `possible_mismatch` and review, without changing technical status or spending another generation call. Check all windows using the existing preprocessing; a cheerful ending must not disappear into a calm whole-clip average.

Validate mood separately from sound identity: use licensed clips with independent listener annotations, with [Emo-Soundscapes](https://www.metacreation.net/projects/emo-soundscapes) as a candidate for ambience valence/arousal labels. Verify per-clip use/redistribution terms before including fixtures. Do not invent labels from filenames, generation prompts or the same evaluator. Extend the existing tuning corpus where annotations exist, then freeze an emotion policy and test twelve held-out comparisons with the source description held constant across mood hypotheses: six annotated matches and six mismatches. Require correct, non-abstaining decisions on at least five of each six; report every result and abstention. Add ambiguous and changing-mood controls that must not return blanket `consistent`. Human annotation disagreement is retained as uncertainty, not discarded to inflate accuracy. Qualification covers only the moods and audio domains represented; novel one-shot effects remain unverified until covered. If this gate fails, AC-9 stays open; do not relabel a fallback-only implementation as verified emotion checking.

Do not add a speech-emotion model to solve this SFX requirement. The inspected [audEERING wav2vec2 model card](https://huggingface.co/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim) describes speech training and a research-only/CC-BY-NC-SA release, so it is neither a validated environmental-sound evaluator nor a default commercial dependency. No additional model service or third MCP tool is needed for this first experiment.

### Installation and rollout

Add the two tools without replacing existing catalog calls. Extend README setup with `ELEVENLABS_API_KEY`, existing `AUDIO_DOWNLOAD_DIR`, optional `AUDIO_INSPECT_ROOTS`, FFmpeg prerequisites, the pinned inspector and optional local CLAP setup. Skills/tool descriptions must teach “generate once → inspect → revise the specific failed property → explicitly generate again”; no unbounded best-of-N loop.

Existing catalogs continue to work without ElevenLabs, FFmpeg or CLAP. Local inspection needs no ElevenLabs key. Package verification must prove the documented workflow works from installed bytes rather than this developer's sibling engine checkout. If no distributable inspector version contains the audio command, record a concrete prerequisite; do not copy its source into Asset MCP or silently expand this PRD into an engine release.

## Acceptance Criteria

- [x] AC-1 [local; actor: implementing agent]: PASSES. `tools/list` exposes `audio_inspect_asset` and `audio_generate_sound` beside the three catalog tools (`tests/mcp-smoke.test.ts`, exact-list assertion). A controlled provider response produces a hash-verified WAV plus a real inspection, and the catalog tools still work with no credentials. Evidence: E1 (`tests/audio-generation.test.ts`, 16 tests).
- [x] AC-2 [local; actor: implementing agent]: PASSES. Replayed and concurrent submissions of one request ID make exactly one POST; an ambiguous submission becomes `outcome_unknown` and is never resubmitted, across a restart; a deleted WAV resumes locally from the verified source with no further POST. Evidence: E1.
- [x] AC-3 [local; actor: implementing agent]: PASSES. Invalid parameters, path escapes (including an escaping symlink), a playlist, an oversized response, an unknown expectation key and a missing decoder all fail safely. The API key never appears in the URL, body, result or error; a raw provider body is replaced by a category. Successful audio bytes are preserved byte-identical. Evidence: E1/E2.
- [x] AC-4 [local; actor: implementing agent]: PASSES. Corrupt, silent, over-peak, bad-seam, wrong-duration and out-of-band fixtures each yield `technicalStatus: "fail"` and `recommendation: "reject"`, through MCP dispatch and the real inspector process. Source bytes and mtime are unchanged and `inputSha256` matches the measured bytes. Evidence: E2 (`tests/audio-inspection.test.ts`, 27 tests).
- [x] AC-5 [local; actor: implementing agent]: PASSES. A correctly levelled seamless loop passes with zero findings; quiet audio passes against its own declared floor; a duration inside tolerance raises nothing; FLAC reads. A stubbed exit-69 inspector yields `unverified`, never `pass`; a crashed inspector and an empty check list raise rather than return a verdict; changed bytes and changed expectations both retire the cache. Evidence: E2.
- [ ] AC-6 [local; actor: implementing agent with provisioned CLAP]: The frozen opt-in model meets the 16/20 held-out relevance target and exposes the technically clean wrong-sound case; reported scores remain separate from technical and artistic status. Evidence: E3, pending.
- [x] AC-7 [local; actor: implementing agent]: PASSES. A packed tarball installed into a fresh consumer resolves `@threenative/playtest@0.3.2`'s binary from the consumer's own `node_modules`, emits a readable 646x513 PNG, and inspects a 30-second stereo 44.1 kHz fixture in **769 ms** against the 30-second budget. `scripts/audio-semantic.py` ships in `files`. Evidence: E4.
- [ ] AC-8 [local; actor: implementing agent after explicit live-call authorization]: One real short effect and one real loop traverse MCP → ElevenLabs → saved WAV → inspection, returning observed billing/provenance and honest statuses. Confirm both decode and that independent inspection reproduces the generation tool's technical findings on those exact bytes. Evidence: E5, pending.
- [ ] AC-9 [local; actor: implementing agent with provisioned CLAP and licensed listener-annotated fixtures]: Emotion inspection meets the separate five-of-six match and five-of-six mismatch targets with source identity held constant; ambiguous, changing-mood and unsupported cases remain unverified. The actual MCP result separates emotion, content, technical and artistic status, and changing only the requested mood invalidates the cached judgment. Evidence: E3 emotion subset, pending.

AC-6, AC-8 and AC-9 remain open, each on a prerequisite this environment does not have:

- **AC-6** (CLAP relevance, 16/20 holdout) and **AC-9** (emotion, 5/6 and 5/6): the adapter, the
  frozen mood template, the cache-invalidating inputs and the honest unavailable/timeout paths are
  implemented and tested, but no CLAP checkpoint is provisioned here and no licensed,
  listener-annotated fixture corpus was supplied. `CALIBRATION_ID` is therefore
  `clap-630k-audioset-best/v1-uncalibrated`, and a mood agreement deliberately still returns
  `unverified` rather than `consistent`. Nothing is relabelled as verified.
- **AC-8** (two live billed generations): no live-call authorization was given and no key was
  present. Mocked HTTP cannot substitute, so this stays open by design.

Everything else described below still holds. Live credentials, funded API access, distribution entitlement and CLAP provisioning are **unverified**, not assumed absent or satisfied. AC-8 stays open until an authorized live environment exists; mocked HTTP cannot substitute. Audition establishes each asset's artistic suitability separately from whether these tools work. If an agent cannot hear audio, it leaves artistic quality unverified rather than inferring it from the spectrogram; there is no human artistic-approval gate for shipping this tool feature.

## Integration Ledger

| Capability | Reachable consumer and incumbent entry point | Disposition | Evidence |
| --- | --- | --- | --- |
| Generate | MCP `tools/call` → new registration beside `src/server.ts:647` → `src/tools/audio.ts` → new `src/audio/generate.ts` → saved source/WAV/receipt | Add one provider operation; preserve catalog client and download/license behavior. | AC-1–3 / E1; AC-8 / E5 |
| Inspect | MCP `tools/call`, or generation completion → shared `src/audio/inspect.ts` → installed `threenative-playtest audio` → JSON/PNG | Expose the existing engine inspection capability; do not duplicate `audio.ts` DSP. | AC-4–5 / E2; AC-7 / E4 |
| Prompt fit | Explicit `semantic: "clap"` → local Python adapter → frozen model/scores → inspection result | Add optional relevance evidence; never replace technical checks with model opinion. | AC-6 / E3 |
| Emotion fit | MCP `emotion` input, or generation's `inspection.emotion` → same embeddings with mood-only contrasts → separate `emotionFit` result | Reuse the semantic adapter; independently qualify mood judgments rather than infer them from content matches. | AC-9 / E3 emotion subset |

## Execution Phases

#### Phase 1: Independent technical inspection works through MCP

**Status:** COMPLETE
**ACs:** AC-3–5, AC-7
**Files:** `src/audio/inspect.ts` (new), `src/tools/audio.ts`, `src/server.ts`, package manifests; existing MCP tests plus `tests/audio-inspection.test.ts` (new).
**Implementation:** Verify/pin a packed inspector containing the existing command; implement confined snapshots, expectation translation, subprocess limits, result parsing and hash-bound artifacts. Add numeric duration validation and handle unavailable/nonfinite output explicitly. Do not edit engine DSP.
**Verification:** E2 — smallest fixture table proving the required good/bad cases through MCP dispatch and the real inspector process. E4 — install the package tarball into a temporary consumer and exercise its binary resolution, PNG and 30-second workload. Missing inspector distribution is a named prerequisite, not permission to duplicate it.
**Checkpoint:** Self-verification DONE (27 inspection tests, real inspector + real ffmpeg). The focused review of integration/path/error handling is **OPEN**: it was delegated to the save-tokens arm seven times and never scheduled — see `docs/` note below.

#### Phase 2: One billed generation produces an inspected candidate

**Status:** COMPLETE
**ACs:** AC-1–3
**Files:** `src/audio/generate.ts` (new), existing audio tool/server wiring; extend `tests/audio.integration.test.ts` and `tests/mcp-smoke.test.ts`.
**Implementation:** Native `fetch` adapter, preflight, exclusive request reservation, bounded streaming, MP3-to-WAV conversion, provenance, and automatic invocation of Phase 1 inspection. Extract an existing safe file helper only if both actual callers use it; no generic provider framework.
**Verification:** E1 — controlled HTTP at the transport boundary with production MCP handlers and real disk/decoder/inspector work. Assert decoded final bytes/hash, exact request mapping and provider POST counts; cover concurrent/replayed/ambiguous requests, interrupted conversion/inspection after successful source persistence, and saved-file hash mismatch. Mock only the provider, not persistence or inspection. Retain existing catalog regressions.
**Checkpoint:** Self-verification DONE (16 generation tests covering replay, concurrency, `outcome_unknown`, local resume, hash mismatch, key absence and leak paths). The focused billing/recovery review is **OPEN**, for the same reason.

#### Phase 3: Prompt/emotion evidence and the documented installed workflow

**Status:** PARTIAL - adapter, propagation and docs shipped; both calibrations blocked on an unprovisioned model and unsupplied licensed fixtures
**ACs:** AC-6–9
**Files:** `scripts/audio-semantic.py` and pinned optional requirements (new), inspection adapter, `README.md`, package `files` when needed, and a focused semantic fixture/test configuration.
**Implementation:** Optional local CLAP scoring; separate frozen content/emotion calibration and holdouts; propagate the `emotion` input and separate results through both tools; absorb the official skill's prompting guidance and document the generate/inspect loop. Document that source and compiled bytes require their own inspection. Leave subjective quality unverified unless someone actually listens.
**Verification:** E3 — run the actual pinned model on both held-out tasks and assert truthful missing-model/timeout behavior, mood-only cache invalidation and uncertainty on changing/ambiguous/unsupported moods. Exercise both direct inspection and generation's forwarded expectations. E5 — after explicit authorization, run exactly the two live generations in AC-8 and record provider metadata, hashes and observations once beside that criterion. Run `npm run typecheck` and `npm test` once for final integration; the existing `pretest` performs the build. **Done:** typecheck clean, and `npm test -- --exclude '**/.worktrees/**'` reports 31 files, **309 passed, 4 skipped, 0 failed**. The four skips are the other lane's `unreal-raw-mesh` and `unreal-skeletal-mesh` cases, which are gated on UE fixtures absent from this machine; no audio test is skipped. `.worktrees/` is excluded because it is another lane's dead checkout, not a suite this repository owns. Existing provider/browser tests keep their own isolation; audio checks require no browser.
**Checkpoint:** Installed workflow verified (packed tarball, fresh consumer, 769 ms for a 30 s stereo clip, readable spectrogram). Review of the finished tool contract is **OPEN**. Implementation remains open while AC-6, AC-8 and AC-9 are unverified.

## Outstanding review checkpoints

All three phase checkpoints call for one focused human-or-agent review that has **not** run. The
reviews were delegated to the `save-tokens` cheap arm (`~/.agents/skills/save-tokens/arm.sh`,
`opencode-go/deepseek-v4.1-flash`) across seven dispatches on 2026-09-16, with briefs from a full
three-part review down to a single question over a 75-line range. Every substantive brief returned
`TIMED OUT` (exit 5 — provider queueing, never exit 3 — credits), including one attempt with only a
single competing arm; a trivial brief needing no file read completed normally in the same window.
The throttling is account-level and per-token, so the arm could not be made to do this work.

These reviews are the remaining gate on the implementation, alongside AC-6, AC-8 and AC-9. Nothing
here is claimed as reviewed.

## Planning verification

Only this Markdown PRD is changed. The initial draft passed document checks and independent review after corrections to semantic-input naming, local-work recovery and error-body handling. The pinned official skill source was fetched successfully and declares MIT. The user subsequently confirmed SFX/ambience scope and requested emotion checking; this revision adds an independently calibrated emotion contract and AC-9. Revision checks passed: nine open ACs, three unstarted phases, resolved local links and valid Markdown structure. Independent delta review passed for emotion-only inputs, generation forwarding, separate results, cache invalidation and qualification limits. No implementation tests, manufactured red/green failures, secret inspection or paid API calls were performed.
