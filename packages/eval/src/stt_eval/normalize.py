"""Turkish-aware text normalization for WER/CER scoring.

This is the correctness heart of the eval harness and the single easiest thing to
get wrong for Turkish, so it lives in its own pure-Python module (no third-party
imports) and is unit-tested in the fast `make test` suite.

Two Turkish-specific rules the rest of the ASR world gets wrong:

1. **Casefold with the Turkish dotted/dotless-i rule.** Python's `str.lower()`
   maps ``I -> i`` (wrong: Turkish ``I`` is dotless, lowercases to ``ı``) and maps
   ``İ -> i̇`` (an ``i`` + a combining dot, length 2). We map ``İ -> i`` and
   ``I -> ı`` *before* `.lower()` so both the reference and the hypothesis casefold
   identically. Applied to BOTH sides, this removes a pure-artifact WER penalty.

2. **Never strip Turkish diacritics.** Whisper's own
   ``BasicTextNormalizer(remove_diacritics=True)`` deletes ``ç ğ ı ş ö ü`` — which
   collapses distinct Turkish words (``şık``/``sık``, ``için``/``icin``) and
   manufactures several absolute WER points that are not real errors. We keep them.

Everything here is applied IDENTICALLY to reference and hypothesis, so the only
thing that matters is that the two strings are treated the same way.
"""
from __future__ import annotations

import re
import unicodedata

# Apostrophes are DROPPED (join, not split): in Turkish the apostrophe separates
# a suffix from a proper noun ("İstanbul'da" = "in Istanbul", "Ahmet'in"), which
# is orthographic convention, not a word boundary — and ASR routinely omits it.
# Removing it makes "İstanbul'da" == "istanbulda" so it isn't scored as an error.
# Covers ASCII ' and the typographic ' (U+2019).
_APOSTROPHE_RE = re.compile(r"['’ʼ]")
# Remaining punctuation -> space (so "120/80" -> "120 80", "5,5" -> "5 5" on BOTH
# sides). \w (unicode) keeps letters — including ç ğ ı ş ö ü — digits, underscore.
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def tr_lower(s: str) -> str:
    """Locale-correct Turkish lowercase.

    ``İ`` (U+0130, dotted capital I) -> ``i`` and ``I`` (dotless capital) -> ``ı``,
    performed before a normal ``.lower()`` (which then correctly lowercases
    ``Ç Ğ Ö Ş Ü`` and leaves the already-lowered ``i``/``ı`` untouched).
    """
    # Normalize first so a decomposed "İ" (i + combining dot) collapses to U+0130.
    s = unicodedata.normalize("NFC", s)
    return s.replace("İ", "i").replace("I", "ı").lower()


def tr_normalize(text: str | None, *, remove_punct: bool = True) -> str:
    """Return `text` normalized for scoring: NFC -> Turkish casefold ->
    punctuation-to-space (optional) -> whitespace-collapsed -> stripped.

    Keeps digits (dose/BP/lab fidelity matters here) and Turkish diacritics.
    """
    if not text:
        return ""
    s = tr_lower(text)  # tr_lower already NFC-normalizes
    if remove_punct:
        s = _APOSTROPHE_RE.sub("", s)   # drop (join) before other punct -> space
        s = _PUNCT_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


def tokens(text: str | None, *, remove_punct: bool = True) -> list[str]:
    """Normalized whitespace tokens — the unit WER counts over."""
    norm = tr_normalize(text, remove_punct=remove_punct)
    return norm.split() if norm else []
