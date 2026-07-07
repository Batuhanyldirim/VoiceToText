"""In-process job registry + worker for clinical note generation.

Mirrors stt_api.jobs.JobManager exactly: a ThreadPoolExecutor(max_workers=1)
runs one note generation at a time; note_core.generate's progress callback (which
runs on the worker thread) forwards NoteEvents onto a per-job asyncio.Queue via
loop.call_soon_threadsafe, so the SSE endpoint on the event loop can stream token
deltas. No broker/Redis — one local user (see specs/adr/0007, 0009).

Unlike transcription (coarse stages), note generation streams *token deltas*, so
each "generating" event's delta is appended to job.note_text (the accumulated
note so far) AND enqueued for SSE.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from note_core import NoteOptions, generate
from note_core.progress import NoteEvent

log = logging.getLogger("stt_api.notes")


@dataclass
class NoteJob:
    id: str
    transcript: str
    opts: NoteOptions
    status: str = "queued"           # queued | running | done | error
    stage: str = "queued"
    note_text: str = ""              # accumulated streamed note text so far
    result: Optional[dict] = None    # NoteResult.to_dict()
    error: Optional[str] = None
    # asyncio primitives, set when the job is submitted (bound to the running loop)
    queue: Optional[asyncio.Queue] = field(default=None, repr=False)
    loop: Optional[asyncio.AbstractEventLoop] = field(default=None, repr=False)


class NoteJobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, NoteJob] = {}
        self._executor = ThreadPoolExecutor(max_workers=1)

    def get(self, note_id: str) -> Optional[NoteJob]:
        return self._jobs.get(note_id)

    def register(self, transcript: str, opts: NoteOptions) -> NoteJob:
        note_id = uuid.uuid4().hex[:12]
        job = NoteJob(id=note_id, transcript=transcript, opts=opts)
        self._jobs[note_id] = job
        return job

    def submit(self, job: NoteJob) -> None:
        """Bind the job to the current event loop and hand it to the worker."""
        job.queue = asyncio.Queue()
        job.loop = asyncio.get_running_loop()
        self._executor.submit(self._run, job)

    def _emit(self, job: NoteJob, event: NoteEvent) -> None:
        """Called from the worker thread — hop back onto the event loop to enqueue.

        note_core.generate emits its own "done" before _run sets job.result, so
        we SWALLOW the pipeline's "done" here (same race as transcription); _run
        emits the single authoritative "done" via _emit_terminal once the result
        is set. Token deltas ("generating") are always forwarded + accumulated.
        """
        if event.stage == "done":
            return
        job.stage = event.stage
        if event.stage == "generating" and event.delta:
            job.note_text += event.delta
        if job.loop and job.queue:
            job.loop.call_soon_threadsafe(job.queue.put_nowait, event)

    def _run(self, job: NoteJob) -> None:
        job.status = "running"
        t0 = time.monotonic()
        log.info("note %s START provider=%s model=%s template=%s",
                 job.id, job.opts.provider, job.opts.resolved_model(), job.opts.template)
        try:
            result = generate(
                job.transcript, job.opts,
                progress=lambda e: self._emit(job, e),
            )
            # Set the result BEFORE emitting "done" (same large-input race fix as
            # transcription): a client reacting to "done" must find it ready.
            job.result = result.to_dict()
            job.note_text = result.note
            job.status = "done"
            self._emit_terminal(job, NoteEvent(stage="done", message="note complete"))
            log.info("note %s DONE chars=%d in %.1fs", job.id,
                     len(result.note), time.monotonic() - t0)
        except Exception as e:  # noqa: BLE001 - never let a job kill the server
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
            self._emit_terminal(job, NoteEvent(stage="error", message=job.error))
            log.exception("note %s ERROR after %.1fs: %s", job.id,
                          time.monotonic() - t0, job.error)

    def _emit_terminal(self, job: NoteJob, event: NoteEvent) -> None:
        """Enqueue the authoritative terminal (done/error) event, after
        job.result/status are set. Does not swallow "done" like _emit."""
        job.stage = event.stage
        if job.loop and job.queue:
            job.loop.call_soon_threadsafe(job.queue.put_nowait, event)
