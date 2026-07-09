"""Persistent store for completed clinical notes (SQLite, project-local).

The DB lives INSIDE the project by default (git-ignored) so `rm -rf` the folder
still removes everything (ADR-0003). Override the location with STT_DB_PATH.
Uses only the stdlib `sqlite3` — no new dependency. A short-lived connection is
opened per call (check_same_thread is a non-issue) so the single-worker
transcription/note threads and the event-loop request handlers can all touch it
safely; SQLite's own locking serializes writes, which is plenty for one local
user (see specs/adr/0007, 0009).

Only *completed* notes are persisted — the in-memory NoteJobManager owns the
live/streaming lifecycle; this store is the durable history the UI browses.
"""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Default: apps/api/notes.db (sibling of the jobs/ scratch dir), git-ignored.
DB_PATH = Path(
    os.environ.get("STT_DB_PATH", Path(__file__).resolve().parents[2] / "notes.db")
)


def _parse_json_list(raw: Optional[str]) -> list:
    """Parse a JSON-array column to a list, or [] on absent/invalid/non-list."""
    if not raw:
        return []
    import json
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (ValueError, TypeError):
        return []


@dataclass
class SavedNote:
    id: str
    created_at: str            # ISO-8601 UTC
    title: str
    source_name: Optional[str]  # e.g. "HistoryTaking_YA" or an uploaded stem
    provider: str
    model: str
    template: str
    transcript: str
    note: str                  # the AI's ORIGINAL output — never overwritten (ADR-0015)
    # Timing metrics (seconds). transcribe_seconds is carried from the source
    # transcript (may be None for reused transcripts predating the feature);
    # note_seconds is the wall-clock note generation time. Both nullable.
    transcribe_seconds: Optional[float] = None
    note_seconds: Optional[float] = None
    # Edit/finalize lifecycle (ADR-0015). edited_note is the clinician's overlay
    # (NULL = untouched); status is draft|final; finalized_at stamps the sign-off.
    edited_note: Optional[str] = None
    status: str = "draft"
    finalized_at: Optional[str] = None
    # Patient this note is filed under (ADR-0016). NULL = unassigned.
    patient_id: Optional[str] = None
    # Source transcript turns as a JSON string [{speaker,text,start,end}] (ADR-0019).
    # NULL for notes made before this feature / from plain-text-only transcripts.
    transcript_json: Optional[str] = None
    # Encounter metadata captured up front (ADR-0022). Both optional/free-text.
    visit_type: Optional[str] = None
    chief_complaint: Optional[str] = None
    # Extracted structured lists as JSON strings (ADR-0023). NULL = not extracted.
    problems_json: Optional[str] = None
    medications_json: Optional[str] = None
    # Structured STT-review flags as a JSON string (ADR-0029): the located
    # [{quote, reason, category, turn_index, start, end, matched, resolved?}] of
    # suspect (likely mistranscribed) spans. NULL = not extracted / none.
    review_flags_json: Optional[str] = None

    @property
    def effective_note(self) -> str:
        """The current body: the clinician's edit if present, else the AI original."""
        return self.edited_note if self.edited_note is not None else self.note

    @property
    def edited(self) -> bool:
        return self.edited_note is not None

    @property
    def turns(self) -> list:
        """The source transcript turns (parsed from transcript_json), or []."""
        return _parse_json_list(self.transcript_json)

    @property
    def problems(self) -> list:
        """Extracted problem list (parsed from problems_json), or [] (ADR-0023)."""
        return _parse_json_list(self.problems_json)

    @property
    def medications(self) -> list:
        """Extracted medication list (parsed from medications_json), or []."""
        return _parse_json_list(self.medications_json)

    @property
    def extracted(self) -> bool:
        """Whether problem/medication extraction has been run (either list stored)."""
        return self.problems_json is not None or self.medications_json is not None

    @property
    def review_flags(self) -> list:
        """Located STT-review flags (parsed from review_flags_json), or [] (ADR-0029)."""
        return _parse_json_list(self.review_flags_json)

    def summary(self) -> dict:
        """List-view shape (no heavy transcript/note bodies)."""
        return {
            "id": self.id,
            "created_at": self.created_at,
            "title": self.title,
            "source_name": self.source_name,
            "provider": self.provider,
            "model": self.model,
            "template": self.template,
            "transcribe_seconds": self.transcribe_seconds,
            "note_seconds": self.note_seconds,
            "status": self.status,
            "finalized_at": self.finalized_at,
            "edited": self.edited,
            "patient_id": self.patient_id,
            "visit_type": self.visit_type,
            "chief_complaint": self.chief_complaint,
        }

    def to_dict(self) -> dict:
        d = self.summary()
        d["transcript"] = self.transcript
        # `note` is the effective (current) body so existing consumers keep
        # working; `ai_note` exposes the original for the revert/compare affordance.
        d["note"] = self.effective_note
        d["ai_note"] = self.note
        d["edited_note"] = self.edited_note
        d["review_flags"] = self.review_flags
        return d


@dataclass
class Patient:
    """A patient a note can be filed under (ADR-0016). `mrn` (hasta no / medical
    record number) is optional and free-form — this is a local single-doctor tool,
    not an EHR identity system."""
    id: str
    name: str
    mrn: Optional[str]
    created_at: str            # ISO-8601 UTC

    def to_dict(self, note_count: Optional[int] = None) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "mrn": self.mrn,
            "created_at": self.created_at,
        }
        if note_count is not None:
            d["note_count"] = note_count
        return d


class NoteStore:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS notes (
                    id          TEXT PRIMARY KEY,
                    created_at  TEXT NOT NULL,
                    title       TEXT NOT NULL,
                    source_name TEXT,
                    provider    TEXT NOT NULL,
                    model       TEXT NOT NULL,
                    template    TEXT NOT NULL,
                    transcript  TEXT NOT NULL,
                    note        TEXT NOT NULL,
                    transcribe_seconds REAL,
                    note_seconds       REAL
                )
                """
            )
            # Lightweight migration: add newer columns to a pre-existing table
            # (CREATE TABLE IF NOT EXISTS won't alter an older schema). Each ADD
            # is guarded by a column-existence check so it's safe to re-run.
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
            for col in ("transcribe_seconds", "note_seconds"):
                if col not in cols:
                    conn.execute(f"ALTER TABLE notes ADD COLUMN {col} REAL")
            # Edit/finalize lifecycle columns (ADR-0015).
            if "edited_note" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN edited_note TEXT")
            if "status" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'")
            if "finalized_at" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN finalized_at TEXT")
            # Patient organization (ADR-0016): patients table + a note→patient link.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS patients (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    mrn        TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            if "patient_id" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN patient_id TEXT")
            # Audio-linked source transcript (ADR-0019): the turns as JSON.
            if "transcript_json" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN transcript_json TEXT")
            # Encounter metadata (ADR-0022): visit type + chief complaint.
            if "visit_type" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN visit_type TEXT")
            if "chief_complaint" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN chief_complaint TEXT")
            # Extracted problem/medication lists (ADR-0023), JSON strings.
            if "problems_json" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN problems_json TEXT")
            if "medications_json" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN medications_json TEXT")
            # Structured STT-review flags (ADR-0029), located JSON string.
            if "review_flags_json" not in cols:
                conn.execute("ALTER TABLE notes ADD COLUMN review_flags_json TEXT")
            # Version history (ADR-0020): a snapshot of each prior note body.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS note_versions (
                    id        TEXT PRIMARY KEY,
                    note_id   TEXT NOT NULL,
                    seq       INTEGER NOT NULL,
                    body      TEXT NOT NULL,
                    saved_at  TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_note_versions_note "
                "ON note_versions(note_id, seq)"
            )
            # Custom note templates (ADR-0021): named, reusable sample formats.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS note_templates (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    body       TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

    def save(self, note: SavedNote) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO notes
                    (id, created_at, title, source_name, provider, model, template,
                     transcript, note, transcribe_seconds, note_seconds,
                     edited_note, status, finalized_at, patient_id, transcript_json,
                     visit_type, chief_complaint, problems_json, medications_json,
                     review_flags_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (note.id, note.created_at, note.title, note.source_name,
                 note.provider, note.model, note.template, note.transcript, note.note,
                 note.transcribe_seconds, note.note_seconds,
                 note.edited_note, note.status, note.finalized_at, note.patient_id,
                 note.transcript_json, note.visit_type, note.chief_complaint,
                 note.problems_json, note.medications_json, note.review_flags_json),
            )

    def list(self, patient_id: Optional[str] = None, q: Optional[str] = None) -> list[dict]:
        """Newest first, summary shape (no bodies). Optionally filter to one
        patient and/or a case-insensitive search query `q` matched against the
        title, patient name, or EFFECTIVE note body (edit if any, else AI —
        ADR-0018). Each row carries patient_id + patient_name (via a LEFT JOIN)."""
        sql = (
            "SELECT n.id, n.created_at, n.title, n.source_name, n.provider, n.model, "
            "n.template, n.transcribe_seconds, n.note_seconds, n.edited_note, "
            "n.status, n.finalized_at, n.patient_id, n.visit_type, n.chief_complaint, "
            "p.name AS patient_name "
            "FROM notes n LEFT JOIN patients p ON p.id = n.patient_id "
        )
        clauses: list = []
        params: list = []
        if patient_id is not None:
            clauses.append("n.patient_id = ?")
            params.append(patient_id)
        q = (q or "").strip()
        if q:
            like = f"%{q.lower()}%"
            # Match title, patient, effective body, chief complaint, visit type.
            clauses.append(
                "(lower(n.title) LIKE ? OR lower(COALESCE(p.name,'')) LIKE ? "
                "OR lower(COALESCE(n.edited_note, n.note)) LIKE ? "
                "OR lower(COALESCE(n.chief_complaint,'')) LIKE ? "
                "OR lower(COALESCE(n.visit_type,'')) LIKE ?)"
            )
            params.extend([like, like, like, like, like])
        if clauses:
            sql += "WHERE " + " AND ".join(clauses) + " "
        sql += "ORDER BY n.created_at DESC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        # Build explicitly so `edited` (edited_note != NULL) and the status fields
        # are consistent with get()/to_dict().
        out = []
        for r in rows:
            d = dict(r)
            out.append({
                "id": d["id"],
                "created_at": d["created_at"],
                "title": d["title"],
                "source_name": d["source_name"],
                "provider": d["provider"],
                "model": d["model"],
                "template": d["template"],
                "transcribe_seconds": d["transcribe_seconds"],
                "note_seconds": d["note_seconds"],
                "status": d["status"] or "draft",
                "finalized_at": d["finalized_at"],
                "edited": d["edited_note"] is not None,
                "patient_id": d["patient_id"],
                "patient_name": d["patient_name"],
                "visit_type": d["visit_type"],
                "chief_complaint": d["chief_complaint"],
            })
        return out

    def get(self, note_id: str) -> Optional[SavedNote]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM notes WHERE id = ?", (note_id,)
            ).fetchone()
        return SavedNote(**dict(row)) if row else None

    def delete(self, note_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            # Also drop the note's version history (ADR-0020).
            conn.execute("DELETE FROM note_versions WHERE note_id = ?", (note_id,))
        return cur.rowcount > 0

    # --- edit / finalize lifecycle (ADR-0015) + versioning (ADR-0020) --------

    def _snapshot_version(self, conn, note_id: str, body: str) -> None:
        """Append `body` as the next version for a note (ADR-0020). Uses the
        passed connection so it shares the caller's transaction."""
        import uuid
        from datetime import datetime, timezone
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM note_versions WHERE note_id = ?",
            (note_id,),
        ).fetchone()
        seq = (row["m"] if row else 0) + 1
        conn.execute(
            "INSERT INTO note_versions (id, note_id, seq, body, saved_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex[:12], note_id, seq, body,
             datetime.now(timezone.utc).isoformat()),
        )

    def update_body(self, note_id: str, edited: str) -> Optional[SavedNote]:
        """Save a clinician-edited body as an overlay (never touches `note`).
        Snapshots the PRIOR effective body as a version first, but only when the
        body actually changes (so autosave no-ops don't spam versions — ADR-0020).
        Returns None if the note is missing; raises NoteLockedError if it's final."""
        note = self.get(note_id)
        if not note:
            return None
        if note.status == "final":
            raise NoteLockedError("note is finalized; reopen it before editing")
        if edited == note.effective_note:
            return note  # no change — nothing to save or version
        with self._connect() as conn:
            self._snapshot_version(conn, note_id, note.effective_note)
            conn.execute(
                "UPDATE notes SET edited_note = ? WHERE id = ?", (edited, note_id)
            )
        note.edited_note = edited
        return note

    def revert(self, note_id: str) -> Optional[SavedNote]:
        """Clear the edit overlay so the effective body is the AI original again.
        Snapshots the pre-revert body so the discarded edits stay recoverable."""
        note = self.get(note_id)
        if not note:
            return None
        if note.status == "final":
            raise NoteLockedError("note is finalized; reopen it before reverting")
        if note.edited_note is None:
            return note  # already the AI original — nothing to do
        with self._connect() as conn:
            self._snapshot_version(conn, note_id, note.effective_note)
            conn.execute(
                "UPDATE notes SET edited_note = NULL WHERE id = ?", (note_id,)
            )
        note.edited_note = None
        return note

    def set_status(self, note_id: str, status: str, finalized_at: Optional[str]) -> Optional[SavedNote]:
        """Set draft/final + the finalize timestamp (None clears it on reopen).
        On FINALIZE, snapshots the finalized body as a version (ADR-0020)."""
        note = self.get(note_id)
        if not note:
            return None
        with self._connect() as conn:
            if status == "final" and note.status != "final":
                self._snapshot_version(conn, note_id, note.effective_note)
            conn.execute(
                "UPDATE notes SET status = ?, finalized_at = ? WHERE id = ?",
                (status, finalized_at, note_id),
            )
        note.status = status
        note.finalized_at = finalized_at
        return note

    def set_extraction(self, note_id: str, problems: list, medications: list) -> Optional[SavedNote]:
        """Persist extracted problem/medication lists on a note (ADR-0023).
        Overwrites any prior extraction. Returns None if the note is missing."""
        import json
        note = self.get(note_id)
        if not note:
            return None
        pj = json.dumps(problems or [], ensure_ascii=False)
        mj = json.dumps(medications or [], ensure_ascii=False)
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET problems_json = ?, medications_json = ? WHERE id = ?",
                (pj, mj, note_id),
            )
        note.problems_json = pj
        note.medications_json = mj
        return note

    def set_review_flags(self, note_id: str, flags: list) -> Optional[SavedNote]:
        """Persist located STT-review flags on a note (ADR-0029). Overwrites any
        prior flags. Returns None if the note is missing."""
        import json
        note = self.get(note_id)
        if not note:
            return None
        fj = json.dumps(flags or [], ensure_ascii=False)
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET review_flags_json = ? WHERE id = ?", (fj, note_id)
            )
        note.review_flags_json = fj
        return note

    def update_transcript_turn(self, note_id: str, turn_index: int, text: str
                               ) -> Optional[SavedNote]:
        """Correct a single transcript turn's text in place (ADR-0029) and, if a
        review flag pointed at that turn, mark it resolved so the UI can show it
        was verified. Corrects only the TURN text (the transcript), never the note
        body — the note stays the AI original + the clinician's separate note
        overlay (ADR-0015). Returns None if the note/turn is missing.

        This is how a doctor manually fixes an STT error against the audio: the
        corrected transcript is what feeds re-extraction and any future training
        corpus (a real, human-verified label)."""
        import json
        note = self.get(note_id)
        if not note:
            return None
        turns = note.turns
        if turn_index < 0 or turn_index >= len(turns):
            return None
        turns[turn_index] = {**turns[turn_index], "text": text, "corrected": True}
        tj = json.dumps(turns, ensure_ascii=False)
        # Mark any flag anchored to this turn as resolved (kept, not deleted, so the
        # doctor still sees what was reviewed).
        flags = note.review_flags
        changed = False
        for f in flags:
            if f.get("turn_index") == turn_index and not f.get("resolved"):
                f["resolved"] = True
                changed = True
        fj = json.dumps(flags, ensure_ascii=False) if changed else None
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET transcript_json = ? WHERE id = ?", (tj, note_id)
            )
            if fj is not None:
                conn.execute(
                    "UPDATE notes SET review_flags_json = ? WHERE id = ?", (fj, note_id)
                )
        note.transcript_json = tj
        if fj is not None:
            note.review_flags_json = fj
        return note

    def set_transcript_turns(self, note_id: str, turns: list) -> Optional[SavedNote]:
        """Replace the whole transcript-turns list (ADR-0030) — used to apply an
        LLM speaker RE-LABELING (doctor/patient roles). Replaces ONLY the transcript
        turns; never touches the note body. Returns None if the note is missing."""
        import json
        note = self.get(note_id)
        if not note:
            return None
        tj = json.dumps(turns or [], ensure_ascii=False)
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET transcript_json = ? WHERE id = ?", (tj, note_id)
            )
        note.transcript_json = tj
        return note

    # --- version history (ADR-0020) ------------------------------------------

    def list_versions(self, note_id: str) -> list[dict]:
        """A note's versions, newest first (metadata + body)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, note_id, seq, body, saved_at FROM note_versions "
                "WHERE note_id = ? ORDER BY seq DESC",
                (note_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def restore_version(self, note_id: str, version_id: str) -> Optional[SavedNote]:
        """Set a prior version's body as the current edited body (snapshotting the
        pre-restore body first, so restore is itself undoable). Returns None if the
        note or version is missing; raises NoteLockedError if the note is final."""
        note = self.get(note_id)
        if not note:
            return None
        if note.status == "final":
            raise NoteLockedError("note is finalized; reopen it before restoring")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT body FROM note_versions WHERE id = ? AND note_id = ?",
                (version_id, note_id),
            ).fetchone()
            if not row:
                return None
            target = row["body"]
            if target != note.effective_note:
                self._snapshot_version(conn, note_id, note.effective_note)
                conn.execute(
                    "UPDATE notes SET edited_note = ? WHERE id = ?", (target, note_id)
                )
        note.edited_note = target
        return note

    # --- custom note templates (ADR-0021) ------------------------------------

    def list_templates(self) -> list[dict]:
        """All custom templates, name order (id, name, body, created_at)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, body, created_at FROM note_templates "
                "ORDER BY lower(name)"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_template(self, template_id: str) -> Optional[dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, name, body, created_at FROM note_templates WHERE id = ?",
                (template_id,),
            ).fetchone()
        return dict(row) if row else None

    def create_template(self, name: str, body: str) -> dict:
        name = (name or "").strip()
        body = body or ""
        if not name:
            raise ValueError("template name is required")
        if not body.strip():
            raise ValueError("template body is required")
        import uuid
        from datetime import datetime, timezone
        tid = uuid.uuid4().hex[:12]
        created_at = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO note_templates (id, name, body, created_at) "
                "VALUES (?, ?, ?, ?)",
                (tid, name, body, created_at),
            )
        return {"id": tid, "name": name, "body": body, "created_at": created_at}

    def update_template(self, template_id: str, name: Optional[str],
                        body: Optional[str]) -> Optional[dict]:
        existing = self.get_template(template_id)
        if not existing:
            return None
        new_name = existing["name"] if name is None else name.strip()
        new_body = existing["body"] if body is None else body
        if not new_name:
            raise ValueError("template name is required")
        if not new_body.strip():
            raise ValueError("template body is required")
        with self._connect() as conn:
            conn.execute(
                "UPDATE note_templates SET name = ?, body = ? WHERE id = ?",
                (new_name, new_body, template_id),
            )
        return {**existing, "name": new_name, "body": new_body}

    def delete_template(self, template_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM note_templates WHERE id = ?", (template_id,)
            )
        return cur.rowcount > 0

    # --- patient organization (ADR-0016) -------------------------------------

    def create_patient(self, name: str, mrn: Optional[str] = None) -> Patient:
        """Create a patient, REUSING an existing one with the same (trimmed,
        case-insensitive) name so visits don't duplicate the patient."""
        name = (name or "").strip()
        if not name:
            raise ValueError("patient name is required")
        existing = self.find_patient_by_name(name)
        if existing:
            # Fill in an MRN if the caller supplied one and the row lacked it.
            if mrn and not existing.mrn:
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE patients SET mrn = ? WHERE id = ?", (mrn, existing.id)
                    )
                existing.mrn = mrn
            return existing
        import uuid
        from datetime import datetime, timezone
        pid = uuid.uuid4().hex[:12]
        created_at = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO patients (id, name, mrn, created_at) VALUES (?, ?, ?, ?)",
                (pid, name, mrn or None, created_at),
            )
        return Patient(id=pid, name=name, mrn=mrn or None, created_at=created_at)

    def find_patient_by_name(self, name: str) -> Optional[Patient]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM patients WHERE lower(trim(name)) = lower(trim(?))",
                (name,),
            ).fetchone()
        return Patient(**dict(row)) if row else None

    def get_patient(self, patient_id: str) -> Optional[Patient]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM patients WHERE id = ?", (patient_id,)
            ).fetchone()
        return Patient(**dict(row)) if row else None

    def list_patients(self) -> list[dict]:
        """All patients (name order) with each one's note count + last-visit date
        (max note created_at), for the patient list (ADR-0024)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT p.id, p.name, p.mrn, p.created_at, "
                "COUNT(n.id) AS note_count, MAX(n.created_at) AS last_visit_at "
                "FROM patients p LEFT JOIN notes n ON n.patient_id = p.id "
                "GROUP BY p.id ORDER BY lower(p.name)"
            ).fetchall()
        return [dict(r) for r in rows]

    def patient_rollup(self, patient_id: str) -> tuple[list, list]:
        """The de-duplicated UNION of extracted problems + medications across a
        patient's notes (ADR-0024). Pure aggregation over stored extractions — no
        model call. De-dup by normalized (case-folded, trimmed) name; first
        occurrence wins (keeps its detail). Empty when no note has extractions."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT problems_json, medications_json FROM notes "
                "WHERE patient_id = ? ORDER BY created_at DESC",
                (patient_id,),
            ).fetchall()

        def merge(field: str) -> list:
            seen: dict = {}
            for r in rows:
                for item in _parse_json_list(r[field]):
                    if not isinstance(item, dict):
                        continue
                    name = str(item.get("name") or "").strip()
                    if not name:
                        continue
                    key = name.casefold()
                    if key not in seen:
                        seen[key] = item
            return list(seen.values())

        return merge("problems_json"), merge("medications_json")

    def set_note_patient(self, note_id: str, patient_id: Optional[str]) -> Optional[SavedNote]:
        """(Re)file a note under a patient, or clear it (patient_id=None). Allowed
        even when the note is final — filing is metadata, not content (REQ-139).
        Returns None if the note is missing; ValueError if patient_id is unknown."""
        note = self.get(note_id)
        if not note:
            return None
        if patient_id is not None and not self.get_patient(patient_id):
            raise ValueError(f"patient '{patient_id}' not found")
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET patient_id = ? WHERE id = ?", (patient_id, note_id)
            )
        note.patient_id = patient_id
        return note

    def patient_name(self, patient_id: Optional[str]) -> Optional[str]:
        if not patient_id:
            return None
        p = self.get_patient(patient_id)
        return p.name if p else None


class NoteLockedError(RuntimeError):
    """Raised when an edit/revert is attempted on a finalized note (ADR-0015)."""


# Default: apps/api/note_audio/ (sibling of notes.db + jobs/), git-ignored.
NOTE_AUDIO_DIR = Path(
    os.environ.get(
        "STT_NOTE_AUDIO_DIR", Path(__file__).resolve().parents[2] / "note_audio"
    )
)


class NoteAudioStore:
    """Durable, note-keyed store for a note's source audio (ADR-0019).

    The source recording lives in ephemeral job scratch (apps/api/jobs/…); we copy
    it here at note-persist time keyed by note id so the link survives cleanup. The
    dir is project-local + git-ignored (PHI never committed; `rm -rf` cleans up —
    ADR-0003/0010). Filenames are ALWAYS `<note_id>.<ext>` with the note id
    validated as hex — no caller-controlled path component, so no traversal."""

    def __init__(self, audio_dir: Path = NOTE_AUDIO_DIR):
        self.audio_dir = Path(audio_dir)
        self.audio_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _safe_id(note_id: str) -> str:
        """Note ids are uuid4().hex[:12] (hex). Accept only alphanumerics so a bad
        id (path separators, dots, traversal) can never escape the store dir. Kept
        a touch broader than strict hex so it's robust to any future id scheme."""
        nid = (note_id or "").strip().lower()
        if not nid or not nid.isalnum() or not nid.isascii():
            raise ValueError(f"invalid note id: {note_id!r}")
        return nid

    def save_from(self, note_id: str, source: Path) -> Optional[Path]:
        """Copy `source` audio into the store as <note_id><suffix>. Best-effort:
        returns the stored path, or None if the source is missing/unreadable
        (a cleaned scratch dir just means the note has no audio — never raises for
        that). Removes any prior audio for this note first (one file per note)."""
        nid = self._safe_id(note_id)
        source = Path(source)
        if not source.is_file():
            return None
        suffix = source.suffix.lower() or ".bin"
        self.delete(note_id)  # keep exactly one audio file per note
        dest = self.audio_dir / f"{nid}{suffix}"
        try:
            import shutil
            shutil.copyfile(source, dest)
            return dest
        except OSError:
            return None

    def path(self, note_id: str) -> Optional[Path]:
        """The stored audio file for a note (any extension), or None."""
        try:
            nid = self._safe_id(note_id)
        except ValueError:
            return None
        matches = sorted(self.audio_dir.glob(f"{nid}.*"))
        return matches[0] if matches else None

    def delete(self, note_id: str) -> bool:
        """Remove a note's stored audio (all extensions). Returns True if any."""
        try:
            nid = self._safe_id(note_id)
        except ValueError:
            return False
        removed = False
        for p in self.audio_dir.glob(f"{nid}.*"):
            try:
                p.unlink()
                removed = True
            except OSError:
                pass
        return removed
