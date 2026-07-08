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


# --- search (ADR-0018) ------------------------------------------------------

def test_search_matches_title_patient_and_body(store):
    make_saved_note(store, "n1", title="Öksürük muayenesi", note="hasta öksürüyor")
    make_saved_note(store, "n2", title="Kontrol", note="tansiyon normal")
    make_saved_note(store, "n3", title="Diğer", note="baş ağrısı şikayeti")
    p = store.create_patient("Ahmet Yılmaz")
    store.set_note_patient("n2", p.id)

    # body match
    assert {r["id"] for r in store.list(q="öksür")} == {"n1"}
    # title match (case-insensitive)
    assert {r["id"] for r in store.list(q="KONTROL")} == {"n2"}
    # patient-name match
    assert {r["id"] for r in store.list(q="yılmaz")} == {"n2"}
    # no match
    assert store.list(q="zzz-nope") == []


def test_search_uses_effective_body(store):
    make_saved_note(store, "n1", note="AI original text")
    # the edit introduces a new word; search should hit the EFFECTIVE body
    store.update_body("n1", "clinician replaced with pnömoni")
    assert {r["id"] for r in store.list(q="pnömoni")} == {"n1"}
    # the old AI-only word no longer matches the effective body
    assert store.list(q="original") == []


def test_search_composes_with_patient_filter(store):
    make_saved_note(store, "n1", note="öksürük")
    make_saved_note(store, "n2", note="öksürük")
    p = store.create_patient("Ayşe")
    store.set_note_patient("n1", p.id)
    # both notes match the query, but only n1 is the patient's
    assert {r["id"] for r in store.list(patient_id=p.id, q="öksürük")} == {"n1"}


def test_search_blank_returns_all(store):
    make_saved_note(store, "n1")
    make_saved_note(store, "n2")
    assert len(store.list(q="")) == 2
    assert len(store.list(q="   ")) == 2


# --- custom note templates (ADR-0021) --------------------------------------

def test_template_crud(store):
    t = store.create_template("Kardiyoloji", "# K\n## Şikayet\n")
    assert t["name"] == "Kardiyoloji" and t["id"]
    assert [x["name"] for x in store.list_templates()] == ["Kardiyoloji"]
    # update name only keeps body
    u = store.update_template(t["id"], name="Kardiyo Kontrol", body=None)
    assert u["name"] == "Kardiyo Kontrol" and u["body"].startswith("# K")
    assert store.get_template(t["id"])["name"] == "Kardiyo Kontrol"
    assert store.delete_template(t["id"]) is True
    assert store.list_templates() == []


def test_template_validation(store):
    with pytest.raises(ValueError):
        store.create_template("", "body")
    with pytest.raises(ValueError):
        store.create_template("name", "   ")
    assert store.update_template("nope", "x", "y") is None
    assert store.delete_template("nope") is False


# --- autosave + version history (ADR-0020) ----------------------------------

def test_edits_snapshot_prior_body_as_versions(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")
    store.update_body("n1", "edit B")
    versions = store.list_versions("n1")
    # newest first: snapshot of "edit A" (taken before edit B), then "AI ORIGINAL".
    assert [v["body"] for v in versions] == ["edit A", "AI ORIGINAL"]
    assert versions[0]["seq"] > versions[1]["seq"]


def test_noop_save_does_not_create_version(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")
    assert len(store.list_versions("n1")) == 1
    store.update_body("n1", "edit A")  # identical → no new version
    assert len(store.list_versions("n1")) == 1


def test_restore_sets_body_and_is_itself_versioned(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")   # v: AI ORIGINAL
    store.update_body("n1", "edit B")   # v: edit A
    oldest = store.list_versions("n1")[-1]  # AI ORIGINAL
    store.restore_version("n1", oldest["id"])
    assert store.get("n1").effective_note == "AI ORIGINAL"
    # pre-restore body ("edit B") was snapshotted → 3 versions now
    assert len(store.list_versions("n1")) == 3


def test_finalize_snapshots_and_restore_blocked_when_final(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")
    n_before = len(store.list_versions("n1"))
    store.set_status("n1", "final", "2026-07-08T01:00:00Z")
    assert len(store.list_versions("n1")) == n_before + 1  # finalized body snapshotted
    v = store.list_versions("n1")[0]
    with pytest.raises(NoteLockedError):
        store.restore_version("n1", v["id"])


def test_revert_snapshots_discarded_edits(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")
    store.revert("n1")
    assert store.get("n1").effective_note == "AI ORIGINAL"
    # both the AI-original (pre-edit) and "edit A" (pre-revert) are recoverable
    bodies = [v["body"] for v in store.list_versions("n1")]
    assert "edit A" in bodies and "AI ORIGINAL" in bodies


def test_delete_removes_versions(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    store.update_body("n1", "edit A")
    assert len(store.list_versions("n1")) == 1
    store.delete("n1")
    assert store.list_versions("n1") == []


def test_restore_unknown_version_returns_none(store):
    make_saved_note(store, "n1", note="AI ORIGINAL")
    assert store.restore_version("n1", "no-such-version") is None


# --- audio-linked source transcript (ADR-0019) ------------------------------

def test_transcript_json_persists_and_parses(store):
    import json
    turns = [
        {"speaker": "Speaker 1", "text": "merhaba", "start": 0.0, "end": 1.2},
        {"speaker": "Speaker 2", "text": "iyi günler", "start": 1.2, "end": 2.5},
    ]
    make_saved_note(store, "n1", transcript_json=json.dumps(turns))
    n = store.get("n1")
    assert n.turns == turns
    assert len(n.turns) == 2 and n.turns[0]["speaker"] == "Speaker 1"


def test_turns_empty_when_no_json_or_bad_json(store):
    make_saved_note(store, "n1")  # no transcript_json
    assert store.get("n1").turns == []
    make_saved_note(store, "n2", transcript_json="{not valid json")
    assert store.get("n2").turns == []


def test_note_audio_store_save_path_delete(tmp_path):
    from stt_api.store import NoteAudioStore
    astore = NoteAudioStore(tmp_path / "note_audio")
    src = tmp_path / "input.webm"
    src.write_bytes(b"OggS-fake-audio")
    dest = astore.save_from("abc123", src)
    assert dest is not None and dest.suffix == ".webm"
    assert astore.path("abc123") == dest
    assert astore.delete("abc123") is True
    assert astore.path("abc123") is None


def test_note_audio_store_missing_source_is_none(tmp_path):
    from stt_api.store import NoteAudioStore
    astore = NoteAudioStore(tmp_path / "note_audio")
    assert astore.save_from("abc123", tmp_path / "nope.wav") is None


def test_note_audio_store_rejects_bad_id(tmp_path):
    from stt_api.store import NoteAudioStore
    astore = NoteAudioStore(tmp_path / "note_audio")
    src = tmp_path / "a.wav"
    src.write_bytes(b"x")
    # Reject anything with path separators, dots, traversal, or spaces — the
    # things that could escape the store dir. (Plain alphanumerics are fine.)
    for bad in ["../evil", "a/b", "abc.def", "", "  ", "a b", "a\\b"]:
        with pytest.raises(ValueError):
            astore.save_from(bad, src)
    # path()/delete() of a bad id are safe no-ops (not exceptions)
    assert astore.path("../evil") is None
    assert astore.delete("../evil") is False


def test_note_audio_store_one_file_per_note(tmp_path):
    """Saving a second time replaces the prior audio (one file per note)."""
    from stt_api.store import NoteAudioStore
    astore = NoteAudioStore(tmp_path / "note_audio")
    (tmp_path / "a.wav").write_bytes(b"one")
    (tmp_path / "b.webm").write_bytes(b"two")
    astore.save_from("abc123", tmp_path / "a.wav")
    astore.save_from("abc123", tmp_path / "b.webm")
    matches = list((tmp_path / "note_audio").glob("abc123.*"))
    assert len(matches) == 1 and matches[0].suffix == ".webm"


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
