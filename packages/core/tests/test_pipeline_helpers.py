"""Unit tests for the pure pipeline helpers (no ML models loaded).

Covers the Phase-1 quick-win logic (ADR-0027): language resolution (force-tr
default with an "auto" escape hatch) and the num_speakers false-pass fix (the
'?' placeholder must not be counted as a real speaker). Importing stt_core.pipeline
does NOT pull whisperx/torch, so this runs in the fast `make test` suite.
"""
from __future__ import annotations

from stt_core.biasing import TR_CLINICAL_PROMPT, clinical_asr_options
from stt_core.models import TranscribeOptions
from stt_core.pipeline import _count_real_speakers, _resolve_language


class TestResolveLanguage:
    def test_tr_is_forwarded(self):
        assert _resolve_language("tr") == "tr"

    def test_other_codes_forwarded_lowercased(self):
        assert _resolve_language("EN") == "en"

    def test_auto_sentinels_become_none(self):
        assert _resolve_language("auto") is None
        assert _resolve_language("auto-detect") is None
        assert _resolve_language("detect") is None

    def test_empty_and_none_become_none(self):
        assert _resolve_language("") is None
        assert _resolve_language("   ") is None
        assert _resolve_language(None) is None


class TestCountRealSpeakers:
    def test_placeholder_not_counted(self):
        # The false-pass: both speakers merged -> one real label + the '?' that
        # fuse inserts for unattributed segments. Must count 1, NOT 2 (REQ-170).
        assert _count_real_speakers({"SPEAKER_00": "Speaker 1", "?": "Speaker 2"}) == 1

    def test_two_real_speakers(self):
        assert _count_real_speakers({"SPEAKER_00": "Speaker 1", "SPEAKER_01": "Speaker 2"}) == 2

    def test_only_placeholder(self):
        assert _count_real_speakers({"?": "Speaker 1"}) == 0

    def test_empty(self):
        assert _count_real_speakers({}) == 0


class TestDefaults:
    def test_turkish_and_two_speaker_defaults(self):
        # The Phase-1 defaults (ADR-0027): Turkish + soft 2-speaker cap.
        o = TranscribeOptions()
        assert o.language == "tr"
        assert o.max_speakers == 2
        assert o.asr_options is None  # biasing seam OFF by default (ADR-0028)


class TestBiasingPreset:
    def test_clinical_asr_options_shape(self):
        opts = clinical_asr_options()
        assert opts["initial_prompt"] == TR_CLINICAL_PROMPT

    def test_prompt_is_turkish_and_short(self):
        # Keep it short (applied to every 30s window) and free of specific drug
        # names (which would bias toward inventing them).
        assert "muayene" in TR_CLINICAL_PROMPT
        assert len(TR_CLINICAL_PROMPT) < 400
