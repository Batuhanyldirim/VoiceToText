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
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from note_core import NoteOptions, TEMPLATE_CHOICES
from note_core.progress import NoteEvent
from stt_core import TranscribeOptions
from stt_core.progress import ProgressEvent

from .jobs import JobManager
from .notes import NoteJobManager

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
note_manager = NoteJobManager()

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
        "original_name": getattr(job, "original_name", None),
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


@app.post("/notes", status_code=202)
async def create_note(body: NoteRequest) -> dict:
    # MUST be async: submit() binds the job to the running event loop via
    # asyncio.get_running_loop() (so the worker thread can push SSE events back
    # onto it). A sync handler runs off the loop thread and would raise
    # "no running event loop" — matching the transcription create_job endpoint.
    if not body.transcript or not body.transcript.strip():
        raise HTTPException(400, "transcript is empty — nothing to summarize.")

    # If the browser omits provider, use the server default. We never let the
    # browser force cloud: note_core.get_provider gates "claude" behind the
    # server env, so a claude request without opt-in errors cleanly via
    # ProviderError inside the job (surfaced as status=error).
    opts = NoteOptions(
        provider=(body.provider or _note_provider()),
        model=body.model or None,
        template=body.template,
        template_text=body.template_text,
    )
    job = note_manager.register(body.transcript, opts)
    note_manager.submit(job)
    return {"note_id": job.id, "status": job.status}


@app.get("/notes/{note_id}")
def get_note(note_id: str) -> dict:
    job = note_manager.get(note_id)
    if not job:
        raise HTTPException(404, "note not found")
    return {
        "note_id": job.id,
        "status": job.status,
        "provider": job.opts.provider,
        "model": job.opts.resolved_model(),
        "template": job.opts.template,
        "note": job.note_text,       # accumulated text so far
        "result": job.result,
        "error": job.error,
    }


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
