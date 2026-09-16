#!/usr/bin/env python3
"""Optional local CLAP adapter for `audio_inspect_asset`.

Reads one JSON job on stdin and writes one JSON result on stdout. It reports cosine similarities
between the audio and a set of supplied text hypotheses, and nothing else: no threshold, no
probability, no quality grade. Ranking is evidence a human can weigh, not a verdict.

This file is NOT imported by the npm package at runtime and adds no dependency to `npm install`.
Provision it explicitly:

    python3 -m venv ~/.venvs/clap
    ~/.venvs/clap/bin/pip install "laion-clap==1.1.6" "torch==2.4.1" "torchaudio==2.4.1" \
        "librosa==0.10.2.post1" "numpy<2"
    # Fetch 630k-audioset-best.pt from the LAION-AI/CLAP release page and verify its checksum.
    export AUDIO_CLAP_CHECKPOINT=/path/to/630k-audioset-best.pt
    export AUDIO_CLAP_PYTHON=~/.venvs/clap/bin/python

Check the code licence (CC0-1.0) and the checkpoint's own terms before redistributing either.

`--probe` exits 0 only when the model could actually be loaded, so generation preflight can refuse
a requested semantic check before spending money rather than after.
"""

from __future__ import annotations

import json
import os
import sys
from typing import NoReturn

# The published checkpoint this adapter is pinned to. A different file is a different calibration.
CHECKPOINT_SHA256 = os.environ.get("AUDIO_CLAP_CHECKPOINT_SHA256", "")
TARGET_SAMPLE_RATE = 48_000
# Whole-input coverage: a ten-second look at a forty-second bed is not an answer about the bed.
WINDOW_SECONDS = 10.0
WINDOW_HOP_SECONDS = 5.0


def fail(message: str, code: int = 1) -> NoReturn:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)


def load_model():
    try:
        import laion_clap  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001 - any import failure means "not provisioned"
        fail(f"laion_clap is not importable: {error}", 69)

    checkpoint = os.environ.get("AUDIO_CLAP_CHECKPOINT", "")
    if not checkpoint or not os.path.isfile(checkpoint):
        fail("AUDIO_CLAP_CHECKPOINT does not point at a readable checkpoint file.", 69)

    if CHECKPOINT_SHA256:
        import hashlib

        digest = hashlib.sha256()
        with open(checkpoint, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != CHECKPOINT_SHA256:
            fail("The CLAP checkpoint does not match AUDIO_CLAP_CHECKPOINT_SHA256.", 69)

    model = laion_clap.CLAP_Module(enable_fusion=False)
    model.load_ckpt(checkpoint)
    return model


def windows(samples, sample_rate: int):
    """Bounded windows covering the whole input, so a mood that changes cannot average away."""
    import numpy as np

    length = len(samples)
    size = int(WINDOW_SECONDS * sample_rate)
    hop = int(WINDOW_HOP_SECONDS * sample_rate)
    if length <= size:
        return [(0.0, length / sample_rate, samples)]
    out = []
    start = 0
    while start < length:
        chunk = samples[start : start + size]
        if len(chunk) < sample_rate // 2 and out:
            break
        if len(chunk) < size:
            chunk = np.pad(chunk, (0, size - len(chunk)))
        out.append((start / sample_rate, min(start + size, length) / sample_rate, chunk))
        start += hop
    return out


def rank(model, audio_chunks, texts):
    """Cosine similarity of every text against every window, plus the whole-clip aggregate."""
    import numpy as np

    text_embed = model.get_text_embedding(texts, use_tensor=False)
    text_embed = text_embed / np.linalg.norm(text_embed, axis=1, keepdims=True)

    per_window = []
    accumulated = np.zeros(len(texts))
    for start, end, chunk in audio_chunks:
        audio_embed = model.get_audio_embedding_from_data(
            x=chunk.reshape(1, -1), use_tensor=False
        )
        audio_embed = audio_embed / np.linalg.norm(audio_embed, axis=1, keepdims=True)
        scores = (text_embed @ audio_embed[0]).astype(float)
        accumulated += scores
        per_window.append(
            {
                "startSeconds": round(start, 3),
                "endSeconds": round(end, 3),
                "ranked": ranked_list(texts, scores),
            }
        )

    mean = accumulated / max(len(audio_chunks), 1)
    ordered = ranked_list(texts, mean)
    margin = (ordered[0]["score"] - ordered[1]["score"]) if len(ordered) > 1 else 0.0
    return {"ranked": ordered, "margin": round(margin, 6), "windows": per_window}


def ranked_list(texts, scores):
    pairs = [{"text": text, "score": round(float(score), 6)} for text, score in zip(texts, scores)]
    pairs.sort(key=lambda pair: pair["score"], reverse=True)
    return pairs


def main() -> None:
    if "--probe" in sys.argv:
        load_model()
        print(json.dumps({"ok": True}))
        return

    try:
        job = json.loads(sys.stdin.read())
    except Exception as error:  # noqa: BLE001
        fail(f"the job on stdin was not valid JSON: {error}")

    audio_path = job.get("audioPath")
    if not audio_path or not os.path.isfile(audio_path):
        fail("audioPath does not exist.")

    model = load_model()

    import librosa

    # A separate analysis copy at the model's rate. The seam check upstream deliberately runs at the
    # file's native rate instead, because resampling damages exactly the samples it looks at.
    samples, _ = librosa.load(audio_path, sr=TARGET_SAMPLE_RATE, mono=True)
    chunks = windows(samples, TARGET_SAMPLE_RATE)

    result = {}
    content = job.get("content")
    if content:
        texts = [content["expected"], *content.get("alternatives", [])]
        result["content"] = rank(model, chunks, texts)

    emotion = job.get("emotion")
    if emotion:
        # Identical sentences apart from the mood clause, so this cannot be won by recognising
        # the sound rather than its mood.
        texts = [emotion["target"], *emotion.get("alternatives", [])]
        result["emotion"] = rank(model, chunks, texts)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
