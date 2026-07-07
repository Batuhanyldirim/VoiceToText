# ADR-0010 — Persistent note history via project-local SQLite

**Status:** Accepted · **Relates to:** REQ-107–REQ-110, ADR-0003, ADR-0008, ADR-0009, `apps/api/src/stt_api/store.py`, `apps/api`, `apps/web`

## Context

The clinical-note feature (ADR-0009) generated notes into an **in-memory**
`NoteJobManager` registry: a note existed only for the life of the server
process, and only while its job stayed in the registry. In real use the operator
wants to come back to notes they generated earlier — reopen them, copy them
again, delete the ones they no longer need — without re-running an LLM pass. The
in-flight registry can't provide that: it's cleared on restart and holds no
searchable list.

We also want to keep the transcript-reuse workflow cheap (REQ-107): generate a
note from an existing `out/*.json` transcript, then have it join the same durable
history as notes made from fresh uploads.

Constraints that shape the choice:

- **Single local user, single process** — the API is bound to `127.0.0.1`
  (REQ-097) and runs one worker (ADR-0008). There is no concurrent-writer or
  multi-tenant pressure that would justify a client/server database.
- **PHI** — a saved note contains the transcript and the generated note, i.e.
  patient data. It must stay on-device and must never be committed (ADR-0003,
  ADR-0009).
- **No new heavy dependency** — the project is a self-contained prototype; adding
  Postgres/an ORM would be out of proportion.

## Decision

Persist **only completed** notes to a **project-local SQLite database** using the
Python stdlib `sqlite3` — **no new dependency**. The store lives in
`apps/api/src/stt_api/store.py` as `NoteStore` + the `SavedNote` dataclass.

- **Project-local + git-ignored.** The DB defaults to `apps/api/notes.db`
  (sibling of the `jobs/` scratch dir), overridable via **`STT_DB_PATH`**. It is
  git-ignored (`apps/api/notes.db`, `*.db`, and the SQLite journal/WAL side
  files) because it holds PHI and must **never** be committed. Keeping it inside
  the project preserves the one-command `rm -rf` cleanup (ADR-0003).
- **Division of responsibility.** The in-memory `NoteJobManager` still owns the
  **live/streaming lifecycle** (queued → generating → done, SSE token deltas).
  When a note completes, the API writes a `SavedNote` to the store; the store is
  the **durable history** the UI browses. The two never fight: streaming stays
  in memory, durability is a write-on-completion.
- **Connection model.** A short-lived connection is opened per call, so the
  single transcription/note worker thread and the event-loop request handlers can
  all touch the DB safely; SQLite's own locking serializes the (rare) writes —
  plenty for one local user.
- **Endpoints (ADR-0008 pattern, extended).** `GET /notes` lists saved notes
  newest-first as summaries (no transcript/note bodies); `GET /notes/{id}` serves
  a saved note in full (it falls back to the store, so it returns persisted notes,
  not only live jobs); `DELETE /notes/{id}` removes one. A `SavedNote` row is
  `{id, created_at (ISO-8601 UTC), title, source_name, provider, model, template,
  transcript, note}`.

## Consequences

- ✅ Notes survive a server restart; the operator gets a real history screen
  (list / open / delete / new) instead of a single ephemeral result.
- ✅ Transcript reuse and fresh-upload notes land in the **same** durable history.
- ✅ No new dependency — stdlib `sqlite3` only; the store is ~120 lines.
- ✅ Cleanup + privacy promises hold: the DB is inside the project and
  git-ignored; `rm -rf` still removes everything and PHI never leaves the machine
  or the repo.
- ➖ Single-writer SQLite is deliberately un-scaled — correct for one local user,
  not for a multi-user deployment. Revisit if this ever becomes a shared service.
- ⚠️ **Do not** commit the DB, move it outside the project, or relax its
  git-ignore — it contains PHI. **Do not** persist in-flight/partial notes; only
  completed ones are saved (streaming stays in the in-memory registry).
