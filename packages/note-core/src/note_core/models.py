"""Typed data models for clinical note generation.

Mirrors the shape/conventions of stt_core.models: plain dataclasses, a
`to_dict()` for JSON serialization, defaults that match the CLI/API. Kept
provider-agnostic — the same NoteOptions drives Ollama (default) or Claude.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

# The provider is chosen by the OPERATOR via server env, never by the browser
# (ADR-0009). Default is the fully-local Ollama path so PHS/PHI never leaves the
# machine; "claude" is an explicit cloud opt-in.
DEFAULT_PROVIDER = os.environ.get("STT_NOTE_PROVIDER", "ollama").strip().lower()

# Strongest practical local model on a 48 GB M-series Mac (fits in unified memory
# with a large num_ctx). Overridable via env for lighter/faster iteration.
DEFAULT_OLLAMA_MODEL = os.environ.get("STT_NOTE_MODEL", "qwen2.5:32b-instruct")
DEFAULT_CLAUDE_MODEL = os.environ.get("STT_CLAUDE_MODEL", "claude-opus-4-8")

# Transcripts + the clinical prompt are long; Ollama's default context is small
# and silently truncates. Set generously (tokens). Overridable via env.
DEFAULT_NUM_CTX = int(os.environ.get("STT_NOTE_NUM_CTX", "16384"))


@dataclass
class NoteOptions:
    """All knobs for a note-generation run. Defaults keep the local path working
    with no configuration (see specs/requirements.md REQ-100+)."""
    provider: str = DEFAULT_PROVIDER        # "ollama" (default, local) | "claude" (opt-in, cloud)
    model: Optional[str] = None             # None -> provider default (resolved in generate())
    template: str = "soap"                  # template key or "free" (see templates.py)
    template_text: Optional[str] = None     # required when template == "free": the pasted sample format
    temperature: float = 0.2                # low: this is extraction, not creative writing
    num_ctx: int = DEFAULT_NUM_CTX          # Ollama context window (ignored by Claude)
    max_tokens: int = 16000                 # output cap (used by Claude; advisory for Ollama)

    def resolved_model(self) -> str:
        """The concrete model id to call, filling in the provider default."""
        if self.model:
            return self.model
        return DEFAULT_CLAUDE_MODEL if self.provider == "claude" else DEFAULT_OLLAMA_MODEL


@dataclass
class NoteResult:
    """Structured output of a completed note generation."""
    provider: str
    model: str
    template: str
    note: str                               # the full generated note (sections A–E)
    stopped_early: bool = False             # True if the model hit its output cap
    usage: dict = field(default_factory=dict)  # provider-specific counters (tokens, eval durations…)
    # Problem/medication lists extracted in the SAME generation call (ADR-0023):
    # the model appends a JSON block after the note, which generate() splits out —
    # so extraction costs no extra request. Empty when not requested/unparseable.
    problems: list = field(default_factory=list)
    medications: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "template": self.template,
            "note": self.note,
            "stopped_early": self.stopped_early,
            "usage": self.usage,
            "problems": self.problems,
            "medications": self.medications,
        }
