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

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from note_core import NoteOptions, TEMPLATE_CHOICES, list_providers
from note_core.progress import NoteEvent
from stt_core import TranscribeOptions
from stt_core.progress import ProgressEvent

from .jobs import JobManager
from .notes import NoteJobManager
from .store import NoteStore

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
# Durable note history (SQLite, project-local, git-ignored — ADR-0003). The
# worker persists completed notes here; the /notes history endpoints read it.
note_store = NoteStore()
note_manager = NoteJobManager(store=note_store)

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
    language: Optional[str] = Form(None),
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(None),
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

    opts = TranscribeOptions(
        model=model, language=language or None,
        diarize=diarize, min_speakers=min_speakers, max_speakers=max_speakers,
        hf_token=hf_token,
    )
    job = manager.register(job_id, job_dir, input_path, filename, opts)
    manager.submit(job)
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs")
def list_jobs() -> dict:
    """Active (queued/running/failed) transcriptions for the sidebar. Finished
    jobs are excluded — their transcript is shown on the result screen."""
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


@app.get("/notes")
def list_notes() -> dict:
    """Durable note history (summary rows, newest first). Distinct route from the
    static /notes/templates and the parameterized /notes/{id}."""
    return {"notes": note_store.list()}


@app.get("/notes/active")
def list_active_notes() -> dict:
    """Active (queued/running/failed) note generations for the sidebar. Finished
    notes live in the durable history (/notes)."""
    return {"notes": note_manager.list_active()}


@app.get("/notes/templates")
def note_templates() -> dict:
    """List note formats + the operator's provider config so the UI can show the
    right picker and PHI warning. Includes a "free" paste option alongside the
    built-in templates."""
    provider = _note_provider()
    templates = list(TEMPLATE_CHOICES) + [{
        "key": "free",
        "label": "Paste my own format",
        "description": "Paste a sample note in your own layout; the note will follow it.",
    }]
    return {
        "templates": templates,
        "provider": provider,
        "cloud_enabled": provider == "claude",
    }


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

    opts = NoteOptions(
        provider=provider,
        model=model,
        template=body.template,
        template_text=body.template_text,
    )
    job = note_manager.register(
        body.transcript, opts,
        title=body.title, source_name=body.source_name,
        transcribe_seconds=body.transcribe_seconds,
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


@app.get("/notes/{note_id}")
def get_note(note_id: str) -> dict:
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
    # Not live in memory — fall back to durable history so browsing a past note
    # returns its full body in the same response shape (status="done").
    saved = note_store.get(note_id)
    if not saved:
        raise HTTPException(404, "note not found")
    return {
        "note_id": saved.id,
        "status": "done",
        "provider": saved.provider,
        "model": saved.model,
        "template": saved.template,
        "note": saved.note,
        "result": {
            "note": saved.note,
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


@app.delete("/notes/{note_id}")
def delete_note(note_id: str) -> dict:
    """Delete a note from durable history (and drop it from the in-memory
    manager if still present). 404 if neither had it."""
    in_memory = note_manager.discard(note_id)
    in_store = note_store.delete(note_id)
    if not in_memory and not in_store:
        raise HTTPException(404, "note not found")
    return {"deleted": True}


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
