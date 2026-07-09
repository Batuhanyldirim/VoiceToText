"""Tests for the config aggregate — specifically that WER and CER are BOTH
micro-averaged (char/word-weighted), so a long clip isn't under-weighted by a
naive mean of per-item rates. No ML models; runs under the fast `make test`.
"""
from __future__ import annotations

import pytest

from stt_eval.run import ItemResult, _aggregate


def _item(id, wer, cer, ins, dele, sub, ref_words, char_errors, ref_chars):
    return ItemResult(
        id=id, config="c", wer=wer, cer=cer, term_recall=None, der=None, cpwer=None,
        num_speakers_reported=2, num_speakers_true=2, ref_words=ref_words,
        transcribe_seconds=1.0,
        detail={"text": {"insertions": ins, "deletions": dele, "substitutions": sub,
                         "char_errors": char_errors, "ref_chars": ref_chars},
                "term_recall": None},
    )


def test_cer_is_char_weighted_not_macro_mean():
    # The review's example: item A tiny+perfect, item B long+bad. A plain mean of
    # per-item CER would report ~25%; the true corpus (char-weighted) CER ~= 49.5%.
    a = _item("a", wer=0.0, cer=0.0, ins=0, dele=0, sub=0, ref_words=1,
              char_errors=0, ref_chars=2)
    b = _item("b", wer=0.5, cer=0.5, ins=0, dele=0, sub=100, ref_words=100,
              char_errors=100, ref_chars=200)
    agg = _aggregate("c", [a, b])
    # char-weighted: 100 errors / 202 chars ~= 0.495 (NOT the 0.25 macro-mean)
    assert agg.cer == pytest.approx(100 / 202, abs=1e-6)
    assert agg.cer > 0.4  # decisively not the misleading 25%


def test_wer_is_word_weighted():
    a = _item("a", wer=0.0, cer=0.0, ins=0, dele=0, sub=0, ref_words=2,
              char_errors=0, ref_chars=10)
    b = _item("b", wer=1.0, cer=1.0, ins=0, dele=0, sub=8, ref_words=8,
              char_errors=40, ref_chars=40)
    agg = _aggregate("c", [a, b])
    # 8 word errors / 10 ref words = 0.8 (word-weighted, not the 0.5 macro-mean)
    assert agg.wer == pytest.approx(0.8, abs=1e-6)


def test_empty_results_no_divide_by_zero():
    agg = _aggregate("c", [])
    assert agg.wer == 0.0
    assert agg.cer == 0.0
    assert agg.n == 0
