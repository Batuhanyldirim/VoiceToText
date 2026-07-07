"""Typed data models shared across the pipeline, CLI, and API."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TranscribeOptions:
    """All knobs for a transcription run. Defaults mirror the original CLI
    (see specs/requirements.md REQ-011)."""
    model: str = "large-v3"
    language: Optional[str] = None          # None = auto-detect
    device: str = "cpu"                     # CPU-only by design (ADR-0001)
    compute_type: str = "int8"
    batch_size: int = 8
    enhance: bool = True                    # audio leveling ON by default (ADR-0004)
    vad_onset: float = 0.35
    diarize: bool = True
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None
    diar_model: str = "pyannote/speaker-diarization-3.1"
    hf_token: Optional[str] = None          # required when diarize=True


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

    def to_dict(self) -> dict:
        """JSON-serializable dict (the shape the old CLI wrote to <name>.json)."""
        return {
            "audio": self.audio,
            "language": self.language,
            "num_speakers": self.num_speakers,
            "speaker_map": self.speaker_map,
            "turns": [t if isinstance(t, dict) else t.__dict__ for t in self.turns],
            "segments": self.segments,
        }
