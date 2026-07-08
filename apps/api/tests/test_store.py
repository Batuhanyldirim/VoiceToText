"""Store-layer tests: note edit/finalize lifecycle (ADR-0015), patient
organization (ADR-0016), and schema migration safety (ADR-0010)."""
from __future__ import annotations

import sqlite3

import pytest

from stt_api.store import NoteLockedError, NoteStore, SavedNote
from conftest import make_saved_note


# --- note edit / finalize lifecycle (ADR-0015) -----------------------------

def test_edit_is_an_overlay_ai_original_preserved(store):
    make_saved_note(store, note="AI ORIGINAL")
    store.update_body("n1", "DOCTOR EDIT")
    n = store.get("n1")
    assert n.effective_note == "DOCTOR EDIT"   # effective body is the edit
    assert n.note == "AI ORIGINAL"             # AI original untouched
    assert n.edited is True


def test_revert_clears_overlay(store):
    make_saved_note(store, note="AI ORIGINAL")
    store.update_body("n1", "EDIT")
    store.revert("n1")
    n = store.get("n1")
    assert n.effective_note == "AI ORIGINAL"
    assert n.edited is False


def test_finalize_locks_edits(store):
    make_saved_note(store)
    store.set_status("n1", "final", "2026-07-08T01:00:00Z")
    n = store.get("n1")
    assert n.status == "final" and n.finalized_at
    with pytest.raises(NoteLockedError):
        store.update_body("n1", "should fail")
    with pytest.raises(NoteLockedError):
        store.revert("n1")


def test_reopen_returns_to_draft(store):
    make_saved_note(store)
    store.set_status("n1", "final", "2026-07-08T01:00:00Z")
    store.set_status("n1", "draft", None)
    n = store.get("n1")
    assert n.status == "draft" and n.finalized_at is None
    store.update_body("n1", "now allowed")  # editable again
    assert store.get("n1").effective_note == "now allowed"


def test_update_body_missing_note_returns_none(store):
    assert store.update_body("nope", "x") is None


def test_list_reports_status_and_edited(store):
    make_saved_note(store, "n1")
    make_saved_note(store, "n2")
    store.update_body("n2", "edited")
    rows = {r["id"]: r for r in store.list()}
    assert rows["n1"]["edited"] is False and rows["n1"]["status"] == "draft"
    assert rows["n2"]["edited"] is True


# --- patient organization (ADR-0016) ---------------------------------------

def test_create_patient_and_reuse_by_name(store):
    p = store.create_patient("Ayşe Demir", mrn="A-100")
    assert p.name == "Ayşe Demir" and p.mrn == "A-100"
    # Same name, different case/whitespace -> reuse the SAME row (no duplicate).
    p2 = store.create_patient("  ayşe demir ")
    assert p2.id == p.id
    assert len(store.list_patients()) == 1


def test_create_patient_backfills_mrn_on_reuse(store):
    p = store.create_patient("Ali")          # no mrn
    p2 = store.create_patient("Ali", mrn="M-9")
    assert p2.id == p.id and store.get_patient(p.id).mrn == "M-9"


def test_create_patient_requires_name(store):
    with pytest.raises(ValueError):
        store.create_patient("   ")


def test_assign_note_to_patient_and_filter(store):
    make_saved_note(store, "n1")
    make_saved_note(store, "n2")
    p = store.create_patient("Ayşe")
    store.set_note_patient("n1", p.id)
    # note carries patient_id; list join carries patient_name
    assert store.get("n1").patient_id == p.id
    row_n1 = next(r for r in store.list() if r["id"] == "n1")
    assert row_n1["patient_name"] == "Ayşe"
    # filter to the patient returns only their notes
    assert [r["id"] for r in store.list(patient_id=p.id)] == ["n1"]
    # note_count reflects the assignment
    assert store.list_patients()[0]["note_count"] == 1


def test_reassign_allowed_when_final(store):
    """Filing is metadata, not content — allowed even on a finalized note (REQ-139)."""
    make_saved_note(store, "n1")
    p = store.create_patient("Ayşe")
    store.set_note_patient("n1", p.id)
    store.set_status("n1", "final", "2026-07-08T01:00:00Z")
    # clearing / reassigning must still work (no NoteLockedError)
    assert store.set_note_patient("n1", None) is not None
    assert store.get("n1").patient_id is None


def test_assign_unknown_patient_rejected(store):
    make_saved_note(store, "n1")
    with pytest.raises(ValueError):
        store.set_note_patient("n1", "does-not-exist")


def test_assign_missing_note_returns_none(store):
    p = store.create_patient("Ayşe")
    assert store.set_note_patient("nope", p.id) is None


# --- migration safety (ADR-0010/0015/0016) ---------------------------------

def test_migration_adds_columns_without_data_loss(tmp_path):
    """An OLD-schema DB (no lifecycle / patient columns) migrates cleanly."""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute(
        """CREATE TABLE notes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        title TEXT NOT NULL, source_name TEXT, provider TEXT NOT NULL,
        model TEXT NOT NULL, template TEXT NOT NULL, transcript TEXT NOT NULL,
        note TEXT NOT NULL)"""
    )
    conn.execute(
        "INSERT INTO notes (id,created_at,title,provider,model,template,transcript,note) "
        "VALUES ('old1','2026-01-01T00:00:00Z','Old','ollama','q','soap','tx','OLD NOTE')"
    )
    conn.commit()
    conn.close()

    store = NoteStore(db)  # runs the migration
    n = store.get("old1")
    assert n is not None
    assert n.note == "OLD NOTE"          # data preserved
    assert n.status == "draft"           # sensible default
    assert n.patient_id is None          # unassigned
    # and the migrated note is fully usable
    store.update_body("old1", "edited")
    p = store.create_patient("Yeni")
    store.set_note_patient("old1", p.id)
    assert store.get("old1").patient_id == p.id
