"""stt_core — the shared speech-to-text + diarization pipeline.

Public API consumed by both the CLI (apps/cli) and the web API (apps/api):

    from stt_core import transcribe, TranscribeOptions, TranscribeResult
    from stt_core.progress import ProgressEvent, STAGES
    from stt_core import emit

See specs/ (product/tech/design + ADRs) for the contract and rationale.
"""
from .biasing import TR_CLINICAL_PROMPT, clinical_asr_options
from .models import TranscribeOptions, TranscribeResult, Turn
from .pipeline import MissingTokenError, transcribe
from .progress import STAGES, ProgressEvent
from .streaming import StreamingTranscriber

__all__ = [
    "transcribe",
    "StreamingTranscriber",
    "TranscribeOptions",
    "TranscribeResult",
    "Turn",
    "ProgressEvent",
    "STAGES",
    "MissingTokenError",
    "TR_CLINICAL_PROMPT",
    "clinical_asr_options",
]
