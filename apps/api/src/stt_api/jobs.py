"""In-process job registry + worker for the single-user local server.

A ThreadPoolExecutor(max_workers=1) runs one transcription at a time so the
multi-GB models stay warm and jobs don't thrash CPU. The pipeline's
progress callback (called from the worker thread) forwards ProgressEvents onto
a per-job asyncio.Queue via loop.call_soon_threadsafe, so the SSE endpoint on
the event loop can stream them. No broker/Redis — overkill for one local user
(see specs/adr/0007).
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from stt_core import TranscribeOptions, transcribe
from stt_core import emit
from stt_core.progress import ProgressEvent

log = logging.getLogger("stt_api.jobs")


@dataclass
class Job:
    id: str
    input_path: Path
    out_dir: Path
    opts: TranscribeOptions
    status: str = "queued"          # queued | running | done | error
    stage: str = "queued"
    percent: float = 0.0
    result: Optional[dict] = None    # TranscribeResult.to_dict()
    error: Optional[str] = None
    # asyncio primitives, set when the job is submitted (bound to the running loop)
    queue: Optional[asyncio.Queue] = field(default=None, repr=False)
    loop: Optional[asyncio.AbstractEventLoop] = field(default=None, repr=False)


class JobManager:
    def __init__(self, jobs_root: Path):
        self.jobs_root = jobs_root
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._executor = ThreadPoolExecutor(max_workers=1)

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def new_job_dir(self, filename: str) -> tuple[str, Path, Path]:
        """Allocate a job id + dir and the target input path (preserving the
        original extension so ffmpeg can decode it). No data written yet."""
        job_id = uuid.uuid4().hex[:12]
        job_dir = self.jobs_root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix or ".bin"
        return job_id, job_dir, job_dir / f"input{suffix}"

    def register(self, job_id: str, job_dir: Path, input_path: Path,
                 filename: str, opts: TranscribeOptions) -> Job:
        """Register a job whose input file has already been streamed to disk."""
        job = Job(id=job_id, input_path=input_path, out_dir=job_dir, opts=opts)
        job.original_name = filename  # type: ignore[attr-defined]
        self._jobs[job_id] = job
        return job

    def submit(self, job: Job) -> None:
        """Bind the job to the current event loop and hand it to the worker."""
        job.queue = asyncio.Queue()
        job.loop = asyncio.get_running_loop()
        self._executor.submit(self._run, job)

    def _emit(self, job: Job, event: ProgressEvent) -> None:
        """Called from the worker thread — hop back onto the event loop to enqueue.

        The pipeline emits a "done" progress event *before* transcribe() returns
        (see stt_core.pipeline), i.e. before job.result is set and the output
        files are written. If we forwarded that, a client would receive "done",
        fetch the result, find it not-ready, and hang. So we SWALLOW the
        pipeline's "done" here; _run emits the single authoritative "done" only
        once job.result + job.status are set.
        """
        if event.stage == "done":
            return
        job.stage = event.stage
        if event.percent is not None:
            job.percent = event.percent
        if job.loop and job.queue:
            job.loop.call_soon_threadsafe(job.queue.put_nowait, event)

    def _run(self, job: Job) -> None:
        job.status = "running"
        t0 = time.monotonic()
        name = getattr(job, "original_name", job.input_path.name)
        log.info("job %s START file=%s diarize=%s model=%s", job.id, name,
                 job.opts.diarize, job.opts.model)
        try:
            result = transcribe(
                job.input_path, job.opts,
                progress=lambda e: self._emit(job, e),
                out_dir=job.out_dir,
            )
            # Record how long transcription took BEFORE writing files, so the
            # duration is persisted into <stem>.json (recoverable when the
            # transcript is later reused to generate a note).
            elapsed = time.monotonic() - t0
            result.transcribe_seconds = round(elapsed, 1)
            # write the three output files into the job dir for download
            emit.write_txt(result, job.out_dir)
            emit.write_srt(result, job.out_dir)
            emit.write_json(result, job.out_dir)
            # Set the result BEFORE emitting "done" so any client that reacts to
            # the event finds a ready result (fixes the large-file race where
            # JSON serialization lagged the pipeline's own "done").
            job.result = result.to_dict()
            job.status = "done"
            self._emit_terminal(job, ProgressEvent(stage="done", percent=100.0))
            log.info("job %s DONE speakers=%d turns=%d in %.1fs", job.id,
                     result.num_speakers, len(result.turns), elapsed)
        except Exception as e:  # noqa: BLE001 - never let a job kill the server
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
            self._emit_terminal(job, ProgressEvent(stage="error", message=job.error))
            log.exception("job %s ERROR after %.1fs: %s", job.id,
                          time.monotonic() - t0, job.error)

    def _emit_terminal(self, job: Job, event: ProgressEvent) -> None:
        """Enqueue a terminal (done/error) event. Unlike _emit this does NOT
        swallow "done" — it is the authoritative terminal signal, emitted only
        after job.result/status are set."""
        job.stage = event.stage
        if event.percent is not None:
            job.percent = event.percent
        if job.loop and job.queue:
            job.loop.call_soon_threadsafe(job.queue.put_nowait, event)

    def cleanup(self, job_id: str) -> None:
        job = self._jobs.pop(job_id, None)
        if job:
            shutil.rmtree(job.out_dir, ignore_errors=True)
