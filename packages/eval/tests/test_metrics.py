"""Tests for WER/CER, term recall, and the cpWER merged-speaker false-pass catcher.
No ML models (jiwer + pyannote.metrics only); runs under the fast `make test`."""
from __future__ import annotations

import pytest

from stt_eval.metrics import cpwer, diarization_error_rate, score_text, term_recall


class TestScoreText:
    def test_perfect_match_is_zero(self):
        s = score_text("merhaba doktor bey", "merhaba doktor bey")
        assert s.wer == 0.0
        assert s.cer == 0.0

    def test_casing_and_diacritic_casing_ignored(self):
        # Turkish casefold makes these equal — no artifact WER.
        s = score_text("İstanbul'da ağrı var", "istanbulda ağrı var")
        assert s.wer == 0.0

    def test_one_word_deletion(self):
        s = score_text("merhaba doktor bey", "merhaba doktor")
        assert s.deletions == 1
        assert s.wer == pytest.approx(1 / 3, abs=1e-6)

    def test_suffix_error_costs_full_word_in_wer_but_little_in_cer(self):
        # Agglutinative near-miss: geliyordu -> geliyor. WER counts a whole word;
        # CER counts only the dropped chars. This is WHY we report CER too.
        s = score_text("hasta geliyordu", "hasta geliyor")
        assert s.wer == pytest.approx(0.5, abs=1e-6)   # 1 of 2 words wrong
        assert 0.0 < s.cer < s.wer                     # far cheaper per-char

    def test_empty_reference_with_hypothesis_is_all_error(self):
        s = score_text("", "hallucinated text")
        assert s.wer == 1.0

    def test_empty_both_is_zero(self):
        s = score_text("", "")
        assert s.wer == 0.0
        assert s.cer == 0.0


class TestTermRecall:
    def test_all_terms_found(self):
        tr = term_recall("günde iki kez parasetamol ve ibuprofen", ["parasetamol", "ibuprofen"])
        assert tr.recall == 1.0
        assert tr.missing == []

    def test_missing_term_reported(self):
        tr = term_recall("günde iki kez parasetamol", ["parasetamol", "ibuprofen"])
        assert tr.found == 1
        assert "ibuprofen" in tr.missing

    def test_term_matching_is_turkish_casefolded(self):
        tr = term_recall("İBUPROFEN reçete edildi", ["ibuprofen"])
        assert tr.recall == 1.0

    def test_no_terms_recall_is_none_not_vacuous_100pct(self):
        # A degenerate term list must NOT report perfect recall (which would
        # silently inflate an A/B verdict) — it has nothing to measure.
        assert term_recall("herhangi bir metin", []).recall is None

    def test_all_terms_normalize_empty_recall_is_none(self):
        # Punctuation-only "terms" reduce to no tokens -> not scorable -> None,
        # even though the list is non-empty (slips past a naive call-site guard).
        tr = term_recall("herhangi bir metin", ["'", "--", "."])
        assert tr.total == 0
        assert tr.recall is None


class TestCerCharWeighted:
    def test_score_text_exposes_char_counts(self):
        s = score_text("abc def", "abd def")  # 1 substitution over 7 chars
        assert s.ref_chars == 7
        assert s.char_errors == 1

    def test_empty_ref_char_counts(self):
        s = score_text("", "abc")
        assert s.ref_chars == 0
        assert s.char_errors == 3


class TestCpWerMergedSpeakerFalsePass:
    """The load-bearing test: cpWER must PENALIZE a run that merged two speakers
    into one, even when the transcribed text is perfect — exactly the failure the
    `num_speakers >= 2` gate silently passes (out/HistoryTaking_YA.json)."""

    REF = [
        {"speaker": "Speaker 1", "text": "merhaba nasılsınız bugün"},
        {"speaker": "Speaker 2", "text": "iyiyim teşekkür ederim doktor bey"},
        {"speaker": "Speaker 1", "text": "şikayetiniz nedir"},
        {"speaker": "Speaker 2", "text": "başım ağrıyor ve ateşim var"},
    ]

    def test_correct_diarization_scores_near_zero(self):
        # Same speakers, same text, just relabeled (Speaker 1<->2 permutation).
        hyp = [
            {"speaker": "SPEAKER_00", "text": "merhaba nasılsınız bugün"},
            {"speaker": "SPEAKER_01", "text": "iyiyim teşekkür ederim doktor bey"},
            {"speaker": "SPEAKER_00", "text": "şikayetiniz nedir"},
            {"speaker": "SPEAKER_01", "text": "başım ağrıyor ve ateşim var"},
        ]
        result = cpwer(self.REF, hyp)
        assert result is not None
        assert result.cpwer == pytest.approx(0.0, abs=1e-6)

    def test_merged_speakers_is_heavily_penalized(self):
        # Both speakers merged into one label (the HistoryTaking_YA failure).
        # Text is byte-perfect, but half the words are attributed to the wrong
        # speaker -> cpWER must be substantial, NOT ~zero.
        merged = [{"speaker": "SPEAKER_00", "text": t["text"]} for t in self.REF]
        result = cpwer(self.REF, merged)
        assert result is not None
        assert result.hyp_speakers == 1
        assert result.ref_speakers == 2
        # One reference speaker's words are entirely unrecoverable from the single
        # merged track -> cpWER is large (well above a passing threshold).
        assert result.cpwer > 0.3

    def test_no_reference_speakers_returns_none(self):
        assert cpwer([], []) is None


class TestDer:
    def test_der_needs_timing(self):
        ref = [{"speaker": "Speaker 1", "text": "a", "start": 0.0, "end": 1.0},
               {"speaker": "Speaker 2", "text": "b", "start": 1.0, "end": 2.0}]
        hyp = [{"speaker": "SPEAKER_00", "text": "a", "start": 0.0, "end": 1.0},
               {"speaker": "SPEAKER_01", "text": "b", "start": 1.0, "end": 2.0}]
        der = diarization_error_rate(ref, hyp)
        assert der == pytest.approx(0.0, abs=1e-6)

    def test_der_none_without_reference_timing(self):
        ref = [{"speaker": "Speaker 1", "text": "a"}]  # no start/end
        assert diarization_error_rate(ref, []) is None
