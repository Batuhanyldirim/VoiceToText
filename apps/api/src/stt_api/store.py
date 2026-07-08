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
    note: str
    # Timing metrics (seconds). transcribe_seconds is carried from the source
    # transcript (may be None for reused transcripts predating the feature);
    # note_seconds is the wall-clock note generation time. Both nullable.
    transcribe_seconds: Optional[float] = None
    note_seconds: Optional[float] = None

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
        }

    def to_dict(self) -> dict:
        d = self.summary()
        d["transcript"] = self.transcript
        d["note"] = self.note
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
            # Lightweight migration: add the timing columns to a pre-existing
            # table (CREATE TABLE IF NOT EXISTS won't alter an older schema).
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
            for col in ("transcribe_seconds", "note_seconds"):
                if col not in cols:
                    conn.execute(f"ALTER TABLE notes ADD COLUMN {col} REAL")

    def save(self, note: SavedNote) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO notes
                    (id, created_at, title, source_name, provider, model, template,
                     transcript, note, transcribe_seconds, note_seconds)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (note.id, note.created_at, note.title, note.source_name,
                 note.provider, note.model, note.template, note.transcript, note.note,
                 note.transcribe_seconds, note.note_seconds),
            )

    def list(self) -> list[dict]:
        """Newest first, summary shape (no bodies)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, created_at, title, source_name, provider, model, template, "
                "transcribe_seconds, note_seconds "
                "FROM notes ORDER BY created_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

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
