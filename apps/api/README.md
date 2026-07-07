# stt-api — FastAPI backend

A thin local backend that wraps the shared pipeline (`stt_core`) for the web app.
Single user, single process, bound to `127.0.0.1`. It imports `stt_core` and
calls `transcribe(...)` directly (not via the CLI) — see
[`../../specs/adr/0007-shared-core-import-not-subprocess.md`](../../specs/adr/0007-shared-core-import-not-subprocess.md)
and [`../../specs/adr/0008-fastapi-inprocess-jobs-sse.md`](../../specs/adr/0008-fastapi-inprocess-jobs-sse.md).

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

## How it works

- **Jobs** — `jobs.py`'s `JobManager` keeps an in-memory registry dict and runs
  transcriptions on a `ThreadPoolExecutor(max_workers=1)` (one at a time → warm
  models, no CPU thrash). No broker/Redis.
- **Progress** — the pipeline's `ProgressEvent` callback runs on the worker
  thread and is forwarded via `loop.call_soon_threadsafe` onto a per-job
  `asyncio.Queue`, which the SSE endpoint drains.
- **Scratch** — each job's upload + `input.{txt,srt,json}` outputs live under
  `apps/api/jobs/<id>/` (git-ignored, inside the project per ADR-0003).
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
