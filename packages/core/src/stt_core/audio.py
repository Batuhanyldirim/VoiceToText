"""Audio pre-processing: level a quiet/far speaker toward a loud/close one.

Ported verbatim from the original transcribe.py enhance_audio() (ADR-0004).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Callable

# Verified ffmpeg chain: high-pass rumble, pull quiet speech up (speechnorm +
# dynaudnorm), then normalize loudness. Recovers a ~30 dB-quieter speaker.
_FILTER_CHAIN = (
    "highpass=f=80,"
    "speechnorm=e=25:r=0.0005:l=1,"
    "dynaudnorm=f=150:g=15:p=0.9,"
    "loudnorm=I=-16:TP=-1.5:LRA=11"
)


def enhance_audio(src_path: Path, out_dir: Path, log: Callable[[str], None] = lambda m: None) -> Path:
    """Return a leveled 16 kHz mono wav next to out_dir; fall back to the
    original file if ffmpeg is missing or the pass fails."""
    if shutil.which("ffmpeg") is None:
        log("WARNING: ffmpeg not found; skipping enhancement.")
        return src_path

    enhanced = out_dir / f"{src_path.stem}.enhanced.wav"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_path),
           "-af", _FILTER_CHAIN, "-ar", "16000", "-ac", "1", str(enhanced)]
    log("Enhancing audio (leveling quiet vs loud speaker) ...")
    try:
        subprocess.run(cmd, check=True)
        return enhanced
    except Exception as e:  # noqa: BLE001 - degrade, don't crash
        log(f"WARNING: enhancement failed ({e}); using original audio.")
        return src_path
