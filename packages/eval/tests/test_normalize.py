"""Tests for the Turkish-aware normalizer — the correctness heart of the harness.
No ML models; runs in the fast `make test` suite (ADR-0017)."""
from __future__ import annotations

from stt_eval.normalize import tokens, tr_lower, tr_normalize


class TestTurkishCasefold:
    def test_dotless_capital_I_lowercases_to_dotless_i(self):
        # Python str.lower() would wrongly give "işık"; Turkish rule -> "ışık".
        assert tr_lower("IŞIK") == "ışık"

    def test_dotted_capital_I_lowercases_to_i(self):
        # "İstanbul" -> "istanbul" (single 'i', NOT 'i' + combining dot).
        assert tr_lower("İstanbul") == "istanbul"
        assert len(tr_lower("İ")) == 1

    def test_mixed_word(self):
        assert tr_lower("İğne") == "iğne"
        assert tr_lower("ILIK") == "ılık"

    def test_ref_and_hyp_casefold_identically(self):
        # The whole point: same word in different casing must normalize equal.
        assert tr_normalize("İSTANBUL") == tr_normalize("istanbul")
        assert tr_normalize("Işık") == tr_normalize("IŞIK")


class TestDiacriticsKept:
    def test_turkish_letters_survive_normalization(self):
        assert tr_normalize("çğışöü") == "çğışöü"

    def test_distinct_words_stay_distinct(self):
        # If diacritics were stripped these would collapse — they must NOT.
        assert tr_normalize("şık") != tr_normalize("sık")
        assert tr_normalize("için") != tr_normalize("icin")


class TestPunctuationAndDigits:
    def test_punctuation_becomes_space(self):
        assert tr_normalize("120/80") == "120 80"
        assert tr_normalize("5,5 mg.") == "5 5 mg"

    def test_digits_preserved(self):
        # Dose/BP/lab fidelity: digits must never be dropped.
        assert "5" in tokens("Günde 5 mg reçete edildi")

    def test_whitespace_collapsed_and_stripped(self):
        assert tr_normalize("  merhaba   doktor  ") == "merhaba doktor"

    def test_empty_and_none(self):
        assert tr_normalize("") == ""
        assert tr_normalize(None) == ""
        assert tokens(None) == []


class TestApostrophe:
    def test_suffix_apostrophe_is_dropped_not_split(self):
        # "İstanbul'da" (in Istanbul) must equal the ASR-omitted "istanbulda",
        # not become two tokens "istanbul da".
        assert tr_normalize("İstanbul'da") == "istanbulda"
        assert tr_normalize("İstanbul'da") == tr_normalize("istanbulda")

    def test_typographic_apostrophe_also_dropped(self):
        assert tr_normalize("Ahmet’in") == tr_normalize("ahmetin")
