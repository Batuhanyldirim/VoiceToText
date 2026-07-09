"""Structured STT-review flags: the machine-readable half of the note's
"Klinik İnceleme Gerekli" section.

The note already flags likely transcription errors / ambiguities in PROSE. This
module makes those same flags STRUCTURED so the UI can (a) highlight the suspect
span in the raw transcript and (b) jump the audio player to that moment for the
doctor to verify against the recording and correct the text.

Like problems/medications (ADR-0023) the flags are emitted in the SAME generation
call — the model appends a second sentinel + JSON block after the problems/meds
block — so there is NO extra AI request. Parsing is defensive and FAILS CLOSED to
an empty list (a model that ignores the instruction still yields a perfect note).

`locate_flags()` is pure and testable: it fuzzy-matches each flag's quoted span to
a transcript turn to attach {turn_index, start, end} for audio seek. It never
invents a match — an unlocated flag is still shown (as a general review item),
just without a jump-to-audio target.
"""
from __future__ import annotations

import json
from typing import Optional

from .extract import _extract_json_object
from .normalize_tr import fold as _fold

# Sentinel separating the problems/meds JSON block from the review-flags JSON
# block (both trail the note; see prompt.py). generate() splits on this and never
# streams/displays it. Distinct from EXTRACTION_MARKER so both blocks coexist.
REVIEW_MARKER = "<<<INCELEME_JSON>>>"

# Flag categories (Turkish, clinician-facing). Free-form is tolerated; these are
# the buckets the prompt asks for and the UI can color/group by.
CATEGORIES = ("ilaç", "doz", "olumsuzlama", "isim", "tarih", "sayı", "belirsiz", "diğer")


def _clean_flags(items) -> list:
    """Coerce raw model output into [{quote, reason, category}]. Drops entries with
    no quote (nothing to locate/highlight); tolerates strings and dicts."""
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if isinstance(it, str) and it.strip():
            out.append({"quote": it.strip(), "reason": "", "category": "diğer"})
        elif isinstance(it, dict):
            quote = str(it.get("quote") or it.get("span") or it.get("text") or "").strip()
            if not quote:
                continue
            reason = str(it.get("reason") or it.get("why") or "").strip()
            category = str(it.get("category") or it.get("type") or "diğer").strip().lower()
            if category not in CATEGORIES:
                category = "diğer"
            out.append({"quote": quote, "reason": reason, "category": category})
    return out


def parse_review_flags(raw: str) -> list:
    """Pull the review-flags JSON object from text that contains REVIEW_MARKER (or
    is itself just the JSON). Returns a cleaned list; fail-closed to []."""
    if not raw:
        return []
    idx = raw.rfind(REVIEW_MARKER)
    tail = raw[idx + len(REVIEW_MARKER):] if idx != -1 else raw
    obj = _extract_json_object(tail)
    if not isinstance(obj, dict):
        return []
    return _clean_flags(obj.get("review_flags") or obj.get("flags"))


def locate_flags(flags: list, turns: list) -> list:
    """Attach {turn_index, start, end, matched} to each flag by fuzzy-matching its
    `quote` to a transcript turn. PURE (no I/O). Turkish-folded, punctuation-loose
    substring match; falls back to best token-overlap when no clean substring hit.

    `turns` is [{speaker, text, start, end}]. A flag whose quote can't be located
    keeps matched=False (still shown, no audio jump). Never fabricates a match.
    """
    located = []
    folded_turns = [(_fold(t.get("text") or ""), t) for t in (turns or [])]
    for flag in flags or []:
        quote = flag.get("quote", "")
        qf = _fold(quote)
        best_i, best_score = -1, 0.0
        if qf:
            for i, (tf, _t) in enumerate(folded_turns):
                if not tf:
                    continue
                if qf in tf:
                    best_i, best_score = i, 1.0
                    break
                score = _token_overlap(qf, tf)
                if score > best_score:
                    best_i, best_score = i, score
        entry = dict(flag)
        # Require a meaningful overlap for a fuzzy (non-substring) match so we don't
        # jump the doctor to an unrelated turn.
        if best_i >= 0 and best_score >= 0.5:
            t = folded_turns[best_i][1]
            entry.update({
                "turn_index": best_i,
                "start": t.get("start"),
                "end": t.get("end"),
                "matched": True,
                "match_score": round(best_score, 3),
            })
        else:
            entry.update({"turn_index": None, "start": None, "end": None, "matched": False})
        located.append(entry)
    return located


def _token_overlap(a: str, b: str) -> float:
    """Fraction of `a`'s tokens present in `b` (a ⊆ b ⇒ 1.0). Cheap and
    order-insensitive — good enough to pick the turn a short quote came from."""
    at = a.split()
    if not at:
        return 0.0
    bt = set(b.split())
    return sum(1 for w in at if w in bt) / len(at)


__all__ = ["REVIEW_MARKER", "parse_review_flags", "locate_flags", "CATEGORIES"]
