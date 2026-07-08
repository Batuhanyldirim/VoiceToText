"""Shared pytest fixtures for the store + API tests (ADR-0017).

These tests exercise the pure Python layer — SQLite store logic and the FastAPI
note/patient endpoints — with a TEMP database and NO ML models loaded, so the
whole suite runs in seconds. The transcription/diarization pipeline itself stays
covered by the behavioral gate (models are too slow/nondeterministic to unit-test).

Isolation: each test gets its own temp DB. The `store` fixture is a plain
NoteStore on a tmp path; the `client` fixture imports the app once and REBINDS
its note_store singleton to a temp-DB NoteStore (see the fixture for why we rebind
rather than reload the module). The real notes.db is never touched.
"""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def store(tmp_path: Path):
    """A NoteStore backed by a fresh temp DB (no app / no server)."""
    from stt_api.store import NoteStore

    return NoteStore(tmp_path / "notes.db")


@pytest.fixture()
def client(tmp_path: Path):
    """A FastAPI TestClient whose store points at a TEMP DB.

    stt_api.main builds `note_store = NoteStore()` at import time, bound to the
    real DB_PATH. Rather than RELOAD the modules (which duplicates store.py's
    classes — e.g. two distinct NoteLockedError types — and breaks
    `pytest.raises`), we import the app once and REBIND its store singleton to a
    fresh NoteStore on a temp DB. This keeps one module identity across the whole
    suite and never touches the real notes.db."""
    from fastapi.testclient import TestClient

    import stt_api.main as main
    from stt_api.store import NoteStore  # single, canonical class identity

    temp_db = tmp_path / "notes.db"
    main.note_store = NoteStore(temp_db)
    # The note manager persists completed notes through the store — point it at
    # the temp store too so any (future) generation test can't escape.
    main.note_manager._store = main.note_store

    # Belt-and-suspenders: refuse to run if we're somehow on a real project DB.
    assert str(tmp_path) in str(main.note_store.db_path), (
        f"test store escaped to {main.note_store.db_path!r} — refusing to run"
    )

    with TestClient(main.app) as c:
        yield c


def make_saved_note(store, note_id: str = "n1", note: str = "# Not\ngövde", **kw):
    """Helper: persist a SavedNote directly (bypasses generation)."""
    from stt_api.store import SavedNote

    defaults = dict(
        id=note_id,
        created_at="2026-07-08T00:00:00Z",
        title="Test",
        source_name=None,
        provider="ollama",
        model="qwen",
        template="soap",
        transcript="Doktor: ...\nHasta: ...",
        note=note,
    )
    defaults.update(kw)
    saved = SavedNote(**defaults)
    store.save(saved)
    return saved
