"""note_core — clinical note generation from a transcript via a pluggable AI.

Local Ollama is the default (PHI stays on-device); Claude is an opt-in cloud
provider behind an explicit server env flag. Parallels stt_core: a pure
`generate(...)` function, structured streaming events, no printing/file writes.

    from note_core import generate, NoteOptions, NoteResult
    from note_core.progress import NoteEvent, STAGES
    from note_core.templates import TEMPLATE_CHOICES

See specs/ (ADR-0009, REQ-100+) for the contract and the PHI rationale.
"""
from .extract import ExtractionResult, extract, parse_extraction
from .generate import EmptyTranscriptError, generate
from .models import NoteOptions, NoteResult
from .progress import STAGES, NoteEvent
from .providers import ProviderError, list_providers
from .review import locate_flags, parse_review_flags
from .templates import TEMPLATE_CHOICES

__all__ = [
    "generate",
    "extract",
    "parse_extraction",
    "ExtractionResult",
    "NoteOptions",
    "NoteResult",
    "NoteEvent",
    "STAGES",
    "TEMPLATE_CHOICES",
    "ProviderError",
    "EmptyTranscriptError",
    "list_providers",
    "parse_review_flags",
    "locate_flags",
]
