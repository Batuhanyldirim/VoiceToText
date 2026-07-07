# stt-api — FastAPI backend

A thin local backend that wraps the shared libraries (`stt_core` for
transcription, `note_core` for clinical notes) for the web app. Single user,
single process, bound to `127.0.0.1`. It imports the cores and calls
`transcribe(...)` / `generate(...)` directly (not via the CLI) — see
[`../../specs/adr/0007-shared-core-import-not-subprocess.md`](../../specs/adr/0007-shared-core-import-not-subprocess.md),
[`../../specs/adr/0008-fastapi-inprocess-jobs-sse.md`](../../specs/adr/0008-fastapi-inprocess-jobs-sse.md),
and [`../../specs/adr/0009-clinical-note-pluggable-provider.md`](../../specs/adr/0009-clinical-note-pluggable-provider.md).

## Setup

From the repo root (installs the whole uv workspace into the shared `.venv/`):

```bash
uv sync --all-packages          # add --python /opt/homebrew/opt/python@3.11/bin/python3.11 on first run
```

## Run

```bash
source env.sh                   # activates .venv + exports HF_TOKEN + redirects caches (REQUIRED)
.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000
# equivalently, the console script:  stt-api
```

Then open the interactive docs at **http://127.0.0.1:8000/docs**.

`HF_TOKEN` is read **once from the server environment** (from `env.sh`); it is
never accepted from the browser and never logged or returned. Start the server in
a shell that has sourced `env.sh`, or run diarization-free jobs with
`diarize=false`.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | `{status, hf_token: bool}` — quick readiness check |
| `POST /jobs` | Multipart upload (`file`) + form options → `{job_id, status}` (202). Options: `language`, `min_speakers`, `max_speakers`, `diarize` (default `true`), `model` (default `large-v3`). |
| `GET /jobs/{id}` | Status poll: `{status, stage, percent, result, error, original_name}`. `status` ∈ `queued\|running\|done\|error`; `result` is the `TranscribeResult` dict when done. |
| `GET /jobs/{id}/events` | **SSE** stream of progress events (`stage`, `percent` during transcription, `message`); emits `ping` keepalives and a terminal `done`/`error` event. |
| `GET /jobs/{id}/download/{fmt}` | Download the result as `txt`, `srt`, or `json` (available once `status == done`); filename derives from the original upload. |

### Clinical note endpoints

Turn a completed transcript into a structured **Turkish** clinical note
(`note_core`). Local by default; cloud opt-in.
→ [ADR-0009](../../specs/adr/0009-clinical-note-pluggable-provider.md),
[ADR-0010](../../specs/adr/0010-persistent-notes-sqlite.md).

| Method + path | Purpose |
|---|---|
| `GET /notes/templates` | Available templates: `soap` ("SOAP notu"), `hp` ("Öykü ve Muayene (Ö&M)"), plus a `free` (serbest metin) paste option (`TEMPLATE_CHOICES`), and `{provider, cloud_enabled}` so the UI can show the right picker + PHI warning. |
| `POST /notes` | Body (JSON): `transcript`, `template` (`soap`\|`hp`\|`free`), `template_text` (required when `template=="free"`), optional `provider`, optional `model` → `{note_id, status}`. Other `NoteOptions` (`temperature`, `num_ctx`, `max_tokens`) are **not** accepted over HTTP — they use server-side defaults. Runs generation on the same worker. |
| `GET /notes/{id}` | Status poll: `{note_id, status, provider, model, template, note, result, error}`; `note` is the accumulated text so far, `result` is the `NoteResult` dict when done. Also serves a **saved** note from the store (adds `transcript, created_at, title, source_name`), not just live jobs. |
| `GET /notes/{id}/events` | **SSE** stream of token deltas (`stage`, `delta` during `generating`), terminal `done`/`error`. Poll `GET /notes/{id}` as a fallback. |

The note output is **Turkish** — Turkish system prompt, Turkish templates, and
Turkish section headings A–E (E = "Klinik İnceleme Gerekli", the highlighted
review section).

### Transcript reuse + note history

Generate a note from an existing CLI transcript in `out/` instead of re-uploading
(a dev-cycle speedup), and browse completed notes persisted to a project-local
SQLite DB. → [ADR-0010](../../specs/adr/0010-persistent-notes-sqlite.md).

| Method + path | Purpose |
|---|---|
| `GET /transcripts` | List existing CLI transcripts under `out/` (`out/*.json`) available for reuse. |
| `GET /transcripts/{name}` | Return a chosen transcript's text (e.g. `HistoryTaking_YA`) to feed straight into `POST /notes`. |
| `GET /notes` | **History**: saved notes newest-first as summaries (`id, created_at, title, source_name, provider, model, template`) — no transcript/note bodies. |
| `DELETE /notes/{id}` | Delete a saved note from the store. |

Completed notes are saved to **`apps/api/notes.db`** (stdlib `sqlite3`, override
with `STT_DB_PATH`). The DB is **project-local and git-ignored** because it holds
PHI (transcript + note) — never commit it; `rm -rf` the project still removes it
(ADR-0003). The live/streaming lifecycle stays in-memory (`notes.py`); only
completed notes are persisted (`store.py`).

**Providers.** Default `ollama` (local, offline — the transcript never leaves the
machine). `claude` is **opt-in only**: the API refuses it (no data sent) unless
server env `STT_NOTE_PROVIDER=claude` is set and a token
(`STT_CLAUDE_API_KEY`/`ANTHROPIC_API_KEY`) is present. The token is read only from
server env, never accepted from the browser, logged, or returned. The default
local model is `qwen2.5:32b-instruct` (start `ollama serve` in a shell that
sourced `env.sh` so `OLLAMA_MODELS` is honored). Install the cloud SDK with
`uv sync --extra claude`.

## How it works

- **Jobs** — `jobs.py`'s `JobManager` keeps an in-memory registry dict and runs
  transcriptions on a `ThreadPoolExecutor(max_workers=1)` (one at a time → warm
  models, no CPU thrash). No broker/Redis.
- **Progress** — the pipeline's `ProgressEvent` callback runs on the worker
  thread and is forwarded via `loop.call_soon_threadsafe` onto a per-job
  `asyncio.Queue`, which the SSE endpoint drains.
- **Scratch** — each job's upload + `input.{txt,srt,json}` outputs live under
  `apps/api/jobs/<id>/` (git-ignored, inside the project per ADR-0003).
- **Note history** — completed notes are persisted to `apps/api/notes.db`
  (stdlib SQLite, `STT_DB_PATH` override) by `store.py`'s `NoteStore`; the DB is
  git-ignored and holds PHI (ADR-0010). The in-memory `NoteJobManager`
  (`notes.py`) owns only the live streaming lifecycle.
- **Limits** — 50 GB upload cap (override with the `STT_MAX_UPLOAD_GB` env var);
  uploads stream to disk in chunks (never buffered whole in RAM); allowed
  suffixes are the audio/video set in `main.py`.

## Verify

Upload the 2-speaker fixture and confirm ≥ 2 speakers (the project's PASS gate):

```bash
source env.sh && bash make_sample.sh
# in another shell with the server running:
curl -s -F file=@samples/conversation.wav http://127.0.0.1:8000/jobs
# → {"job_id": "...", "status": "queued"} ; then poll:
curl -s http://127.0.0.1:8000/jobs/<job_id>     # PASS when result.num_speakers >= 2
```

Note history round-trip (reuse → generate → persist → delete):

```bash
curl -s http://127.0.0.1:8000/transcripts                    # list out/*.json
curl -s http://127.0.0.1:8000/transcripts/HistoryTaking_YA   # transcript text to reuse
# POST /notes with that transcript, wait for done, then:
curl -s http://127.0.0.1:8000/notes                          # saved note appears here
curl -s http://127.0.0.1:8000/notes/<note_id>                # opens in full (survives a server restart)
curl -s -X DELETE http://127.0.0.1:8000/notes/<note_id>      # removes it
# git status must never show apps/api/notes.db (it holds PHI and is git-ignored)
```
