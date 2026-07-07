"""stt_core — the shared speech-to-text + diarization pipeline.

Public API consumed by both the CLI (apps/cli) and the web API (apps/api):

    from stt_core import transcribe, TranscribeOptions, TranscribeResult
    from stt_core.progress import ProgressEvent, STAGES
    from stt_core import emit

See specs/ (product/tech/design + ADRs) for the contract and rationale.
"""
from .models import TranscribeOptions, TranscribeResult, Turn
from .pipeline import MissingTokenError, transcribe
from .progress import STAGES, ProgressEvent

__all__ = [
    "transcribe",
    "TranscribeOptions",
    "TranscribeResult",
    "Turn",
    "ProgressEvent",
    "STAGES",
    "MissingTokenError",
]
