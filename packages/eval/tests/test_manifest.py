"""Tests for manifest loading (inline turns + external reference files).
No ML models; runs under the fast `make test`."""
from __future__ import annotations

import json

import pytest

from stt_eval.manifest import load_manifest


def _write(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def test_inline_turns_manifest(tmp_path):
    root = tmp_path
    (root / "eval" / "manifests").mkdir(parents=True)
    (root / "samples").mkdir()
    (root / "samples" / "a.wav").write_bytes(b"RIFF")  # placeholder audio
    mpath = root / "eval" / "manifests" / "m.json"
    _write(mpath, {
        "name": "t",
        "items": [{"id": "a", "audio": "samples/a.wav",
                   "terms": ["ateş"],
                   "turns": [{"speaker": "Speaker 1", "text": "merhaba"}]}],
    })
    m = load_manifest(mpath, root=root)
    assert m.name == "t"
    assert len(m.items) == 1
    assert m.items[0].id == "a"
    assert m.items[0].terms == ["ateş"]
    assert m.items[0].reference_turns[0]["text"] == "merhaba"
    assert m.items[0].has_timing is False


def test_external_reference_file(tmp_path):
    root = tmp_path
    (root / "eval" / "manifests").mkdir(parents=True)
    (root / "eval" / "data").mkdir(parents=True)
    (root / "samples").mkdir()
    (root / "samples" / "a.wav").write_bytes(b"RIFF")
    # Reference is a TranscribeResult-shaped dict with timing.
    _write(root / "eval" / "data" / "a.ref.json",
           {"turns": [{"speaker": "Speaker 1", "text": "merhaba", "start": 0.0, "end": 1.0}]})
    mpath = root / "eval" / "manifests" / "m.json"
    _write(mpath, {"name": "t", "items": [
        {"id": "a", "audio": "samples/a.wav", "reference": "eval/data/a.ref.json"}]})
    m = load_manifest(mpath, root=root)
    assert m.items[0].reference_turns[0]["text"] == "merhaba"
    assert m.items[0].has_timing is True


def test_missing_reference_file_errors_clearly(tmp_path):
    root = tmp_path
    (root / "eval" / "manifests").mkdir(parents=True)
    (root / "samples").mkdir()
    (root / "samples" / "a.wav").write_bytes(b"RIFF")
    mpath = root / "eval" / "manifests" / "m.json"
    _write(mpath, {"name": "t", "items": [
        {"id": "a", "audio": "samples/a.wav", "reference": "eval/data/missing.json"}]})
    with pytest.raises(FileNotFoundError):
        load_manifest(mpath, root=root)
