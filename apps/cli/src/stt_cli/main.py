#!/usr/bin/env python3
"""Thin CLI wrapper around stt_core. Same flags/defaults/output as the original
transcribe.py — it just delegates the pipeline to the shared core library.

Usage:
    source env.sh
    transcribe <audio-or-video-file> [--model small] [--no-diarize] ...
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from stt_core import MissingTokenError, TranscribeOptions, transcribe
from stt_core import emit
from stt_core.progress import ProgressEvent


def log(msg: str) -> None:
    print(f"[transcribe] {msg}", flush=True)


def _make_progress():
    """A progress callback that drives a tqdm bar for the transcribe stage and
    logs a line at each stage boundary (mirrors the old CLI feel)."""
    try:
        from tqdm import tqdm
    except Exception:  # pragma: no cover
        tqdm = None

    state = {"bar": None, "stage": None}

    def cb(e: ProgressEvent) -> None:
        if e.stage != state["stage"]:
            state["stage"] = e.stage
            if e.stage != "transcribe":
                log(f"[{e.stage}] {e.message or ''}".rstrip())
        if e.stage == "transcribe" and tqdm is not None:
            if state["bar"] is None:
                state["bar"] = tqdm(total=100, desc="Transcribing", unit="%",
                                    bar_format="{l_bar}{bar}| {n:.0f}% [{elapsed}<{remaining}]")
            if e.percent is not None:
                state["bar"].n = e.percent
                state["bar"].refresh()
        if e.stage == "done" and state["bar"] is not None:
            state["bar"].n = 100
            state["bar"].refresh()
            state["bar"].close()
            state["bar"] = None

    return cb


def main() -> int:
    ap = argparse.ArgumentParser(description="Speech-to-text + speaker diarization (WhisperX)")
    ap.add_argument("audio", help="Path to an audio or video file (wav/mp3/m4a/mp4/mov/...)")
    ap.add_argument("--model", default="large-v3", help="Whisper model (default: large-v3)")
    ap.add_argument("--language", default="tr",
                    help="Language code (e.g. tr, en). Default: tr. Pass 'auto' to auto-detect.")
    ap.add_argument("--min-speakers", type=int, default=None, help="Minimum number of speakers")
    ap.add_argument("--max-speakers", type=int, default=2,
                    help="Max speakers (default: 2 = doctor+patient; raise for a caregiver/interpreter)")
    ap.add_argument("--device", default="cpu", help="cpu (default on Mac; MPS unsupported by CTranslate2)")
    ap.add_argument("--compute-type", default="int8", help="int8 (CPU) / float16 / float32")
    ap.add_argument("--batch-size", type=int, default=8, help="Transcription batch size")
    ap.add_argument("--no-diarize", action="store_true", help="Skip diarization (transcript only)")
    ap.add_argument("--no-enhance", action="store_true", help="Disable default audio leveling")
    ap.add_argument("--vad-onset", type=float, default=0.35, help="Voice-activity sensitivity (default 0.35)")
    ap.add_argument("--diar-model", default="pyannote/speaker-diarization-3.1",
                    help="pyannote meta-model to try first (falls back to a component pipeline)")
    ap.add_argument("--out-dir", default=None, help="Output directory (default: ./out)")
    args = ap.parse_args()

    audio_path = Path(args.audio).expanduser()
    if not audio_path.is_file():
        log(f"ERROR: audio file not found: {audio_path}")
        return 2

    # Output dir: ./out under the current working dir by default (matches old CLI).
    out_dir = Path(args.out_dir) if args.out_dir else Path.cwd() / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    opts = TranscribeOptions(
        model=args.model, language=args.language, device=args.device,
        compute_type=args.compute_type, batch_size=args.batch_size,
        enhance=not args.no_enhance, vad_onset=args.vad_onset,
        diarize=not args.no_diarize, min_speakers=args.min_speakers,
        max_speakers=args.max_speakers, diar_model=args.diar_model,
        hf_token=os.environ.get("HF_TOKEN"),
    )

    lang_display = args.language or "auto-detect"
    log(f"Device={opts.device}  model={opts.model}  compute_type={opts.compute_type}  lang={lang_display}")

    try:
        result = transcribe(audio_path, opts, progress=_make_progress(), out_dir=out_dir, log=log)
    except MissingTokenError:
        log("ERROR: HF_TOKEN not set but diarization requested.")
        log("       Run `source env.sh` first, or pass --no-diarize.")
        return 2

    # Emit: print each transcript line AND write <stem>.txt in one pass (REQ-071),
    # then write .srt / .json.
    print()
    log(f"Done. {len(result.turns)} turns, {result.num_speakers} speaker(s), language: {result.language}.")
    txt_path = out_dir / f"{audio_path.stem}.txt"
    with txt_path.open("w", encoding="utf-8") as f:
        for line in emit.transcript_lines(result):
            print(line, flush=True)
            f.write(line + "\n")
            f.flush()
    srt_path = emit.write_srt(result, out_dir)
    json_path = emit.write_json(result, out_dir)

    log(f"Transcript saved to: {txt_path}")
    log(f"Also wrote: {srt_path}")
    log(f"           {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
