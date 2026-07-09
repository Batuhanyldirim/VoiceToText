"""Tests for LLM role-relabel parsing + apply guard (ADR-0030). No LLM/network —
pure parsing + the accept/fail-closed logic. Runs in the fast `make test`.

Backed by a MEASURED result: on the real HistoryTaking_YA intake, this relabel
(qwen2.5:32b on the 532 ASR segments) scored 88/100 coherence via an independent
Opus-4.8 judge vs 3/100 for the acoustic baseline — so the seam is worth guarding.
"""
from __future__ import annotations

from note_core.rediar import (
    ROLE_DISPLAY,
    RelabelResult,
    apply_relabel,
    parse_roles,
)


class TestParseRoles:
    def test_parses_by_index(self):
        raw = '{"roles": {"0":"doktor","1":"hasta","2":"DOKTOR","3":"diger"}}'
        assert parse_roles(raw, 4) == ["doktor", "hasta", "doktor", "diger"]

    def test_out_of_range_and_invalid_dropped(self):
        raw = '{"roles": {"0":"doktor","1":"weird","2":"hasta","9":"doktor"}}'
        # index 1 invalid role -> None; index 9 out of range -> ignored
        assert parse_roles(raw, 3) == ["doktor", None, "hasta"]

    def test_fail_closed_on_garbage(self):
        assert parse_roles("not json", 3) == [None, None, None]
        assert parse_roles("", 2) == [None, None]

    def test_missing_roles_key(self):
        assert parse_roles('{"foo": 1}', 2) == [None, None]

    def test_fenced_json_tolerated(self):
        raw = '```json\n{"roles": {"0":"doktor","1":"hasta"}}\n```'
        assert parse_roles(raw, 2) == ["doktor", "hasta"]


def _turns(n):
    return [{"speaker": "Speaker 1", "text": f"t{i}"} for i in range(n)]


class TestApplyGuard:
    def test_applies_when_coverage_and_roles_ok(self):
        turns = _turns(2)
        res = RelabelResult(provider="ollama", model="q",
                            labels=[ROLE_DISPLAY["doktor"], ROLE_DISPLAY["hasta"]],
                            roles=["doktor", "hasta"], coverage=1.0, n_roles=2)
        out = apply_relabel(turns, res)
        assert [t["speaker"] for t in out] == ["Doktor", "Hasta/Yakın"]
        assert all(t["role_relabeled"] for t in out)
        assert res.applied is True

    def test_fail_closed_low_coverage(self):
        turns = _turns(2)
        res = RelabelResult(provider="ollama", model="q",
                            labels=["Doktor", "Speaker 1"], roles=["doktor", None],
                            coverage=0.5, n_roles=1)
        out = apply_relabel(turns, res)
        assert [t["speaker"] for t in out] == ["Speaker 1", "Speaker 1"]  # unchanged
        assert res.applied is False

    def test_fail_closed_single_role(self):
        # High coverage but everything one role -> not a real 2-speaker split.
        turns = _turns(2)
        res = RelabelResult(provider="ollama", model="q",
                            labels=["Doktor", "Doktor"], roles=["doktor", "doktor"],
                            coverage=1.0, n_roles=1)
        out = apply_relabel(turns, res)
        assert [t["speaker"] for t in out] == ["Speaker 1", "Speaker 1"]
        assert res.applied is False

    def test_does_not_mutate_input(self):
        turns = _turns(2)
        res = RelabelResult(provider="ollama", model="q",
                            labels=["Doktor", "Hasta/Yakın"], roles=["doktor", "hasta"],
                            coverage=1.0, n_roles=2)
        apply_relabel(turns, res)
        assert turns[0]["speaker"] == "Speaker 1"  # original untouched
        assert "role_relabeled" not in turns[0]

    def test_empty(self):
        res = RelabelResult(provider="ollama", model="q")
        assert apply_relabel([], res) == []
