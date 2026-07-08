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

    @property
    def effective_note(self) -> str:
        """The current body: the clinician's edit if present, else the AI original."""
        return self.edited_note if self.edited_note is not None else self.note

    @property
    def edited(self) -> bool:
        return self.edited_note is not None

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
        }

    def to_dict(self) -> dict:
        d = self.summary()
        d["transcript"] = self.transcript
        # `note` is the effective (current) body so existing consumers keep
        # working; `ai_note` exposes the original for the revert/compare affordance.
        d["note"] = self.effective_note
        d["ai_note"] = self.note
        d["edited_note"] = self.edited_note
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

    def save(self, note: SavedNote) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO notes
                    (id, created_at, title, source_name, provider, model, template,
                     transcript, note, transcribe_seconds, note_seconds,
                     edited_note, status, finalized_at, patient_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (note.id, note.created_at, note.title, note.source_name,
                 note.provider, note.model, note.template, note.transcript, note.note,
                 note.transcribe_seconds, note.note_seconds,
                 note.edited_note, note.status, note.finalized_at, note.patient_id),
            )

    def list(self, patient_id: Optional[str] = None) -> list[dict]:
        """Newest first, summary shape (no bodies). Optionally filter to one
        patient. Each row carries patient_id + patient_name (via a LEFT JOIN)."""
        sql = (
            "SELECT n.id, n.created_at, n.title, n.source_name, n.provider, n.model, "
            "n.template, n.transcribe_seconds, n.note_seconds, n.edited_note, "
            "n.status, n.finalized_at, n.patient_id, p.name AS patient_name "
            "FROM notes n LEFT JOIN patients p ON p.id = n.patient_id "
        )
        params: tuple = ()
        if patient_id is not None:
            sql += "WHERE n.patient_id = ? "
            params = (patient_id,)
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
        return cur.rowcount > 0

    # --- edit / finalize lifecycle (ADR-0015) --------------------------------

    def update_body(self, note_id: str, edited: str) -> Optional[SavedNote]:
        """Save a clinician-edited body as an overlay (never touches `note`).
        Returns None if the note is missing; raises _Locked if it's final."""
        note = self.get(note_id)
        if not note:
            return None
        if note.status == "final":
            raise NoteLockedError("note is finalized; reopen it before editing")
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET edited_note = ? WHERE id = ?", (edited, note_id)
            )
        note.edited_note = edited
        return note

    def revert(self, note_id: str) -> Optional[SavedNote]:
        """Clear the edit overlay so the effective body is the AI original again."""
        note = self.get(note_id)
        if not note:
            return None
        if note.status == "final":
            raise NoteLockedError("note is finalized; reopen it before reverting")
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET edited_note = NULL WHERE id = ?", (note_id,)
            )
        note.edited_note = None
        return note

    def set_status(self, note_id: str, status: str, finalized_at: Optional[str]) -> Optional[SavedNote]:
        """Set draft/final + the finalize timestamp (None clears it on reopen)."""
        note = self.get(note_id)
        if not note:
            return None
        with self._connect() as conn:
            conn.execute(
                "UPDATE notes SET status = ?, finalized_at = ? WHERE id = ?",
                (status, finalized_at, note_id),
            )
        note.status = status
        note.finalized_at = finalized_at
        return note

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
        """All patients (name order) with each one's note count."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT p.id, p.name, p.mrn, p.created_at, "
                "COUNT(n.id) AS note_count "
                "FROM patients p LEFT JOIN notes n ON n.patient_id = p.id "
                "GROUP BY p.id ORDER BY lower(p.name)"
            ).fetchall()
        return [dict(r) for r in rows]

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
