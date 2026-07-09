"""Minimal Turkish-aware text folding for fuzzy matching a flagged quote to a
transcript turn (review.py). Kept local to note-core (no cross-package dep on
stt_eval) and dependency-free.

Turkish casefold: İ→i, I→ı BEFORE lower() (Python's default I→i is wrong for
Turkish). Diacritics are KEPT (ç ğ ı ş ö ü distinguish words). Punctuation → space
so a quote with/without commas still matches. Applied identically to both sides,
so only relative treatment matters.
"""
from __future__ import annotations

import re
import unicodedata

_APOSTROPHE = re.compile(r"['’ʼ]")
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def fold(text: str | None) -> str:
    """Normalize `text` for fuzzy matching: NFC → Turkish casefold → drop
    apostrophes → punctuation-to-space → collapse whitespace."""
    if not text:
        return ""
    s = unicodedata.normalize("NFC", text).replace("İ", "i").replace("I", "ı").lower()
    s = _APOSTROPHE.sub("", s)
    s = _PUNCT.sub(" ", s)
    return _WS.sub(" ", s).strip()


__all__ = ["fold"]
