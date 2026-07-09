"""Tests for STT-review-flag parsing + location (ADR-0029). No LLM/network — pure
parsing + fuzzy matching. Runs in the fast `make test` suite."""
from __future__ import annotations

from note_core.extract import EXTRACTION_MARKER, split_note_and_lists
from note_core.review import REVIEW_MARKER, locate_flags, parse_review_flags


def _full(note, ext_json, review_json):
    return f"{note}\n{EXTRACTION_MARKER}\n{ext_json}\n{REVIEW_MARKER}\n{review_json}"


class TestSplitDoesNotLeakMarkers:
    def test_note_excludes_both_json_blocks(self):
        full = _full(
            "# SOAP\nS: baş ağrısı, 500 mg parasetamol.",
            '{"problems":[{"name":"baş ağrısı"}],"medications":[{"name":"parasetamol","dose":"500 mg"}]}',
            '{"review_flags":[{"quote":"500 mg parasetamol","reason":"doz","category":"doz"}]}',
        )
        note, problems, meds = split_note_and_lists(full)
        assert EXTRACTION_MARKER not in note
        assert REVIEW_MARKER not in note
        assert note.endswith("parasetamol.")
        assert problems == [{"name": "baş ağrısı"}]
        assert meds and meds[0]["dose"] == "500 mg"

    def test_review_block_only_still_clean_note(self):
        # Model emitted only the review marker (no problems/meds block).
        full = f"# Not\nİçerik burada.\n{REVIEW_MARKER}\n" '{"review_flags":[{"quote":"x","reason":"y"}]}'
        note, problems, meds = split_note_and_lists(full)
        assert REVIEW_MARKER not in note
        assert note.strip().endswith("İçerik burada.")
        assert problems == [] and meds == []

    def test_no_markers_whole_text_is_note(self):
        note, problems, meds = split_note_and_lists("Sadece not, işaretçi yok.")
        assert note == "Sadece not, işaretçi yok."
        assert problems == [] and meds == []


class TestParseReviewFlags:
    def test_parses_flags(self):
        raw = REVIEW_MARKER + '\n{"review_flags":[{"quote":"5 mg","reason":"doz şüpheli","category":"doz"}]}'
        flags = parse_review_flags(raw)
        assert len(flags) == 1
        assert flags[0]["quote"] == "5 mg"
        assert flags[0]["category"] == "doz"

    def test_fail_closed_on_garbage(self):
        assert parse_review_flags("not json at all") == []
        assert parse_review_flags("") == []

    def test_empty_flags_array(self):
        raw = REVIEW_MARKER + '\n{"review_flags":[]}'
        assert parse_review_flags(raw) == []

    def test_unknown_category_coerced_to_diger(self):
        raw = REVIEW_MARKER + '\n{"review_flags":[{"quote":"x","category":"weird"}]}'
        assert parse_review_flags(raw)[0]["category"] == "diğer"

    def test_string_flag_tolerated(self):
        raw = REVIEW_MARKER + '\n{"review_flags":["şüpheli ifade"]}'
        flags = parse_review_flags(raw)
        assert flags[0]["quote"] == "şüpheli ifade"

    def test_flag_without_quote_dropped(self):
        raw = REVIEW_MARKER + '\n{"review_flags":[{"reason":"no quote here"}]}'
        assert parse_review_flags(raw) == []


class TestLocateFlags:
    TURNS = [
        {"speaker": "Speaker 1", "text": "Merhaba, şikayetiniz nedir?", "start": 0.0, "end": 3.0},
        {"speaker": "Speaker 2", "text": "Günde 500 mg Parasetamol alıyorum.", "start": 3.0, "end": 8.0},
    ]

    def test_substring_match_attaches_timestamps(self):
        flags = [{"quote": "500 mg parasetamol", "reason": "doz", "category": "doz"}]
        located = locate_flags(flags, self.TURNS)
        assert located[0]["matched"] is True
        assert located[0]["turn_index"] == 1
        assert located[0]["start"] == 3.0
        assert located[0]["end"] == 8.0

    def test_turkish_casefold_match(self):
        # İ/ı casing + punctuation differences must still match.
        flags = [{"quote": "PARASETAMOL", "reason": "x", "category": "ilaç"}]
        located = locate_flags(flags, self.TURNS)
        assert located[0]["matched"] is True
        assert located[0]["turn_index"] == 1

    def test_unlocatable_flag_kept_but_unmatched(self):
        flags = [{"quote": "tamamen alakasız bir cümle burada", "reason": "x", "category": "diğer"}]
        located = locate_flags(flags, self.TURNS)
        assert located[0]["matched"] is False
        assert located[0]["turn_index"] is None

    def test_empty_inputs(self):
        assert locate_flags([], self.TURNS) == []
        assert locate_flags([{"quote": "x"}], []) == [{"quote": "x", "turn_index": None,
                                                       "start": None, "end": None, "matched": False}]
