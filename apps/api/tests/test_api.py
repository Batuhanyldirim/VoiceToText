"""API endpoint tests via FastAPI TestClient (temp DB, no ML models).

Covers the note edit/finalize lifecycle endpoints (ADR-0015) and the patient
organization endpoints (ADR-0016), including status codes. Generation endpoints
(/notes POST, transcription, streaming) are NOT exercised here — they need the
models and stay under the behavioral gate.
"""
from __future__ import annotations


def _seed_note(client, note_id="n1", note="# Not\ngövde", **extra):
    """Persist a note directly via the app's store (bypasses generation)."""
    import stt_api.main as main
    from stt_api.store import SavedNote

    defaults = dict(
        id=note_id, created_at="2026-07-08T00:00:00Z", title="Test",
        source_name=None, provider="ollama", model="qwen", template="soap",
        transcript="tx", note=note,
    )
    defaults.update(extra)
    main.note_store.save(SavedNote(**defaults))


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


# --- note edit / finalize lifecycle ----------------------------------------

def test_get_note_serves_effective_body(client):
    _seed_note(client, note="AI ORIGINAL")
    r = client.get("/notes/n1")
    assert r.status_code == 200
    body = r.json()
    assert body["note"] == "AI ORIGINAL"
    assert body["ai_note"] == "AI ORIGINAL"
    assert body["note_status"] == "draft"
    assert body["edited"] is False


def test_patch_edits_note(client):
    _seed_note(client, note="AI ORIGINAL")
    r = client.patch("/notes/n1", json={"note": "DOCTOR EDIT"})
    assert r.status_code == 200
    body = r.json()
    assert body["note"] == "DOCTOR EDIT"     # effective body
    assert body["ai_note"] == "AI ORIGINAL"  # original preserved
    assert body["edited"] is True


def test_finalize_then_patch_conflicts(client):
    _seed_note(client)
    assert client.post("/notes/n1/finalize").status_code == 200
    assert client.get("/notes/n1").json()["note_status"] == "final"
    # editing a final note is a 409
    r = client.patch("/notes/n1", json={"note": "blocked"})
    assert r.status_code == 409


def test_reopen_then_edit(client):
    _seed_note(client)
    client.post("/notes/n1/finalize")
    assert client.post("/notes/n1/reopen").status_code == 200
    assert client.get("/notes/n1").json()["note_status"] == "draft"
    assert client.patch("/notes/n1", json={"note": "ok now"}).status_code == 200


def test_revert_endpoint(client):
    _seed_note(client, note="AI ORIGINAL")
    client.patch("/notes/n1", json={"note": "EDIT"})
    r = client.post("/notes/n1/revert")
    assert r.status_code == 200
    assert r.json()["note"] == "AI ORIGINAL" and r.json()["edited"] is False


def test_lifecycle_endpoints_404_on_unknown(client):
    assert client.patch("/notes/nope", json={"note": "x"}).status_code == 404
    assert client.post("/notes/nope/finalize").status_code == 404
    assert client.post("/notes/nope/reopen").status_code == 404
    assert client.post("/notes/nope/revert").status_code == 404


# --- patient organization --------------------------------------------------

def test_create_and_list_patients(client):
    r = client.post("/patients", json={"name": "Ayşe Demir", "mrn": "A-100"})
    assert r.status_code == 201
    pid = r.json()["id"]
    # reuse by name (different case) -> same id, still one patient
    r2 = client.post("/patients", json={"name": "ayşe demir"})
    assert r2.json()["id"] == pid
    patients = client.get("/patients").json()["patients"]
    assert len(patients) == 1 and patients[0]["note_count"] == 0


def test_create_patient_requires_name(client):
    assert client.post("/patients", json={"name": "  "}).status_code == 400


def test_assign_note_to_patient_flow(client):
    _seed_note(client, "n1")
    _seed_note(client, "n2")
    pid = client.post("/patients", json={"name": "Ayşe"}).json()["id"]
    # assign n1
    r = client.put("/notes/n1/patient", json={"patient_id": pid})
    assert r.status_code == 200
    assert r.json()["patient_id"] == pid and r.json()["patient_name"] == "Ayşe"
    # filter notes by patient
    filtered = client.get(f"/notes?patient_id={pid}").json()["notes"]
    assert [n["id"] for n in filtered] == ["n1"]
    # unassigned notes carry patient_name None
    all_notes = {n["id"]: n for n in client.get("/notes").json()["notes"]}
    assert all_notes["n2"]["patient_name"] is None
    # patient detail returns the patient + its notes
    detail = client.get(f"/patients/{pid}").json()
    assert detail["name"] == "Ayşe" and [n["id"] for n in detail["notes"]] == ["n1"]
    # note_count updated
    assert client.get("/patients").json()["patients"][0]["note_count"] == 1


def test_reassign_patient_allowed_when_final(client):
    _seed_note(client, "n1")
    pid = client.post("/patients", json={"name": "Ayşe"}).json()["id"]
    client.put("/notes/n1/patient", json={"patient_id": pid})
    client.post("/notes/n1/finalize")
    # filing is metadata — still allowed on a final note (REQ-139)
    r = client.put("/notes/n1/patient", json={"patient_id": None})
    assert r.status_code == 200 and r.json()["patient_id"] is None


def test_assign_unknown_patient_400(client):
    _seed_note(client, "n1")
    r = client.put("/notes/n1/patient", json={"patient_id": "does-not-exist"})
    assert r.status_code == 400


def test_get_unknown_patient_404(client):
    assert client.get("/patients/nope").status_code == 404


# --- search (ADR-0018) ------------------------------------------------------

def test_search_endpoint(client):
    _seed_note(client, "n1", note="hasta öksürüyor", title="Öksürük")
    _seed_note(client, "n2", note="tansiyon", title="Kontrol")
    # body/title substring, case-insensitive
    r = client.get("/notes", params={"q": "öksür"}).json()["notes"]
    assert [n["id"] for n in r] == ["n1"]
    r = client.get("/notes", params={"q": "KONTROL"}).json()["notes"]
    assert [n["id"] for n in r] == ["n2"]
    # blank q returns all
    assert len(client.get("/notes", params={"q": ""}).json()["notes"]) == 2


def test_search_composes_with_patient_filter_endpoint(client):
    _seed_note(client, "n1", note="öksürük")
    _seed_note(client, "n2", note="öksürük")
    pid = client.post("/patients", json={"name": "Ayşe"}).json()["id"]
    client.put("/notes/n1/patient", json={"patient_id": pid})
    r = client.get("/notes", params={"q": "öksürük", "patient_id": pid}).json()["notes"]
    assert [n["id"] for n in r] == ["n1"]


# --- autosave + version history (ADR-0020) ----------------------------------

def test_versions_endpoint_and_restore(client):
    _seed_note(client, "n1", note="AI ORIGINAL")
    client.patch("/notes/n1", json={"note": "edit A"})
    client.patch("/notes/n1", json={"note": "edit B"})
    versions = client.get("/notes/n1/versions").json()["versions"]
    assert [v["body"] for v in versions] == ["edit A", "AI ORIGINAL"]
    # restore the oldest (AI ORIGINAL)
    oldest = versions[-1]
    r = client.post("/notes/n1/restore", json={"version_id": oldest["id"]})
    assert r.status_code == 200
    assert r.json()["note"] == "AI ORIGINAL"


def test_versions_empty_for_unedited_note(client):
    _seed_note(client, "n1")
    assert client.get("/notes/n1/versions").json()["versions"] == []


def test_restore_404_unknown_version(client):
    _seed_note(client, "n1")
    assert client.post("/notes/n1/restore", json={"version_id": "nope"}).status_code == 404


def test_restore_409_when_final(client):
    _seed_note(client, "n1", note="AI ORIGINAL")
    client.patch("/notes/n1", json={"note": "edit A"})
    vid = client.get("/notes/n1/versions").json()["versions"][0]["id"]
    client.post("/notes/n1/finalize")
    assert client.post("/notes/n1/restore", json={"version_id": vid}).status_code == 409


# --- custom note templates (ADR-0021) --------------------------------------

def test_custom_template_crud(client):
    # create
    r = client.post("/note-templates", json={"name": "Kardiyoloji", "body": "# K\n## Şikayet\n"})
    assert r.status_code == 201
    tid = r.json()["id"]
    # list
    assert [t["name"] for t in client.get("/note-templates").json()["templates"]] == ["Kardiyoloji"]
    # update
    r = client.put(f"/note-templates/{tid}", json={"name": "Kardiyoloji Kontrol"})
    assert r.status_code == 200 and r.json()["name"] == "Kardiyoloji Kontrol"
    assert r.json()["body"].startswith("# K")  # body preserved
    # delete
    assert client.delete(f"/note-templates/{tid}").status_code == 200
    assert client.get("/note-templates").json()["templates"] == []


def test_custom_template_validation_and_404(client):
    assert client.post("/note-templates", json={"name": "", "body": "x"}).status_code == 400
    assert client.post("/note-templates", json={"name": "n", "body": " "}).status_code == 400
    assert client.put("/note-templates/nope", json={"name": "x"}).status_code == 404
    assert client.delete("/note-templates/nope").status_code == 404


def test_generate_with_unknown_custom_template_400(client):
    # POST /notes with a bogus custom:<id> must be rejected up front (resolution
    # happens server-side before any generation).
    r = client.post("/notes", json={
        "transcript": "Doktor: ...\nHasta: ...",
        "template": "custom:does-not-exist",
    })
    assert r.status_code == 400


def test_custom_templates_appear_in_notes_templates(client):
    r = client.post("/note-templates", json={"name": "Pediatri", "body": "# P\n"})
    tid = r.json()["id"]
    templates = client.get("/notes/templates").json()["templates"]
    keys = [t["key"] for t in templates]
    # built-ins + custom + free all present; custom uses the custom:<id> key
    assert "soap" in keys and "free" in keys
    assert f"custom:{tid}" in keys
    custom = next(t for t in templates if t["key"] == f"custom:{tid}")
    assert custom["label"] == "Pediatri" and custom.get("custom") is True


# --- audio-linked source transcript (ADR-0019) ------------------------------

def _seed_note_with_turns(client, note_id="n1"):
    import json
    import stt_api.main as main
    from stt_api.store import SavedNote

    turns = [
        {"speaker": "Speaker 1", "text": "merhaba", "start": 0.0, "end": 1.0},
        {"speaker": "Speaker 2", "text": "iyi günler", "start": 1.0, "end": 2.0},
    ]
    main.note_store.save(SavedNote(
        id=note_id, created_at="2026-07-08T00:00:00Z", title="Test", source_name=None,
        provider="ollama", model="q", template="soap", transcript="tx", note="# Not",
        transcript_json=json.dumps(turns),
    ))
    return turns


def test_get_note_returns_turns_and_has_audio_flag(client):
    turns = _seed_note_with_turns(client, "n1")
    body = client.get("/notes/n1").json()
    assert body["turns"] == turns
    assert body["has_audio"] is False  # no audio stored yet


def test_note_audio_404_when_absent(client):
    _seed_note_with_turns(client, "n1")
    assert client.get("/notes/n1/audio").status_code == 404


def test_note_audio_served_and_deleted_with_note(client):
    import stt_api.main as main
    _seed_note_with_turns(client, "n1")
    # Place a source audio file via the (temp) audio store, as the worker would.
    src = main.note_audio_store.audio_dir.parent / "src.wav"
    src.write_bytes(b"RIFF0000WAVEfake-audio-bytes")
    main.note_audio_store.save_from("n1", src)

    # has_audio now true; the audio streams
    assert client.get("/notes/n1").json()["has_audio"] is True
    r = client.get("/notes/n1/audio")
    assert r.status_code == 200
    assert r.content == b"RIFF0000WAVEfake-audio-bytes"
    assert "audio/wav" in r.headers.get("content-type", "")

    # deleting the note removes the audio too
    assert client.delete("/notes/n1").status_code == 200
    assert main.note_audio_store.path("n1") is None
    assert client.get("/notes/n1/audio").status_code == 404


def test_notes_without_turns_have_empty_turns(client):
    _seed_note(client, "n1", note="# Not")  # no transcript_json
    body = client.get("/notes/n1").json()
    assert body["turns"] == []
    assert body["has_audio"] is False
