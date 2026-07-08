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
from datetime import datetime, timezone
from typing import Optional

from note_core import NoteOptions, generate
from note_core.progress import NoteEvent

log = logging.getLogger("stt_api.notes")


def _template_label(template: str) -> str:
    """Human label for a template key ("SOAP notu"), falling back to the key
    itself for "free"/unknown keys. Best-effort — never raises."""
    try:
        from note_core import TEMPLATE_CHOICES

        for choice in TEMPLATE_CHOICES:
            if choice.get("key") == template:
                return choice.get("label") or template
    except Exception:  # noqa: BLE001 - labeling is cosmetic
        pass
    return template


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
    title: Optional[str] = None       # display title for the persisted note
    source_name: Optional[str] = None  # transcript stem / uploaded name, if any
    transcribe_seconds: Optional[float] = None  # carried from the source transcript
    note_seconds: Optional[float] = None        # wall-clock note generation time
    # Audio-linked source transcript (ADR-0019): the turns JSON to persist, and
    # the originating job/stream id whose on-disk audio we copy at persist time.
    transcript_json: Optional[str] = None
    audio_source_id: Optional[str] = None
    # Encounter metadata (ADR-0022).
    patient_id: Optional[str] = None
    visit_type: Optional[str] = None
    chief_complaint: Optional[str] = None
    created_at: str = ""             # UTC ISO-8601, set at registration
    started_at: Optional[float] = None  # epoch seconds at _run start (anchors the UI timer)
    # asyncio primitives, set when the job is submitted (bound to the running loop)
    queue: Optional[asyncio.Queue] = field(default=None, repr=False)
    loop: Optional[asyncio.AbstractEventLoop] = field(default=None, repr=False)

    def active_summary(self) -> dict:
        """Sidebar row for an in-progress/failed note generation."""
        return {
            "id": self.id,
            "kind": "note",
            "status": self.status,
            "stage": self.stage,
            "title": self.title,
            "source_name": self.source_name,
            "provider": self.opts.provider,
            "model": self.opts.resolved_model(),
            "started_at": self.started_at,
            "created_at": self.created_at,
            "error": self.error,
        }


class NoteJobManager:
    def __init__(self, store=None, audio_store=None, audio_resolver=None) -> None:
        self._jobs: dict[str, NoteJob] = {}
        self._executor = ThreadPoolExecutor(max_workers=1)
        # Optional NoteStore — the worker persists completed notes into it. Kept
        # as a constructor arg so main.py owns the single instance and tests can
        # inject their own (or None to skip persistence).
        self._store = store
        # Audio-linked source transcript (ADR-0019): an optional NoteAudioStore
        # and a resolver `audio_source_id -> Optional[Path]` (main.py wires it to
        # the job/stream managers). When both are present and a job carries an
        # audio_source_id, the worker copies that source audio into the store.
        self._audio_store = audio_store
        self._audio_resolver = audio_resolver

    def get(self, note_id: str) -> Optional[NoteJob]:
        return self._jobs.get(note_id)

    def list_active(self) -> list[dict]:
        """Summaries of note jobs still queued/running or failed (retryable).
        `done` notes are excluded — they live in the durable store. Newest
        first."""
        rows = [j.active_summary() for j in self._jobs.values() if j.status != "done"]
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return rows

    def retry(self, note_id: str) -> Optional[NoteJob]:
        """Re-run a failed note using the same transcript + options (no data
        re-entry). Returns None if the job is gone."""
        job = self._jobs.get(note_id)
        if not job:
            return None
        job.status = "queued"
        job.stage = "queued"
        job.note_text = ""
        job.result = None
        job.error = None
        job.started_at = None
        self.submit(job)
        return job

    def discard(self, note_id: str) -> bool:
        """Drop a job from the in-memory registry (used when deleting history)."""
        return self._jobs.pop(note_id, None) is not None

    def register(
        self,
        transcript: str,
        opts: NoteOptions,
        title: Optional[str] = None,
        source_name: Optional[str] = None,
        transcribe_seconds: Optional[float] = None,
        transcript_json: Optional[str] = None,
        audio_source_id: Optional[str] = None,
        patient_id: Optional[str] = None,
        visit_type: Optional[str] = None,
        chief_complaint: Optional[str] = None,
    ) -> NoteJob:
        note_id = uuid.uuid4().hex[:12]
        if not title:
            # Auto-title (ADR-0022): lead with the chief complaint when present,
            # else the source name; always suffixed with the template label.
            lead = (chief_complaint or "").strip() or source_name or "Not"
            title = f"{lead} — {_template_label(opts.template)}"
        job = NoteJob(
            id=note_id,
            transcript=transcript,
            opts=opts,
            title=title,
            source_name=source_name,
            transcribe_seconds=transcribe_seconds,
            transcript_json=transcript_json,
            audio_source_id=audio_source_id,
            patient_id=patient_id,
            visit_type=(visit_type or "").strip() or None,
            chief_complaint=(chief_complaint or "").strip() or None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
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
        job.started_at = time.time()  # epoch anchor for the UI timer (survives refresh)
        log.info("note %s START provider=%s model=%s template=%s",
                 job.id, job.opts.provider, job.opts.resolved_model(), job.opts.template)
        try:
            result = generate(
                job.transcript, job.opts,
                progress=lambda e: self._emit(job, e),
            )
            # Record wall-clock note-generation time (uniform across providers).
            job.note_seconds = round(time.monotonic() - t0, 1)
            # Set the result BEFORE emitting "done" (same large-input race fix as
            # transcription): a client reacting to "done" must find it ready.
            job.result = result.to_dict()
            job.note_text = result.note
            job.status = "done"
            # Persist the completed note to durable history. A store failure must
            # NOT crash the job (the in-memory result is still served), so guard.
            # Problems/medications came from the SAME generation call (ADR-0023).
            self._persist(job, result.note,
                          problems=result.problems, medications=result.medications)
            self._emit_terminal(job, NoteEvent(stage="done", message="note complete"))
            log.info("note %s DONE chars=%d in %.1fs", job.id,
                     len(result.note), job.note_seconds)
        except Exception as e:  # noqa: BLE001 - never let a job kill the server
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
            self._emit_terminal(job, NoteEvent(stage="error", message=job.error))
            log.exception("note %s ERROR after %.1fs: %s", job.id,
                          time.monotonic() - t0, job.error)

    def _persist(self, job: NoteJob, note: str,
                 problems: list | None = None, medications: list | None = None) -> None:
        """Save a completed note to the store (best-effort; never raises), then
        copy its source audio into the audio store if available (ADR-0019).
        problems/medications came from the same generation call (ADR-0023)."""
        if self._store is None:
            return
        try:
            import json as _json
            from .store import SavedNote

            # Only persist extraction JSON when the model actually produced lists
            # (None → not run / not emitted; keep the columns NULL so `extracted`
            # stays False and the UI shows the run prompt).
            has_ext = bool(problems) or bool(medications)
            self._store.save(SavedNote(
                id=job.id,
                created_at=datetime.now(timezone.utc).isoformat(),
                title=job.title or f"Not — {job.opts.template}",
                source_name=job.source_name,
                provider=job.opts.provider,
                model=job.opts.resolved_model(),
                template=job.opts.template,
                transcript=job.transcript,
                note=note,
                transcribe_seconds=job.transcribe_seconds,
                note_seconds=job.note_seconds,
                transcript_json=job.transcript_json,
                visit_type=job.visit_type,
                chief_complaint=job.chief_complaint,
                problems_json=_json.dumps(problems or [], ensure_ascii=False) if has_ext else None,
                medications_json=_json.dumps(medications or [], ensure_ascii=False) if has_ext else None,
            ))
            # Assign the patient up front, if one was chosen (ADR-0022/0016).
            if job.patient_id:
                try:
                    self._store.set_note_patient(job.id, job.patient_id)
                except Exception:  # noqa: BLE001 - bad/removed patient must not fail
                    log.warning("note %s: could not assign patient %s", job.id, job.patient_id)
            log.info("note %s PERSISTED to store", job.id)
        except Exception as e:  # noqa: BLE001 - persistence must not kill the job
            log.warning("note %s persist FAILED: %s: %s", job.id, type(e).__name__, e)
        # Copy source audio into the durable note-keyed store (best-effort — a
        # cleaned/absent source just means the note has no audio; never raises).
        self._persist_audio(job)

    def _persist_audio(self, job: NoteJob) -> None:
        if not (self._audio_store and self._audio_resolver and job.audio_source_id):
            return
        try:
            source = self._audio_resolver(job.audio_source_id)
            if source:
                dest = self._audio_store.save_from(job.id, source)
                if dest:
                    log.info("note %s AUDIO stored from %s", job.id, job.audio_source_id)
        except Exception as e:  # noqa: BLE001 - audio linking must not kill the note
            log.warning("note %s audio store FAILED: %s: %s", job.id, type(e).__name__, e)

    def _emit_terminal(self, job: NoteJob, event: NoteEvent) -> None:
        """Enqueue the authoritative terminal (done/error) event, after
        job.result/status are set. Does not swallow "done" like _emit."""
        job.stage = event.stage
        if job.loop and job.queue:
            job.loop.call_soon_threadsafe(job.queue.put_nowait, event)
