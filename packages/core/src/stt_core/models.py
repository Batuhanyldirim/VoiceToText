"""Typed data models shared across the pipeline, CLI, and API."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TranscribeOptions:
    """All knobs for a transcription run. Defaults mirror the CLI
    (see specs/requirements.md REQ-011)."""
    model: str = "large-v3"
    # Default to Turkish, not auto-detect (REQ-135, ADR-0027). This project's audio
    # is Turkish clinical encounters; auto-detect reads only the first ~30 s and a
    # quiet/loanword-heavy opener can misfire, decoding the WHOLE file in the wrong
    # language AND skipping the Turkish aligner. Benchmarked accuracy-neutral on
    # clean audio and ~30 % faster on large-v3 (skips the detect pass). Pass an
    # explicit code (e.g. "en") or "auto" to override — see _resolve_language().
    language: Optional[str] = "tr"
    device: str = "cpu"                     # CPU-only by design (ADR-0001)
    compute_type: str = "int8"
    batch_size: int = 8
    enhance: bool = True                    # audio leveling ON by default (ADR-0004)
    vad_onset: float = 0.35
    diarize: bool = True
    min_speakers: Optional[int] = None
    # Default to a soft cap of 2 speakers (doctor + patient), overridable up for a
    # caregiver/interpreter (REQ-136, ADR-0027). This is the most common encounter
    # shape; leaving the count unbounded lets pyannote over-split a quiet/far patient
    # into phantom speakers or (rarely) merge both. A SOFT cap, never a hardcoded
    # exact count — a genuine monologue still yields one speaker.
    max_speakers: Optional[int] = 2
    diar_model: str = "pyannote/speaker-diarization-3.1"
    hf_token: Optional[str] = None          # required when diarize=True
    # Extra faster-whisper decode options forwarded verbatim to
    # whisperx.load_model(asr_options=...). The biasing seam (REQ-139, ADR-0028):
    # e.g. {"initial_prompt": "<Turkish clinical prose>"} or {"hotwords": "..."}.
    # None = whisperx defaults. NOTE (verified in whisperx/asr.py): initial_prompt
    # and hotwords DO reach decoding, but the anti-hallucination knobs
    # (temperature/no_speech_threshold/compression_ratio_threshold/
    # condition_on_previous_text/repetition_penalty) are NO-OPS in the batched path —
    # don't bother setting them here. Keep suppress_numerals=False (dose fidelity).
    asr_options: Optional[dict] = None


@dataclass
class Turn:
    """One speaker turn in the final transcript."""
    speaker: str
    text: str
    start: Optional[float]
    end: Optional[float]


@dataclass
class TranscribeResult:
    """Structured output of the pipeline. Consumed by the CLI (to write files),
    the API (to return JSON), and any other caller."""
    audio: str
    language: Optional[str]
    num_speakers: int
    speaker_map: dict = field(default_factory=dict)
    turns: list = field(default_factory=list)        # list[Turn] as dicts when serialized
    segments: list = field(default_factory=list)     # raw WhisperX segments
    # Wall-clock seconds the transcription took. Persisted into <stem>.json so a
    # reused transcript can still report how long it took (set by the caller
    # after transcribe() returns). None for older files that predate this field.
    transcribe_seconds: Optional[float] = None

    def to_dict(self) -> dict:
        """JSON-serializable dict (the shape the old CLI wrote to <name>.json)."""
        return {
            "audio": self.audio,
            "language": self.language,
            "num_speakers": self.num_speakers,
            "speaker_map": self.speaker_map,
            "turns": [t if isinstance(t, dict) else t.__dict__ for t in self.turns],
            "segments": self.segments,
            "transcribe_seconds": self.transcribe_seconds,
        }
