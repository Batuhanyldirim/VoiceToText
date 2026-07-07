"""Streaming contract for note generation.

Parallels stt_core.progress. Where transcription reports coarse *stages*, note
generation streams *token deltas* — so the callback carries a growing note.
The CLI prints deltas; the API forwards them onto an asyncio.Queue -> SSE.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

# Coarse lifecycle stages (for status/UI), independent of the token stream.
STAGES = ["start", "generating", "done", "error"]


@dataclass
class NoteEvent:
    stage: str                       # one of STAGES
    delta: Optional[str] = None      # incremental text piece (during "generating")
    message: Optional[str] = None    # human-readable note (errors, stage boundaries)


NoteCallback = Callable[[NoteEvent], None]


def noop(_event: NoteEvent) -> None:  # pragma: no cover - trivial
    """No-op default so callers can omit progress entirely."""
