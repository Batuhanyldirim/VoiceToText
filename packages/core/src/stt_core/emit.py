"""Pure output formatting/writing. No printing to stdout here — the CLI decides
how to echo. Ported from transcribe.py's fmt_ts/fmt_srt_ts and the emit block.
"""
from __future__ import annotations

import json
from pathlib import Path

from .models import TranscribeResult


def fmt_ts(seconds) -> str:
    """Seconds -> MM:SS.s for the .txt transcript."""
    if seconds is None:
        seconds = 0.0
    m, s = divmod(float(seconds), 60)
    return f"{int(m):02d}:{s:04.1f}"


def fmt_srt_ts(seconds) -> str:
    """Seconds -> HH:MM:SS,mmm for SRT."""
    if seconds is None:
        seconds = 0.0
    ms = int(round(float(seconds) * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def transcript_lines(result: TranscribeResult) -> list:
    """The exact lines of the .txt transcript (header + separators + turns).
    Returned as a list so the CLI can both print and write them in one pass."""
    lines = [
        f"# Transcript: {Path(result.audio).name}",
        f"# Language: {result.language}",
        f"# Speakers: {result.num_speakers}",
        "-" * 70,
    ]
    for t in result.turns:
        lines.append(f"[{fmt_ts(t['start'])} → {fmt_ts(t['end'])}] {t['speaker']}: {t['text']}")
    lines.append("-" * 70)
    return lines


def write_txt(result: TranscribeResult, out_dir: Path) -> Path:
    path = out_dir / f"{Path(result.audio).stem}.txt"
    path.write_text("\n".join(transcript_lines(result)) + "\n", encoding="utf-8")
    return path


def write_srt(result: TranscribeResult, out_dir: Path) -> Path:
    path = out_dir / f"{Path(result.audio).stem}.srt"
    with path.open("w", encoding="utf-8") as f:
        for i, t in enumerate(result.turns, 1):
            f.write(f"{i}\n{fmt_srt_ts(t['start'])} --> {fmt_srt_ts(t['end'])}\n")
            f.write(f"{t['speaker']}: {t['text']}\n\n")
    return path


def write_json(result: TranscribeResult, out_dir: Path) -> Path:
    path = out_dir / f"{Path(result.audio).stem}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(result.to_dict(), f, ensure_ascii=False, indent=2)
    return path
