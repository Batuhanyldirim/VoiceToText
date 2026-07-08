"""In-process session registry + worker for LIVE (streaming) transcription.

Unlike JobManager (a batch file → one worker run), a streaming session is
long-lived: the browser pushes raw PCM for minutes while we transcribe
silence-cut chunks incrementally, then finalizes with a single global diarization
pass (see stt_core.StreamingTranscriber, ADR-0014).

Concurrency model: ONE dedicated worker thread per session, fed by a thread-safe
command queue (PCM arrays, then a FINISH sentinel). This keeps chunk ASR off the
event loop and strictly ordered (feed… feed… finish), without holding a shared
pool worker idle for the whole session. For one local user that's ~1 live thread.
Progress (transcript deltas + stages) is forwarded onto a per-session asyncio.Queue
via loop.call_soon_threadsafe, exactly like JobManager/NoteJobManager, so the SSE
endpoint streams it. Sessions are in-memory, server-process-scoped (ADR-0008/0012):
a restart drops an in-flight stream.
"""
from __future__ import annotations

import logging
import queue as thread_queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import asyncio

import numpy as np

from stt_core import StreamingTranscriber, TranscribeOptions, emit
from stt_core.progress import ProgressEvent

log = logging.getLogger("stt_api.stream")

# Sentinels pushed onto a session's command queue: finalize, or abort (cancel).
_FINISH = object()
_ABORT = object()

# If a recording session receives no audio and no finish for this long, the
# worker gives up and aborts it — reaps an abandoned stream (tab closed / network
# drop) instead of blocking a thread + holding its audio forever (ADR-0014).
IDLE_TIMEOUT_S = 120.0


@dataclass
class StreamSession:
    id: str
    opts: TranscribeOptions
    out_dir: Path
    original_name: str = "kayit"
    status: str = "recording"        # recording | finalizing | done | error
    stage: str = "transcribe"
    live_text: str = ""              # transcript accumulated so far (for late joiners)
    result: Optional[dict] = None    # TranscribeResult.to_dict() when done
    error: Optional[str] = None
    transcribe_seconds: Optional[float] = None
    created_at: str = ""
    started_at: Optional[float] = None  # epoch seconds at worker start (UI timer anchor)
    # command queue (worker thread) + the worker thread itself
    cmd_q: "thread_queue.Queue" = field(default_factory=thread_queue.Queue, repr=False)
    thread: Optional[threading.Thread] = field(default=None, repr=False)
    # asyncio primitives for SSE (bound when the session is opened on the loop)
    queue: Optional[asyncio.Queue] = field(default=None, repr=False)
    loop: Optional[asyncio.AbstractEventLoop] = field(default=None, repr=False)

    def active_summary(self) -> dict:
        """Sidebar row for an in-progress/failed streaming transcription. Uses the
        same `kind: "transcription"` shape as JobManager so the sidebar renders it
        identically."""
        return {
            "id": self.id,
            "kind": "transcription",
            "status": "error" if self.status == "error" else (
                "done" if self.status == "done" else "running"
            ),
            "stage": self.stage,
            "percent": None,
            "name": self.original_name,
            "started_at": self.started_at,
            "created_at": self.created_at,
            "error": self.error,
        }


class StreamManager:
    def __init__(self, jobs_root: Path) -> None:
        self.jobs_root = jobs_root
        self.jobs_root.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, StreamSession] = {}

    def get(self, sid: str) -> Optional[StreamSession]:
        return self._sessions.get(sid)

    def list_active(self) -> list[dict]:
        rows = [s.active_summary() for s in self._sessions.values() if s.status != "done"]
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return rows

    def open(self, opts: TranscribeOptions, original_name: str) -> StreamSession:
        """Create a session, bind it to the running loop, and start its worker
        thread (which blocks on the command queue until audio arrives)."""
        sid = uuid.uuid4().hex[:12]
        out_dir = self.jobs_root / f"stream-{sid}"
        out_dir.mkdir(parents=True, exist_ok=True)
        session = StreamSession(
            id=sid, opts=opts, out_dir=out_dir, original_name=original_name,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        session.queue = asyncio.Queue()
        session.loop = asyncio.get_running_loop()
        self._sessions[sid] = session
        session.thread = threading.Thread(target=self._run, args=(session,), daemon=True)
        session.thread.start()
        return session

    def append(self, sid: str, pcm: np.ndarray) -> bool:
        """Enqueue a PCM frame (mono float32, 16 kHz) for the worker to transcribe.
        Returns False if the session is unknown or no longer recording."""
        session = self._sessions.get(sid)
        if not session or session.status != "recording":
            return False
        session.cmd_q.put(pcm)
        return True

    def finish(self, sid: str) -> Optional[StreamSession]:
        """Request finalize (flush tail + global diarize). The worker runs it after
        draining any queued audio. Returns None if the session is unknown."""
        session = self._sessions.get(sid)
        if not session:
            return None
        if session.status == "recording":
            session.cmd_q.put(_FINISH)
        return session

    def cancel(self, sid: str) -> bool:
        """Abandon a session without finalizing: unblock its worker (so the thread
        exits and frees the buffered audio) and drop it. Returns False if unknown."""
        session = self._sessions.pop(sid, None)
        if not session:
            return False
        if session.status == "recording":
            session.cmd_q.put(_ABORT)  # unblock the worker's cmd_q.get()
        import shutil
        shutil.rmtree(session.out_dir, ignore_errors=True)
        return True

    def discard(self, sid: str) -> bool:
        session = self._sessions.pop(sid, None)
        if session:
            import shutil
            shutil.rmtree(session.out_dir, ignore_errors=True)
        return session is not None

    # --- worker --------------------------------------------------------------
    def _emit(self, session: StreamSession, event: ProgressEvent) -> None:
        """Forward a progress event to the SSE queue (from the worker thread).

        SWALLOW the transcriber's own terminal "done" (it fires inside finish()
        before session.result is set) — _run emits the authoritative terminal
        "done" after the result is published, mirroring JobManager (ADR-0012)."""
        if event.stage == "done":
            return
        session.stage = event.stage
        # A "transcribe" event carries new transcript text in `message`.
        if event.stage == "transcribe" and event.message:
            session.live_text = (session.live_text + " " + event.message).strip()
        if session.loop and session.queue:
            session.loop.call_soon_threadsafe(session.queue.put_nowait, event)

    def _emit_terminal(self, session: StreamSession, event: ProgressEvent) -> None:
        session.stage = event.stage
        if session.loop and session.queue:
            session.loop.call_soon_threadsafe(session.queue.put_nowait, event)

    def _run(self, session: StreamSession) -> None:
        session.status = "recording"
        t0 = time.monotonic()
        session.started_at = time.time()
        log.info("stream %s START name=%s diarize=%s model=%s", session.id,
                 session.original_name, session.opts.diarize, session.opts.model)
        try:
            st = StreamingTranscriber(
                session.opts, progress=lambda e: self._emit(session, e),
                audio_name=session.original_name,
                log=lambda m: log.debug("stream %s: %s", session.id, m),
            )
            # Consume commands until FINISH: PCM arrays are fed (chunk ASR runs
            # inside feed() when enough audio accrued), the sentinel breaks out.
            # _ABORT (cancel) or an idle timeout ends the session without a result
            # so an abandoned stream can't block this thread / hold audio forever.
            aborted = False
            while True:
                try:
                    item = session.cmd_q.get(timeout=IDLE_TIMEOUT_S)
                except thread_queue.Empty:
                    log.info("stream %s idle-timeout — aborting abandoned session", session.id)
                    aborted = True
                    break
                if item is _FINISH:
                    break
                if item is _ABORT:
                    aborted = True
                    break
                st.feed(item)

            if aborted:
                session.status = "error"
                session.error = "stream cancelled or timed out"
                self._emit_terminal(session, ProgressEvent(stage="error", message=session.error))
                self._sessions.pop(session.id, None)
                import shutil
                shutil.rmtree(session.out_dir, ignore_errors=True)
                log.info("stream %s ABORTED (no result)", session.id)
                return

            session.status = "finalizing"
            result = st.finish()  # flush tail + one global diarization pass + fuse
            elapsed = time.monotonic() - t0
            result.transcribe_seconds = round(elapsed, 1)
            emit.write_txt(result, session.out_dir)
            emit.write_srt(result, session.out_dir)
            emit.write_json(result, session.out_dir)
            session.transcribe_seconds = result.transcribe_seconds
            session.result = result.to_dict()
            session.live_text = "\n".join(
                f"{t['speaker']}: {t['text']}" for t in result.turns
            )
            session.status = "done"
            self._emit_terminal(session, ProgressEvent(stage="done", percent=100.0))
            log.info("stream %s DONE speakers=%d turns=%d in %.1fs", session.id,
                     result.num_speakers, len(result.turns), elapsed)
        except Exception as e:  # noqa: BLE001 - never let a session kill the server
            session.status = "error"
            session.error = f"{type(e).__name__}: {e}"
            self._emit_terminal(session, ProgressEvent(stage="error", message=session.error))
            log.exception("stream %s ERROR after %.1fs: %s", session.id,
                          time.monotonic() - t0, session.error)

    def download_path(self, sid: str, fmt: str) -> Optional[Path]:
        """Path to a finished session's output file, or None."""
        session = self._sessions.get(sid)
        if not session or session.status != "done":
            return None
        stem = Path(session.original_name).stem or "kayit"
        path = session.out_dir / f"{stem}.{fmt}"
        return path if path.is_file() else None
