# ADR-0012 — In-memory sessions: sidebar, refresh-safe timers, retry (server-process scope)

**Status:** Accepted · **Relates to:** REQ-116–REQ-119, ADR-0008, ADR-0010, ADR-0011, `apps/api/src/stt_api/jobs.py`, `apps/api/src/stt_api/notes.py`, `apps/web/src/components/NotesSidebar.tsx`, `apps/web/src/hooks/useElapsed.ts`, `apps/web/src/utils/session.ts`, `Makefile`

## Context

Transcription and note generation both run on a single in-process worker with an
in-memory registry (ADR-0008); only *completed* notes are persisted to SQLite
(ADR-0010). In real use the operator kicks off a long run (a large recording can
take minutes), then navigates away, refreshes the tab, or generates several notes
in a session. Three gaps hurt that flow:

- **No way back to an in-flight run.** Once you left the progress screen, an
  in-progress job was effectively lost — the sidebar only listed *saved* notes.
- **The elapsed timer lied on refresh.** A mount-relative counter reset to zero on
  every page refresh, so a job 4 minutes in showed "0s".
- **A failure meant starting over,** including re-uploading the audio or
  re-pasting the transcript.

We also hit two operational bugs that made in-flight state fragile: uvicorn
`--reload` restarted the process on any file touch (orphaning jobs and wiping the
scratch dir), and a large-file race let a "done" event arrive before the result
was ready. Both had to be fixed for sessions to be trustworthy.

The constraint: this is a **single local user, single process** (ADR-0008). We do
**not** want a broker, a jobs table, or crash-durable queues — that's out of
proportion. Durability of *finished* work already lives in SQLite (ADR-0010).

## Decision

Treat in-progress work as **server-process-scoped sessions** surfaced in the UI,
made refresh-safe on the client — without adding backend durability.

- **Active-session lists.** `JobManager.list_active()` / `NoteJobManager.list_active()`
  return queued/running/**failed** items (newest first, `done` excluded), exposed
  as `GET /jobs` and `GET /notes/active`. The web `NotesSidebar` ("Oturumlar")
  shows active items on top (spinner + Turkish stage label, or ⚠ + "Tekrar dene"),
  a divider, then the saved-note history; it polls the active lists every ~3s.
- **Timers anchored to the real start.** Each job records `started_at` (epoch
  seconds, set on the server at `_run` start) alongside `created_at`; the status
  endpoints return it. The `useElapsed` hook counts from that server anchor, so a
  mid-run refresh shows the true elapsed time instead of flashing 0.
- **Client-side screen persistence.** `utils/session.ts` stores a minimal,
  serializable pointer (screen + job/note id, never `File`/result blobs) in
  `localStorage`; `App.tsx` rehydrates on load and re-attaches by id — re-opening
  the SSE stream or re-fetching the finished result. An in-progress job survives a
  refresh and is returnable from the sidebar.
- **Retry in place.** `POST /jobs/{id}/retry` re-runs a failed transcription with
  the **same uploaded file still on disk** (404 if it's gone); `POST /notes/{id}/retry`
  re-runs a failed note with the same transcript + options. No re-upload / re-entry.
- **Reliability fixes that make the above trustworthy:** `make api` runs **without
  `--reload`** (and sources `env.sh`) so editing/touching files can't orphan a
  running job; `make api-dev` scopes reload to source dirs only. The worker owns
  the single authoritative terminal `done` — emitted only *after* `job.result` is
  set — fixing the "stuck at done" large-file race. Benign
  pyannote/torch/dependency warnings are muted in `stt_core` and the API logging
  config so lifecycle logs stay readable.

## Consequences

- ✅ The operator can leave, refresh, and come back to any in-flight run; timers
  read true elapsed time; a failure is one click to retry with no data re-entry.
- ✅ No new backend infra — sessions live in the existing in-memory registries;
  finished work is still the only thing persisted (ADR-0010). Client persistence
  is a tiny `localStorage` pointer, not a data copy.
- ➖ **Explicit scope limit:** sessions live only for the life of the server
  process. A server restart (e.g. `make api`) **drops in-flight jobs** — the
  client pointer then resolves to a 404 and falls back to the upload screen. This
  is acceptable for one local user; a crash-durable queue would be over-engineering
  here.
- ➖ Retry depends on the uploaded file still being under `apps/api/jobs/`; a
  cleaned scratch dir makes a transcription un-retryable (returns 404).
- ⚠️ **Do not** run `make api` with `--reload` (use `make api-dev` for editing) —
  reload orphans jobs and wipes scratch. **Do not** emit the pipeline's own early
  "done" as the terminal event; the worker emits the authoritative one after the
  result is set. **Do not** assume sessions survive a restart — durability is
  SQLite-backed and only for completed notes.
