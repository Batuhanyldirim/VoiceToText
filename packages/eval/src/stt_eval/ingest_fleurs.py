"""Ingest the FLEURS Turkish test split into a local eval manifest + reference set.

FLEURS (google/fleurs, CC-BY-4.0) is READ speech (Wikipedia-style sentences read
aloud) — NOT conversational medical Turkish. It is a **public sanity floor** and a
regression detector for the pipeline, NOT a proxy for real clinical accuracy. Use
it to get a baseline `large-v3` WER/CER today and to A/B the Turkish quick wins
(force `language=tr`, decode params) before the hand-labeled clinical set exists.

WHY A SEPARATE INGEST STEP (not a runtime dependency): the HF `datasets` library
would downgrade `fsspec` in the shared `.venv` (ADR-0002 says don't casually move
shared deps), and `datasets>=5` wants `torchcodec` to *decode* audio (torch-coupled,
heavy). So this script runs in an ISOLATED ephemeral env and only ever touches the
venv-free path:

    uv run --no-project --with "datasets>=3" --with soundfile \
        python -m stt_eval.ingest_fleurs --limit 50

It fetches undecoded audio bytes (`Audio(decode=False)` — no torchcodec), writes
16 kHz mono WAVs + a reference-turns JSON + a manifest under `eval/data/fleurs-tr/`
(git-ignored; downloads cached under HF_HOME in the project per ADR-0003). After
that, scoring uses ONLY the pinned venv + jiwer:

    make eval m=eval/manifests/fleurs-tr.json c="baseline tr"

FLEURS has ONE speaker per utterance, so there is no diarization ground truth here
(cpWER/DER are not meaningful on it) — this set measures TEXT accuracy (WER/CER).
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path


def _repo_root() -> Path:
    # packages/eval/src/stt_eval/ingest_fleurs.py -> repo root is 4 parents up.
    return Path(__file__).resolve().parents[4]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="stt_eval.ingest_fleurs",
        description="Ingest FLEURS Turkish test split -> local WAVs + manifest (isolated env).")
    ap.add_argument("--limit", type=int, default=50,
                    help="max utterances to ingest (default 50; keep small — WER is stable by ~50-100)")
    ap.add_argument("--out", default="eval/data/fleurs-tr",
                    help="output dir (rel to repo root; git-ignored)")
    ap.add_argument("--manifest", default="eval/manifests/fleurs-tr.json",
                    help="manifest path to write (rel to repo root; git-ignored)")
    args = ap.parse_args(argv)

    try:
        import soundfile as sf
        from datasets import Audio, load_dataset
    except ImportError as e:
        raise SystemExit(
            "This script needs 'datasets' + 'soundfile' in an ISOLATED env. Run:\n"
            "  uv run --no-project --with \"datasets>=3\" --with soundfile "
            "python -m stt_eval.ingest_fleurs --limit 50\n"
            f"(missing: {e.name})")

    root = _repo_root()
    out_dir = (root / args.out).resolve()
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading FLEURS tr_tr test (streaming, limit {args.limit}) ...")
    ds = load_dataset("google/fleurs", "tr_tr", split="test", streaming=True)
    ds = ds.cast_column("audio", Audio(decode=False))  # raw bytes, skip torchcodec

    items = []
    n = 0
    for ex in ds:
        if n >= args.limit:
            break
        raw = ex["audio"]["bytes"]
        data, sr = sf.read(io.BytesIO(raw))
        # FLEURS is already 16 kHz mono; write a plain WAV we own.
        # NB: FLEURS `id` is the SENTENCE id and repeats across speakers who read
        # the same sentence — so it is NOT a unique key. Prefix with the running
        # index to avoid filename collisions overwriting distinct utterances
        # (which would silently mismatch audio to the wrong reference text).
        uid = f"fleurs_{n:04d}_{ex['id']}"
        wav_path = audio_dir / f"{uid}.wav"
        sf.write(wav_path, data, sr)
        # Reference: one turn, one (unlabeled) speaker — text accuracy only.
        ref = [{"speaker": "Speaker 1", "text": ex["transcription"]}]
        ref_path = out_dir / f"{uid}.ref.json"
        ref_path.write_text(json.dumps(ref, ensure_ascii=False), encoding="utf-8")
        items.append({
            "id": uid,
            "audio": str(wav_path.relative_to(root)),
            "reference": str(ref_path.relative_to(root)),
        })
        n += 1
        if n % 10 == 0:
            print(f"  ingested {n} ...")

    manifest = {
        "name": "fleurs-tr",
        "notes": (f"FLEURS Turkish test split, first {n} utterances (CC-BY-4.0). "
                  "READ speech, single speaker — a public TEXT-accuracy sanity floor, "
                  "NOT conversational-medical Turkish and NOT a diarization benchmark. "
                  "Regenerate: uv run --no-project --with 'datasets>=3' --with soundfile "
                  "python -m stt_eval.ingest_fleurs --limit N"),
        "items": items,
    }
    manifest_path = (root / args.manifest).resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {n} utterances -> {audio_dir}")
    print(f"Manifest -> {manifest_path}")
    print(f"\nNow score (pinned venv, no extra deps):\n"
          f"  make eval m={args.manifest} c=\"baseline tr\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
