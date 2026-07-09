"""Scoring metrics: Turkish WER/CER + medical term recall (text), DER + cpWER
(speaker attribution).

All third-party imports (jiwer, pyannote.metrics) are lazy — inside the functions
that need them — so importing this module is cheap and the pure text metrics stay
usable even if the optional `eval` extra libs aren't perfectly aligned. jiwer's
own text normalization is bypassed: we pre-normalize with `tr_normalize` (Turkish
casefold, diacritics kept) and hand jiwer already-tokenized strings.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import permutations
from typing import Optional

from .normalize import tokens, tr_normalize


@dataclass
class TextScore:
    """WER/CER over one (reference, hypothesis) pair, after Turkish normalization."""
    wer: float
    cer: float
    insertions: int
    deletions: int
    substitutions: int
    hits: int
    ref_words: int
    hyp_words: int
    # Character-level counts (for a correct char-WEIGHTED corpus CER aggregate;
    # a plain mean of per-item CER under-weights long clips).
    char_errors: int = 0
    ref_chars: int = 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def score_text(reference: str, hypothesis: str) -> TextScore:
    """Turkish-normalized WER + CER for one pair. Empty reference -> WER/CER are
    0.0 if the hypothesis is also empty, else 1.0 (all insertions).

    We pre-normalize with `tr_normalize` (Turkish casefold, diacritics kept) and
    hand jiwer the result; jiwer's own default transforms don't lowercase or strip,
    so they won't re-apply a non-Turkish casefold over our normalized text."""
    import jiwer

    ref_norm = tr_normalize(reference)
    hyp_norm = tr_normalize(hypothesis)
    ref_wc = len(ref_norm.split())
    hyp_wc = len(hyp_norm.split())

    if not ref_norm:
        wer = 0.0 if not hyp_norm else 1.0
        cer = 0.0 if not hyp_norm else 1.0
        # All hyp chars are insertions; ref has 0 chars.
        return TextScore(wer, cer, hyp_wc, 0, 0, 0, ref_wc, hyp_wc,
                         char_errors=len(hyp_norm), ref_chars=0)

    w = jiwer.process_words([ref_norm], [hyp_norm])
    # CER: character edit distance over the normalized strings (spaces kept as
    # ordinary characters so word-boundary errors still count).
    c = jiwer.process_characters([ref_norm], [hyp_norm])
    char_errors = int(c.insertions + c.deletions + c.substitutions)
    return TextScore(
        wer=float(w.wer),
        cer=float(c.cer),
        insertions=int(w.insertions),
        deletions=int(w.deletions),
        substitutions=int(w.substitutions),
        hits=int(w.hits),
        ref_words=ref_wc,
        hyp_words=hyp_wc,
        char_errors=char_errors,
        ref_chars=len(ref_norm),
    )


@dataclass
class TermRecall:
    """How many expected medical terms survived transcription (grounded in the
    normalized hypothesis text). Recall, not precision — this asks "did the drug
    name make it through", the clinically important direction."""
    total: int
    found: int
    missing: list[str] = field(default_factory=list)

    @property
    def recall(self):
        # None (not a vacuous 1.0) when there are no scorable terms — a degenerate
        # term list (empty, or all punctuation that normalizes away) must NOT
        # report perfect recall and silently inflate an A/B verdict.
        return (self.found / self.total) if self.total else None

    def to_dict(self) -> dict:
        return {"total": self.total, "found": self.found, "recall": self.recall,
                "missing": self.missing}


def term_recall(hypothesis: str, terms: list[str]) -> TermRecall:
    """Fraction of `terms` present in the normalized hypothesis. Each term is
    normalized the same way (so 'İbuprofen' matches 'ibuprofen') and matched on a
    whitespace-token-subsequence basis (multi-word terms allowed)."""
    if not terms:
        return TermRecall(0, 0, [])
    hyp_tokens = tokens(hypothesis)
    hyp_joined = " " + " ".join(hyp_tokens) + " "
    found, missing = 0, []
    for term in terms:
        t_tokens = tokens(term)
        if not t_tokens:
            continue
        needle = " " + " ".join(t_tokens) + " "
        if needle in hyp_joined:
            found += 1
        else:
            missing.append(term)
    return TermRecall(total=len([t for t in terms if tokens(t)]), found=found, missing=missing)


# ---- Speaker-attribution metrics (the false-pass catchers) ------------------

def _turns_to_annotation(turns: list[dict]):
    """Build a pyannote Annotation from transcript turns [{speaker,start,end}].
    Turns with missing timestamps are skipped."""
    from pyannote.core import Annotation, Segment
    ann = Annotation()
    for i, t in enumerate(turns):
        s, e = t.get("start"), t.get("end")
        spk = t.get("speaker")
        if s is None or e is None or spk is None or e <= s:
            continue
        ann[Segment(float(s), float(e)), i] = str(spk)
    return ann


def diarization_error_rate(ref_turns: list[dict], hyp_turns: list[dict]) -> Optional[float]:
    """DER between reference and hypothesis speaker timelines. Returns None if the
    reference carries no usable timing (can't score)."""
    from pyannote.metrics.diarization import DiarizationErrorRate
    ref = _turns_to_annotation(ref_turns)
    hyp = _turns_to_annotation(hyp_turns)
    if not len(ref):
        return None
    metric = DiarizationErrorRate()
    return float(metric(ref, hyp))


def cpwer(ref_turns: list[dict], hyp_turns: list[dict]) -> Optional["CpWer"]:
    """Concatenated minimum-permutation WER.

    Concatenate each speaker's text, then find the speaker->speaker mapping
    (over the smaller side's permutations) that minimizes total WER. This is the
    metric that FAILS a run which merged both people into one speaker even though
    the ASR text is fine — exactly the false pass the current `num_speakers` gate
    hides (`out/HistoryTaking_YA.json`: 531 SPEAKER_00 + 1 None -> reported 2)."""
    ref_by = _concat_by_speaker(ref_turns)
    hyp_by = _concat_by_speaker(hyp_turns)
    if not ref_by:
        return None

    ref_speakers = list(ref_by.keys())
    hyp_speakers = list(hyp_by.keys())

    # Pad the smaller side with empty speakers so every ref speaker gets a mapping.
    n = max(len(ref_speakers), len(hyp_speakers))
    hyp_padded = hyp_speakers + [None] * (n - len(hyp_speakers))

    best = None
    # Permute hypothesis speakers against reference speakers; n is tiny (2-3).
    for perm in permutations(hyp_padded, len(ref_speakers)):
        total_wer, total_ref_words = 0.0, 0
        errs = 0
        for ref_spk, hyp_spk in zip(ref_speakers, perm):
            ref_text = ref_by[ref_spk]
            hyp_text = hyp_by.get(hyp_spk, "") if hyp_spk is not None else ""
            sc = score_text(ref_text, hyp_text)
            errs += sc.insertions + sc.deletions + sc.substitutions
            total_ref_words += sc.ref_words
        # Any hypothesis speakers left unmapped: their words are pure insertions.
        mapped = set(p for p in perm if p is not None)
        for hyp_spk in hyp_speakers:
            if hyp_spk not in mapped:
                errs += len(tokens(hyp_by[hyp_spk]))
        denom = total_ref_words or 1
        cand = errs / denom
        if best is None or cand < best.cpwer:
            best = CpWer(cpwer=cand, ref_speakers=len(ref_speakers),
                         hyp_speakers=len(hyp_speakers),
                         mapping={ref_speakers[i]: perm[i] for i in range(len(ref_speakers))})
    return best


@dataclass
class CpWer:
    cpwer: float
    ref_speakers: int
    hyp_speakers: int
    mapping: dict

    def to_dict(self) -> dict:
        return {"cpwer": self.cpwer, "ref_speakers": self.ref_speakers,
                "hyp_speakers": self.hyp_speakers,
                "mapping": {str(k): (str(v) if v is not None else None)
                            for k, v in self.mapping.items()}}


def _concat_by_speaker(turns: list[dict]) -> dict:
    """{speaker -> concatenated normalized-ish text} preserving turn order."""
    by: dict[str, list[str]] = {}
    for t in turns:
        spk = t.get("speaker")
        txt = (t.get("text") or "").strip()
        if spk is None or not txt:
            continue
        by.setdefault(str(spk), []).append(txt)
    return {spk: " ".join(parts) for spk, parts in by.items()}
