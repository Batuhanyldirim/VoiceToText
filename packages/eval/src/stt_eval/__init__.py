"""stt_eval — Turkish-aware transcription accuracy harness (dev-only).

Measures WER/CER + medical term recall (text) and DER/cpWER (speaker attribution)
against a fixed reference set, so every transcription-config change can be A/B
tested with a real number instead of the old "does it find >=2 speakers" gate
(which gives false passes — see turkish-asr-improvement-research).

Pure-Python normalization + scoring live in `normalize`/`metrics` and are imported
without loading any ML models; only `run` (the transcription driver) pulls stt_core.
"""
from __future__ import annotations

from .metrics import (
    CpWer,
    TermRecall,
    TextScore,
    cpwer,
    diarization_error_rate,
    score_text,
    term_recall,
)
from .normalize import tokens, tr_lower, tr_normalize

__all__ = [
    "tr_normalize", "tr_lower", "tokens",
    "score_text", "term_recall", "cpwer", "diarization_error_rate",
    "TextScore", "TermRecall", "CpWer",
]
