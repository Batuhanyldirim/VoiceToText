# ADR-0008 — FastAPI + in-process job worker + SSE

**Status:** Accepted · **Relates to:** REQ-090–REQ-097, `tech.md`, `apps/api`, ADR-0003, ADR-0007

## Context

The web app needs a backend that accepts an upload, runs a **long** CPU job
(transcription can take minutes), streams **live progress**, and serves the
result — for a **single local user on one machine**. The pipeline is
CPU-bound and already saturates cores; running more than one job at a time only
thrashes.

Heavier stacks exist (Celery + Redis/RabbitMQ for a task queue; WebSockets for
bidirectional streaming; client polling for progress) but each adds a broker or
infrastructure that a single-user localhost tool does not need.

## Decision

**FastAPI + Uvicorn**, single process, bound to **`127.0.0.1:8000`**. Jobs run in
an **in-process `ThreadPoolExecutor(max_workers=1)`** with an **in-memory job
registry dict** (`JobManager` in `jobs.py`) — **no broker**.

- Endpoints: `POST /jobs` (multipart upload + options → `{job_id}`),
  `GET /jobs/{id}` (status + result), `GET /jobs/{id}/events`
  (**SSE** progress via `sse-starlette`), `GET /jobs/{id}/download/{fmt}`
  (`txt`|`srt`|`json`).
- **Progress:** the pipeline's `ProgressEvent` callback runs on the worker thread
  and hops back to the event loop via `loop.call_soon_threadsafe` onto a per-job
  `asyncio.Queue`; the SSE endpoint drains that queue. `GET /jobs/{id}` is a
  **poll fallback** for progress and the final result.
- **`max_workers=1`** keeps the multi-GB models warm (ADR-0007) and avoids CPU
  contention; extra jobs queue.
- **Secrets:** `HF_TOKEN` is read **once from server env** (populated by
  `env.sh`). It is never accepted from the browser and never logged or returned.
- **Scratch:** each job's upload + outputs live under `apps/api/jobs/<id>/`,
  which is git-ignored and inside the project (ADR-0003).

## Consequences

- ✅ Zero infrastructure — `uvicorn stt_api.main:app` is the whole backend; no
  Redis/broker to install or run.
- ✅ SSE is one-way (server→client) which is exactly what progress needs, and it
  works over plain HTTP with a trivial client; the poll endpoint covers
  reconnects and late subscribers.
- ✅ Warm models + serialized execution fit a single CPU-bound local user.
- ✅ Privacy preserved: localhost bind, local models, token never leaves the server.
- ➖ Not horizontally scalable and state is in-memory (a restart forgets jobs) —
  fine for one local user; explicitly out of scope for a hosted service
  (`product.md` non-goals).
- ⚠️ **Do not** add Celery/Redis, raise `max_workers`, expose the server beyond
  `127.0.0.1`, or accept `HF_TOKEN` from the client without revisiting this ADR.
