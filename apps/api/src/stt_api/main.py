"""FastAPI backend for the STT + diarization pipeline.

Local, single-user, bound to 127.0.0.1. Endpoints:
    POST /jobs                      upload a file + options -> {job_id}
    GET  /jobs/{id}                 status + result JSON (when done)
    GET  /jobs/{id}/events          SSE stream of progress (stage + percent)
    GET  /jobs/{id}/download/{fmt}  txt | srt | json
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import warnings
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from note_core import NoteOptions, TEMPLATE_CHOICES, extract as extract_note, list_providers
from note_core import ProviderError
from note_core.progress import NoteEvent
from stt_core import TranscribeOptions
from stt_core.progress import ProgressEvent

from .jobs import JobManager
from .notes import NoteJobManager
from .store import NoteAudioStore, NoteLockedError, NoteStore
from .stream import StreamManager

# --- Logging: surface our job/note lifecycle INFO lines, and quiet the known,
# benign third-party warnings that otherwise fire on every job and bury the
# useful output (torch.load weights_only, pyannote/torch version mismatches,
# TRANSFORMERS_CACHE deprecation). Set STT_LOG_LEVEL=DEBUG to see everything;
# STT_QUIET_DEPS=0 to keep the third-party noise.
logging.basicConfig(
    level=os.environ.get("STT_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
if os.environ.get("STT_QUIET_DEPS", "1") == "1":
    warnings.filterwarnings("ignore", message=r".*weights_only=False.*")
    warnings.filterwarnings("ignore", message=r".*TRANSFORMERS_CACHE.*")
    warnings.filterwarnings("ignore", message=r".*was trained with.*")
    for _noisy in ("pyannote", "pytorch_lightning", "lightning_fabric",
                   "speechbrain", "torch.serialization"):
        logging.getLogger(_noisy).setLevel(logging.ERROR)

# Per-job scratch lives inside the project (git-ignored) — keeps the
# "self-contained, rm -rf to clean" promise (ADR-0003).
JOBS_ROOT = Path(os.environ.get("STT_JOBS_DIR", Path(__file__).resolve().parents[2] / "jobs"))

app = FastAPI(title="VoiceToText API", version="0.1.0")

# The Vite dev server runs on a different port; allow it in dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = JobManager(JOBS_ROOT)
# Live (streaming) transcription sessions — same in-memory, process-scoped model
# as JobManager (ADR-0012), scratch under the same git-ignored jobs root (ADR-0003).
stream_manager = StreamManager(JOBS_ROOT)
# Durable note history (SQLite, project-local, git-ignored — ADR-0003). The
# worker persists completed notes here; the /notes history endpoints read it.
note_store = NoteStore()
# Durable, note-keyed source-audio store (ADR-0019, git-ignored). The note worker
# copies a note's source recording here so it survives job-scratch cleanup.
note_audio_store = NoteAudioStore()


def _resolve_source_audio(source_id: str):
    """Map a POST /notes audio_source_id (an upload/recording job id, or a stream
    id) to the on-disk source audio, if still present. Used by the note worker to
    copy it into the durable audio store (ADR-0019)."""
    return manager.source_audio_path(source_id) or stream_manager.source_audio_path(source_id)


note_manager = NoteJobManager(
    store=note_store,
    audio_store=note_audio_store,
    audio_resolver=_resolve_source_audio,
)

# CLI/pipeline transcripts live in repo_root/out/*.json. From
# apps/api/src/stt_api/main.py that's parents[4] (stt_api -> src -> api -> apps -> root).
OUT_DIR = Path(__file__).resolve().parents[4] / "out"

# Generous cap (overridable via STT_MAX_UPLOAD_GB). The upload is streamed to
# disk in chunks (not buffered in RAM), so large files are safe memory-wise;
# the real limit is free disk under apps/api/jobs/ and CPU time to transcribe.
MAX_UPLOAD_GB = float(os.environ.get("STT_MAX_UPLOAD_GB", "50"))
MAX_UPLOAD_BYTES = int(MAX_UPLOAD_GB * 1024 * 1024 * 1024)
_CHUNK = 4 * 1024 * 1024  # 4 MB streaming chunks
ALLOWED_SUFFIXES = {
    ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac",
    ".mp4", ".mov", ".mkv", ".webm", ".avi",
}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "hf_token": bool(os.environ.get("HF_TOKEN"))}


@app.post("/jobs", status_code=202)
async def create_job(
    file: UploadFile = File(...),
    # Turkish by default (REQ-135); send "auto" to auto-detect, or another code.
    language: Optional[str] = Form("tr"),
    min_speakers: Optional[int] = Form(None),
    # Soft cap of 2 (doctor+patient) by default (REQ-136); raise for a caregiver.
    max_speakers: Optional[int] = Form(2),
    diarize: bool = Form(True),
    model: str = Form("large-v3"),
) -> dict:
    filename = file.filename or "audio"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(400, f"unsupported file type '{suffix}'. Allowed: {sorted(ALLOWED_SUFFIXES)}")

    hf_token = os.environ.get("HF_TOKEN")
    if diarize and not hf_token:
        raise HTTPException(
            400, "diarization requested but HF_TOKEN is not set on the server. "
                 "Start the server after `source env.sh`, or send diarize=false."
        )

    # Stream the upload to disk in chunks (never buffer the whole file in RAM),
    # enforcing the cap as we go so an oversized file is rejected without filling
    # memory or disk.
    job_id, job_dir, input_path = manager.new_job_dir(filename)
    total = 0
    try:
        with input_path.open("wb") as out:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"file too large (> {MAX_UPLOAD_GB:g} GB)")
                out.write(chunk)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    if total == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "empty file")

    # Pass language through verbatim; the pipeline's _resolve_language() maps
    # "auto"/"" -> auto-detect and forwards "tr"/"en"/... as a forced language.
    opts = TranscribeOptions(
        model=model, language=language,
        diarize=diarize, min_speakers=min_speakers, max_speakers=max_speakers,
        hf_token=hf_token,
    )
    job = manager.register(job_id, job_dir, input_path, filename, opts)
    manager.submit(job)
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs")
def list_jobs() -> dict:
    """Active (queued/running/failed) file/upload transcriptions for the sidebar.
    Finished ones are excluded — their transcript is shown on the result screen.
    NOTE: live streaming sessions are NOT listed here. They live in a separate
    registry (stream_manager) and are driven end-to-end by the StreamingRecorder
    component (which self-polls to completion), not by the job sidebar — routing
    a stream id through the /jobs endpoints would 404. See ADR-0014."""
    return {"jobs": manager.list_active()}


@app.post("/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: str) -> dict:
    """Re-run a failed transcription with the SAME uploaded file (no re-upload).
    async so submit() can bind to the running event loop (see create_job)."""
    job = manager.retry(job_id)
    if not job:
        raise HTTPException(404, "job not found or its uploaded file is gone")
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "percent": job.percent,
        "result": job.result,
        "error": job.error,
        "original_name": job.original_name,
        "started_at": job.started_at,
        "created_at": job.created_at,
    }


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")

    async def stream():
        # If the job already finished before the client connected, emit a final event.
        if job.status in ("done", "error"):
            yield {"event": job.status, "data": json.dumps({"stage": job.stage})}
            return
        assert job.queue is not None
        while True:
            try:
                event: ProgressEvent = await asyncio.wait_for(job.queue.get(), timeout=30)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "keepalive"}
                continue
            payload = {"stage": event.stage}
            if event.percent is not None:
                payload["percent"] = round(event.percent, 1)
            if event.message:
                payload["message"] = event.message
            yield {"event": event.stage, "data": json.dumps(payload)}
            if event.stage in ("done", "error"):
                break

    return EventSourceResponse(stream())


@app.get("/jobs/{job_id}/download/{fmt}")
def download(job_id: str, fmt: str):
    if fmt not in ("txt", "srt", "json"):
        raise HTTPException(400, "fmt must be txt, srt, or json")
    job = manager.get(job_id)
    if not job or job.status != "done":
        raise HTTPException(404, "result not ready")
    # pipeline names outputs after the input stem ("input")
    path = job.out_dir / f"input.{fmt}"
    if not path.is_file():
        raise HTTPException(404, f"{fmt} not found")
    stem = Path(getattr(job, "original_name", "transcript")).stem or "transcript"
    media = {"txt": "text/plain", "srt": "application/x-subrip", "json": "application/json"}[fmt]
    return FileResponse(path, media_type=media, filename=f"{stem}.{fmt}")


# ---------------------------------------------------------------------------
# Live (streaming) transcription — transcribe WHILE recording (ADR-0014).
# The browser captures raw PCM (AudioWorklet), downsamples to 16 kHz mono, and
# streams it here as int16 frames. The server transcribes silence-cut chunks
# incrementally and, on finish, runs ONE global diarization pass, returning a
# normal TranscribeResult (so downloads / note generation / the viewer are
# reused). Local-only: audio only ever reaches this 127.0.0.1 endpoint (REQ-128).
# ---------------------------------------------------------------------------


@app.post("/stream", status_code=201)
async def open_stream(
    language: Optional[str] = Form("tr"),          # Turkish default (REQ-135); "auto" to detect
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(2),         # soft doctor+patient cap (REQ-136)
    diarize: bool = Form(True),
    model: str = Form("large-v3"),
    name: str = Form("kayit"),
) -> dict:
    """Open a streaming session. Same HF_TOKEN gate as create_job (diarization
    needs a server-side token; never accepted from the browser — REQ-096)."""
    hf_token = os.environ.get("HF_TOKEN")
    if diarize and not hf_token:
        raise HTTPException(
            400, "diarization requested but HF_TOKEN is not set on the server. "
                 "Start the server after `source env.sh`, or send diarize=false."
        )
    # Streaming skips whole-file enhancement (REQ-131) — incremental chunks can't
    # get the whole-file leveling pass; the batch record/upload path keeps it.
    opts = TranscribeOptions(
        model=model, language=language, diarize=diarize,
        min_speakers=min_speakers, max_speakers=max_speakers,
        enhance=False, hf_token=hf_token,
    )
    session = stream_manager.open(opts, original_name=name or "kayit")
    return {"stream_id": session.id, "status": session.status}


@app.post("/stream/{stream_id}/audio", status_code=202)
async def stream_audio(stream_id: str, request: Request) -> dict:
    """Append a raw PCM frame (little-endian int16 mono @ 16 kHz) as the request
    body. Converted to float32 in [-1, 1] and handed to the session worker."""
    raw = await request.body()
    if not raw:
        return {"ok": True, "samples": 0}
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if not stream_manager.append(stream_id, pcm):
        raise HTTPException(404, "stream not found or not recording")
    return {"ok": True, "samples": int(pcm.shape[0])}


@app.post("/stream/{stream_id}/finish", status_code=202)
async def finish_stream(stream_id: str) -> dict:
    """Signal end-of-recording: the worker flushes the tail and runs the global
    diarization pass, then publishes the result (poll GET /stream/{id})."""
    session = stream_manager.finish(stream_id)
    if not session:
        raise HTTPException(404, "stream not found")
    return {"stream_id": session.id, "status": session.status}


@app.delete("/stream/{stream_id}", status_code=202)
async def cancel_stream(stream_id: str) -> dict:
    """Cancel/abandon a streaming session without finalizing — unblocks the worker
    thread and frees its buffered audio + scratch dir. Called by the client when
    the recorder is torn down without a finish (navigate away, unmount). Idempotent:
    a already-gone session just returns cancelled=false."""
    cancelled = stream_manager.cancel(stream_id)
    return {"cancelled": cancelled}


@app.get("/stream/{stream_id}")
def get_stream(stream_id: str) -> dict:
    session = stream_manager.get(stream_id)
    if not session:
        raise HTTPException(404, "stream not found")
    return {
        "stream_id": session.id,
        "status": session.status,
        "stage": session.stage,
        "live_text": session.live_text,
        "result": session.result,
        "error": session.error,
        "original_name": session.original_name,
        "transcribe_seconds": session.transcribe_seconds,
        "started_at": session.started_at,
        "created_at": session.created_at,
    }


@app.get("/stream/{stream_id}/events")
async def stream_events(stream_id: str):
    session = stream_manager.get(stream_id)
    if not session:
        raise HTTPException(404, "stream not found")

    async def stream():
        # Late joiner: replay the transcript so far, then stream new deltas.
        if session.live_text:
            yield {"event": "transcribe", "data": json.dumps({"text": session.live_text})}
        if session.status in ("done", "error"):
            yield {"event": session.status, "data": json.dumps({"stage": session.stage})}
            return
        assert session.queue is not None
        while True:
            try:
                event: ProgressEvent = await asyncio.wait_for(session.queue.get(), timeout=30)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "keepalive"}
                continue
            payload = {"stage": event.stage}
            # For "transcribe" events, `message` is the newly-appended text delta.
            if event.stage == "transcribe" and event.message:
                payload["delta"] = event.message
            elif event.message:
                payload["message"] = event.message
            yield {"event": event.stage, "data": json.dumps(payload)}
            if event.stage in ("done", "error"):
                break

    return EventSourceResponse(stream())


@app.get("/stream/{stream_id}/download/{fmt}")
def download_stream(stream_id: str, fmt: str):
    if fmt not in ("txt", "srt", "json"):
        raise HTTPException(400, "fmt must be txt, srt, or json")
    path = stream_manager.download_path(stream_id, fmt)
    if not path:
        raise HTTPException(404, "result not ready")
    session = stream_manager.get(stream_id)
    stem = Path(getattr(session, "original_name", "kayit")).stem or "kayit"
    media = {"txt": "text/plain", "srt": "application/x-subrip", "json": "application/json"}[fmt]
    return FileResponse(path, media_type=media, filename=f"{stem}.{fmt}")


# ---------------------------------------------------------------------------
# Transcript reuse — browse transcripts the CLI/pipeline already wrote to
# repo_root/out/*.json so the UI can feed one straight into note generation
# without re-uploading audio. Read-only; the pipeline owns writing them.
# ---------------------------------------------------------------------------


def _transcript_text(data: dict) -> str:
    """Flatten a transcript JSON's turns into "Speaker: text" lines (mirrors how
    the web UI builds transcript text from result.turns)."""
    lines = []
    for turn in data.get("turns", []) or []:
        speaker = turn.get("speaker", "")
        text = turn.get("text", "")
        lines.append(f"{speaker}: {text}")
    return "\n".join(lines)


@app.get("/transcripts")
def list_transcripts() -> dict:
    """List every out/*.json transcript (name = filename stem). Skips unreadable
    files so one bad JSON doesn't break the listing."""
    items = []
    if OUT_DIR.is_dir():
        for path in sorted(OUT_DIR.glob("*.json"), key=lambda p: p.stem):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - skip unreadable/invalid files
                continue
            items.append({
                "name": path.stem,
                "turns": len(data.get("turns", []) or []),
                "language": data.get("language"),
                "num_speakers": data.get("num_speakers"),
                "transcribe_seconds": data.get("transcribe_seconds"),
            })
    return {"transcripts": items}


@app.get("/transcripts/{name}")
def get_transcript(name: str) -> dict:
    """Return one transcript's flattened text. `name` must be a known stem — we
    reject anything with path separators / traversal and confirm the stem is in
    the listing before touching the filesystem."""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "invalid transcript name")
    path = OUT_DIR / f"{name}.json"
    # Only allow a stem that actually exists as out/<name>.json (defense-in-depth
    # on top of the character checks above).
    if not path.is_file() or path.parent.resolve() != OUT_DIR.resolve():
        raise HTTPException(404, "transcript not found")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        raise HTTPException(404, "transcript not readable")
    return {
        "name": name,
        "language": data.get("language"),
        "num_speakers": data.get("num_speakers"),
        "text": _transcript_text(data),
        "transcribe_seconds": data.get("transcribe_seconds"),
    }


# ---------------------------------------------------------------------------
# Clinical note generation (note_core) — mirrors the transcription job pattern.
# The provider is chosen by the OPERATOR via server env (STT_NOTE_PROVIDER),
# never by the browser (ADR-0009). No cloud token is ever accepted or logged.
# ---------------------------------------------------------------------------


def _note_provider() -> str:
    return os.environ.get("STT_NOTE_PROVIDER", "ollama").strip().lower()


class NoteRequest(BaseModel):
    transcript: str
    template: str = "soap"
    template_text: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    title: Optional[str] = None
    source_name: Optional[str] = None
    # How long the source transcription took (carried from the chosen transcript
    # or the just-finished job) so the note can report both timings.
    transcribe_seconds: Optional[float] = None
    # Audio-linked source transcript (ADR-0019): the structured turns to persist
    # for the "Kaynak deşifre" panel, and the originating job/stream id whose audio
    # to copy into the durable store. Both optional (reused transcripts have neither).
    transcript_json: Optional[list] = None
    audio_source_id: Optional[str] = None
    # Encounter metadata captured up front (ADR-0022) — all optional.
    patient_id: Optional[str] = None
    visit_type: Optional[str] = None
    chief_complaint: Optional[str] = None


@app.get("/notes")
def list_notes(patient_id: Optional[str] = None, q: Optional[str] = None) -> dict:
    """Durable note history (summary rows, newest first). Distinct route from the
    static /notes/templates and the parameterized /notes/{id}. Optional
    ?patient_id=… filters to one patient (ADR-0016); ?q=… case-insensitively
    searches title/patient/body (ADR-0018); both compose."""
    return {"notes": note_store.list(patient_id=patient_id, q=q)}


@app.get("/notes/active")
def list_active_notes() -> dict:
    """Active (queued/running/failed) note generations for the sidebar. Finished
    notes live in the durable history (/notes)."""
    return {"notes": note_manager.list_active()}


@app.get("/notes/templates")
def note_templates() -> dict:
    """List note formats + the operator's provider config so the UI can show the
    right picker and PHI warning. Built-in templates, then the user's CUSTOM
    templates (ADR-0021, key "custom:<id>"), then a "free" paste option."""
    provider = _note_provider()
    custom = [
        {
            "key": f"custom:{t['id']}",
            "label": t["name"],
            "description": "Özel şablon",
            "custom": True,
        }
        for t in note_store.list_templates()
    ]
    templates = list(TEMPLATE_CHOICES) + custom + [{
        "key": "free",
        "label": "Paste my own format",
        "description": "Paste a sample note in your own layout; the note will follow it.",
    }]
    return {
        "templates": templates,
        "provider": provider,
        "cloud_enabled": provider == "claude",
    }


# --- custom note template CRUD (ADR-0021) ----------------------------------


class TemplateBody(BaseModel):
    name: Optional[str] = None
    body: Optional[str] = None


@app.get("/note-templates")
def list_custom_templates() -> dict:
    """The user's custom note templates (id, name, body, created_at)."""
    return {"templates": note_store.list_templates()}


@app.post("/note-templates", status_code=201)
def create_custom_template(body: TemplateBody) -> dict:
    try:
        return note_store.create_template(body.name or "", body.body or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/note-templates/{template_id}")
def update_custom_template(template_id: str, body: TemplateBody) -> dict:
    try:
        tpl = note_store.update_template(template_id, body.name, body.body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not tpl:
        raise HTTPException(404, "template not found")
    return tpl


@app.delete("/note-templates/{template_id}")
def delete_custom_template(template_id: str) -> dict:
    if not note_store.delete_template(template_id):
        raise HTTPException(404, "template not found")
    return {"deleted": True}


@app.get("/notes/providers")
def note_providers() -> dict:
    """Providers the UI may offer (built-ins + any enabled local plugin), each
    with its models and an `off_device` flag driving the PHI warning. The set is
    gated by the operator (STT_NOTE_PROVIDERS) and each provider's availability —
    so committed/default config exposes only the local model."""
    return {"providers": list_providers(), "default_provider": _note_provider()}


@app.post("/notes", status_code=202)
async def create_note(body: NoteRequest) -> dict:
    # MUST be async: submit() binds the job to the running event loop via
    # asyncio.get_running_loop() (so the worker thread can push SSE events back
    # onto it). A sync handler runs off the loop thread and would raise
    # "no running event loop" — matching the transcription create_job endpoint.
    if not body.transcript or not body.transcript.strip():
        raise HTTPException(400, "transcript is empty — nothing to summarize.")

    provider = (body.provider or _note_provider()).strip().lower()

    # Validate the chosen provider against the enabled set (allowlist +
    # availability). This both rejects a bogus/disabled provider up front and
    # lets us fill in a sensible model for non-built-in providers, whose default
    # model NoteOptions can't know about.
    descriptors = {p["key"]: p for p in list_providers()}
    if provider not in descriptors:
        raise HTTPException(
            400,
            f"provider '{provider}' is not available. "
            f"Enabled: {sorted(descriptors) or ['ollama']}.",
        )
    model = body.model or descriptors[provider].get("default_model") or None

    # Resolve a CUSTOM template (key "custom:<id>", ADR-0021) server-side to a
    # saved "free" sample — so note_core is unchanged. Never trust a body from the
    # client for a saved template; a missing id is a clear 4xx.
    template = body.template
    template_text = body.template_text
    if template and template.startswith("custom:"):
        tpl = note_store.get_template(template.split(":", 1)[1])
        if not tpl:
            raise HTTPException(400, "custom template not found")
        template = "free"
        template_text = tpl["body"]

    opts = NoteOptions(
        provider=provider,
        model=model,
        template=template,
        template_text=template_text,
    )
    # Serialize the structured turns for persistence (ADR-0019), if provided.
    transcript_json = (
        json.dumps(body.transcript_json, ensure_ascii=False)
        if body.transcript_json else None
    )
    job = note_manager.register(
        body.transcript, opts,
        title=body.title, source_name=body.source_name,
        transcribe_seconds=body.transcribe_seconds,
        transcript_json=transcript_json,
        audio_source_id=body.audio_source_id,
        patient_id=body.patient_id,
        visit_type=body.visit_type,
        chief_complaint=body.chief_complaint,
    )
    note_manager.submit(job)
    return {"note_id": job.id, "status": job.status}


@app.post("/notes/{note_id}/retry", status_code=202)
async def retry_note(note_id: str) -> dict:
    """Re-run a failed note with the same transcript + options (no re-entry).
    async so submit() can bind to the running event loop (see create_note)."""
    job = note_manager.retry(note_id)
    if not job:
        raise HTTPException(404, "note not found")
    return {"note_id": job.id, "status": job.status}


def _saved_note_response(saved) -> dict:
    """GET /notes/{id} shape for a persisted note. `note` is the EFFECTIVE body
    (clinician edit if any, else AI original); `ai_note`/`edited_note` expose the
    overlay so the UI can show/revert it; status/finalized_at drive the lifecycle
    UI (ADR-0015)."""
    return {
        "note_id": saved.id,
        "status": "done",  # generation status (the note exists); see note_status
        "provider": saved.provider,
        "model": saved.model,
        "template": saved.template,
        "note": saved.effective_note,
        "ai_note": saved.note,
        "edited_note": saved.edited_note,
        "edited": saved.edited,
        "note_status": saved.status,       # draft | final (edit lifecycle)
        "finalized_at": saved.finalized_at,
        "patient_id": saved.patient_id,
        "patient_name": note_store.patient_name(saved.patient_id),
        # Encounter metadata (ADR-0022).
        "visit_type": saved.visit_type,
        "chief_complaint": saved.chief_complaint,
        # Extracted structured lists (ADR-0023).
        "problems": saved.problems,
        "medications": saved.medications,
        "extracted": saved.extracted,
        # Structured STT-review flags, located to turns for audio seek (ADR-0029).
        "review_flags": saved.review_flags,
        # Audio-linked source transcript (ADR-0019): the turns + whether the
        # source recording is available at GET /notes/{id}/audio.
        "turns": saved.turns,
        "has_audio": note_audio_store.path(saved.id) is not None,
        "result": {
            "note": saved.effective_note,
            "provider": saved.provider,
            "model": saved.model,
            "template": saved.template,
        },
        "error": None,
        "created_at": saved.created_at,
        "title": saved.title,
        "source_name": saved.source_name,
        "transcript": saved.transcript,
        "transcribe_seconds": saved.transcribe_seconds,
        "note_seconds": saved.note_seconds,
    }


@app.get("/notes/{note_id}")
def get_note(note_id: str) -> dict:
    # The durable store is authoritative for a COMPLETED note's body + lifecycle
    # (edits/finalize live there — ADR-0015). Only fall back to the in-memory job
    # while it's still generating (not yet persisted).
    saved = note_store.get(note_id)
    if saved:
        return _saved_note_response(saved)
    job = note_manager.get(note_id)
    if job:
        return {
            "note_id": job.id,
            "status": job.status,
            "provider": job.opts.provider,
            "model": job.opts.resolved_model(),
            "template": job.opts.template,
            "note": job.note_text,       # accumulated text so far
            "result": job.result,
            "error": job.error,
            "transcribe_seconds": job.transcribe_seconds,
            "note_seconds": job.note_seconds,
            "started_at": job.started_at,
            "created_at": job.created_at,
        }
    raise HTTPException(404, "note not found")


@app.get("/notes/{note_id}/audio")
def get_note_audio(note_id: str):
    """Stream a note's stored source recording (ADR-0019). FileResponse supports
    range requests, so the browser <audio> element can seek. 404 if the note has
    no stored audio (reused transcript / cleaned before this feature)."""
    path = note_audio_store.path(note_id)
    if not path:
        raise HTTPException(404, "no audio for this note")
    ext = path.suffix.lower()
    media = {
        ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg",
        ".mp4": "audio/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
        ".flac": "audio/flac", ".aac": "audio/aac",
    }.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=media)


@app.delete("/notes/{note_id}")
def delete_note(note_id: str) -> dict:
    """Delete a note from durable history (and drop it from the in-memory
    manager if still present). 404 if neither had it."""
    in_memory = note_manager.discard(note_id)
    in_store = note_store.delete(note_id)
    note_audio_store.delete(note_id)  # also drop the linked source audio (ADR-0019)
    if not in_memory and not in_store:
        raise HTTPException(404, "note not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Edit / finalize lifecycle for a saved note (ADR-0015). Edits are an overlay on
# the durable store — the AI original is never overwritten; a note can be
# finalized (locked), reopened, and reverted to the AI draft.
# ---------------------------------------------------------------------------


class NoteEditBody(BaseModel):
    note: str


@app.patch("/notes/{note_id}")
def edit_note(note_id: str, body: NoteEditBody) -> dict:
    """Save a clinician-edited body as an overlay. 404 if unknown, 409 if final."""
    if body.note is None:
        raise HTTPException(400, "note body is required")
    try:
        saved = note_store.update_body(note_id, body.note)
    except NoteLockedError as e:
        raise HTTPException(409, str(e))
    if not saved:
        raise HTTPException(404, "note not found")
    return _saved_note_response(saved)


class TurnCorrectionBody(BaseModel):
    turn_index: int
    text: str


@app.patch("/notes/{note_id}/turns")
def correct_transcript_turn(note_id: str, body: TurnCorrectionBody) -> dict:
    """Correct a single source-transcript turn's text after the doctor verified it
    against the audio (ADR-0029). Fixes ONLY the transcript turn (marks it
    `corrected` + resolves any STT-review flag on that turn); never touches the note
    body. 404 if the note or turn index is unknown. This is the manual STT-error
    correction path — the corrected turn is a real, human-verified label."""
    if body.text is None:
        raise HTTPException(400, "corrected text is required")
    saved = note_store.update_transcript_turn(note_id, body.turn_index, body.text)
    if not saved:
        raise HTTPException(404, "note or turn not found")
    return _saved_note_response(saved)


@app.post("/notes/{note_id}/rediar")
def rediarize_note(note_id: str) -> dict:
    """Re-assign speaker labels on the note's transcript using the local LLM's
    doctor-asks/parent-answers reasoning (ADR-0030) — the fix for the short-turn
    speaker-merge failure where acoustic diarization collapses similar voices into
    one speaker. Runs on the transcript SEGMENTS/turns, applies the new labeling
    ONLY if it passes the acceptance guard (>=80% coverage AND >=2 distinct roles),
    else leaves the acoustic labels unchanged (fail-closed). Never touches the note
    body. PHI stays local (Ollama). Returns the updated note + a rediar summary."""
    from note_core.models import NoteOptions
    from note_core.providers import ProviderError
    from note_core.rediar import apply_relabel, relabel_turns

    saved = note_store.get(note_id)
    if not saved:
        raise HTTPException(404, "note not found")
    turns = saved.turns
    if not turns:
        raise HTTPException(400, "note has no source transcript turns to re-label")
    try:
        res = relabel_turns(turns, NoteOptions(temperature=0.0))
    except ProviderError as e:
        raise HTTPException(502, str(e))
    relabeled = apply_relabel(turns, res)
    if res.applied:
        note_store.set_transcript_turns(note_id, relabeled)
    saved = note_store.get(note_id)
    out = _saved_note_response(saved)
    out["rediar"] = {"applied": res.applied, "coverage": res.coverage,
                     "n_roles": res.n_roles, "provider": res.provider, "model": res.model}
    return out


@app.post("/notes/{note_id}/finalize")
def finalize_note(note_id: str) -> dict:
    """Mark a note final (locks edits) + stamp finalized_at."""
    from datetime import datetime, timezone
    saved = note_store.set_status(
        note_id, "final", datetime.now(timezone.utc).isoformat()
    )
    if not saved:
        raise HTTPException(404, "note not found")
    return _saved_note_response(saved)


@app.post("/notes/{note_id}/reopen")
def reopen_note(note_id: str) -> dict:
    """Return a finalized note to draft so it can be edited again."""
    saved = note_store.set_status(note_id, "draft", None)
    if not saved:
        raise HTTPException(404, "note not found")
    return _saved_note_response(saved)


@app.post("/notes/{note_id}/revert")
def revert_note(note_id: str) -> dict:
    """Clear the edit overlay so the effective body is the AI original again.
    404 if unknown, 409 if final (reopen first)."""
    try:
        saved = note_store.revert(note_id)
    except NoteLockedError as e:
        raise HTTPException(409, str(e))
    if not saved:
        raise HTTPException(404, "note not found")
    return _saved_note_response(saved)


# --- problem & medication extraction (ADR-0023) ----------------------------


@app.post("/notes/{note_id}/extract")
def extract_note_lists(note_id: str) -> dict:
    """Extract a structured problem + medication list from the note's EFFECTIVE
    body via the configured provider (local default), persist, and return the
    updated note. Sync (a single short generation) — FastAPI runs `def` handlers
    in a threadpool so the event loop isn't blocked. Re-runnable (overwrites).
    Allowed on draft or final (extraction is derived metadata, not the body)."""
    saved = note_store.get(note_id)
    if not saved:
        raise HTTPException(404, "note not found")
    # Same provider gating/resolution as note generation (ADR-0009): default
    # local; off-device only if the operator opted in.
    opts = NoteOptions(provider=_note_provider())
    try:
        result = extract_note(saved.effective_note, opts)
    except ProviderError as e:
        # Provider-level failure (unreachable/misconfigured/cloud-not-opted-in) —
        # surface a clean 4xx; no data was sent when the cloud path is refused.
        raise HTTPException(400, str(e))
    updated = note_store.set_extraction(note_id, result.problems, result.medications)
    if not updated:
        raise HTTPException(404, "note not found")
    return _saved_note_response(updated)


# --- version history (ADR-0020) --------------------------------------------


class RestoreBody(BaseModel):
    version_id: str


@app.get("/notes/{note_id}/versions")
def list_note_versions(note_id: str) -> dict:
    """A note's prior saved bodies, newest first (ADR-0020). Only meaningful for a
    persisted note; returns [] for an unknown/never-edited note."""
    return {"versions": note_store.list_versions(note_id)}


@app.post("/notes/{note_id}/restore")
def restore_note_version(note_id: str, body: RestoreBody) -> dict:
    """Restore a prior version as the current edited body. 404 if the note or
    version is unknown, 409 if the note is finalized (reopen first)."""
    try:
        saved = note_store.restore_version(note_id, body.version_id)
    except NoteLockedError as e:
        raise HTTPException(409, str(e))
    if not saved:
        raise HTTPException(404, "note or version not found")
    return _saved_note_response(saved)


# ---------------------------------------------------------------------------
# Patient organization (ADR-0016). A lightweight patient entity a note can be
# filed under; browse/filter notes by patient. Patient data is PHI — same
# git-ignored project-local DB (ADR-0010/0003), never logged.
# ---------------------------------------------------------------------------


class PatientBody(BaseModel):
    name: str
    mrn: Optional[str] = None


class NotePatientBody(BaseModel):
    patient_id: Optional[str] = None  # None clears the assignment


@app.get("/patients")
def list_patients() -> dict:
    """All patients (name order) with each one's note count."""
    return {"patients": note_store.list_patients()}


@app.post("/patients", status_code=201)
def create_patient(body: PatientBody) -> dict:
    """Create a patient — or reuse an existing one with the same name (ADR-0016)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "patient name is required")
    patient = note_store.create_patient(name, (body.mrn or "").strip() or None)
    return patient.to_dict()


@app.get("/patients/{patient_id}")
def get_patient(patient_id: str) -> dict:
    """A patient + its notes (newest-first) + the union rollup of problems/meds
    across those notes (ADR-0024). Rollup is pure aggregation — no model call."""
    patient = note_store.get_patient(patient_id)
    if not patient:
        raise HTTPException(404, "patient not found")
    d = patient.to_dict()
    d["notes"] = note_store.list(patient_id=patient_id)
    problems, medications = note_store.patient_rollup(patient_id)
    d["problems_summary"] = problems
    d["medications_summary"] = medications
    return d


@app.put("/notes/{note_id}/patient")
def set_note_patient(note_id: str, body: NotePatientBody) -> dict:
    """(Re)file a note under a patient, or clear it. Allowed even when the note is
    final — filing is metadata, not content (REQ-139)."""
    try:
        saved = note_store.set_note_patient(note_id, body.patient_id or None)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not saved:
        raise HTTPException(404, "note not found")
    return _saved_note_response(saved)


@app.get("/notes/{note_id}/events")
async def note_events(note_id: str):
    job = note_manager.get(note_id)
    if not job:
        raise HTTPException(404, "note not found")

    async def stream():
        # If generation already finished before the client connected, emit a final event.
        if job.status in ("done", "error"):
            payload = {"stage": job.stage}
            if job.error:
                payload["message"] = job.error
            yield {"event": job.status, "data": json.dumps(payload)}
            return
        assert job.queue is not None
        while True:
            try:
                event: NoteEvent = await asyncio.wait_for(job.queue.get(), timeout=30)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "keepalive"}
                continue
            payload = {"stage": event.stage}
            if event.delta:
                payload["delta"] = event.delta
            if event.message:
                payload["message"] = event.message
            yield {"event": event.stage, "data": json.dumps(payload)}
            if event.stage in ("done", "error"):
                break

    return EventSourceResponse(stream())


def run() -> None:
    """`stt-api` entry point — dev server on 127.0.0.1:8000."""
    import uvicorn
    uvicorn.run("stt_api.main:app", host="127.0.0.1", port=8000, reload=False)
