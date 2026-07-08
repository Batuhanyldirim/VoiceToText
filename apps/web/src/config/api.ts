// Single source of truth for the backend API base URL + typed fetch helpers.

import type {
  ActiveJob,
  ActiveNote,
  CreateJobResponse,
  CreateNoteBody,
  CreateNoteResponse,
  CreateStreamResponse,
  DownloadFormat,
  HealthResponse,
  Job,
  JobOptions,
  Note,
  NoteTemplatesResponse,
  ProvidersResponse,
  SavedNoteSummary,
  StreamStatus,
  TranscriptInfo,
  TranscriptText,
} from "../types";

export const API = "http://127.0.0.1:8000";

/** Error carrying the HTTP status so callers can distinguish a terminal 404
 * (e.g. a job that vanished when the server restarted) from a transient blip. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail =
        typeof body === "object" && body && "detail" in body
          ? String((body as { detail: unknown }).detail)
          : JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new ApiError(
      `Request failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API}/health`, { signal });
  return asJson<HealthResponse>(res);
}

export async function createJob(
  file: File,
  options: JobOptions,
  signal?: AbortSignal,
): Promise<CreateJobResponse> {
  const form = new FormData();
  form.append("file", file);
  if (options.language && options.language.trim()) {
    form.append("language", options.language.trim());
  }
  if (typeof options.min_speakers === "number") {
    form.append("min_speakers", String(options.min_speakers));
  }
  if (typeof options.max_speakers === "number") {
    form.append("max_speakers", String(options.max_speakers));
  }
  form.append("diarize", String(options.diarize));
  form.append("model", options.model);

  const res = await fetch(`${API}/jobs`, {
    method: "POST",
    body: form,
    signal,
  });
  return asJson<CreateJobResponse>(res);
}

export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  const res = await fetch(`${API}/jobs/${encodeURIComponent(id)}`, { signal });
  return asJson<Job>(res);
}

/** URL for the Server-Sent Events stream of a job. */
export function jobEventsUrl(id: string): string {
  return `${API}/jobs/${encodeURIComponent(id)}/events`;
}

/** URL for a downloadable transcript in the given format. */
export function downloadUrl(id: string, fmt: DownloadFormat): string {
  return `${API}/jobs/${encodeURIComponent(id)}/download/${fmt}`;
}

// ---------------------------------------------------------------------------
// Live (streaming) transcription — transcribe WHILE recording (ADR-0014).
// The recorder captures raw PCM and streams it here; the server transcribes
// silence-cut chunks incrementally and diarizes once at finish.
// ---------------------------------------------------------------------------

/** Open a live transcription session. Options mirror createJob's. */
export async function openStream(
  options: JobOptions,
  name: string,
  signal?: AbortSignal,
): Promise<CreateStreamResponse> {
  const form = new FormData();
  if (options.language && options.language.trim()) {
    form.append("language", options.language.trim());
  }
  if (typeof options.min_speakers === "number") {
    form.append("min_speakers", String(options.min_speakers));
  }
  if (typeof options.max_speakers === "number") {
    form.append("max_speakers", String(options.max_speakers));
  }
  form.append("diarize", String(options.diarize));
  form.append("model", options.model);
  form.append("name", name);
  const res = await fetch(`${API}/stream`, { method: "POST", body: form, signal });
  return asJson<CreateStreamResponse>(res);
}

/** Append a raw PCM frame (little-endian int16 mono @ 16 kHz) to a session. */
export async function sendStreamAudio(
  id: string,
  pcm: Int16Array,
  signal?: AbortSignal,
): Promise<void> {
  // Copy the exact bytes for this frame into a fresh ArrayBuffer (the view may be
  // a slice of a pooled/shared buffer; a plain ArrayBuffer is a valid BodyInit).
  const body = new ArrayBuffer(pcm.byteLength);
  new Int16Array(body).set(pcm);
  await fetch(`${API}/stream/${encodeURIComponent(id)}/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    signal,
  });
}

/** Signal end-of-recording: the server flushes the tail + diarizes. */
export async function finishStream(id: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API}/stream/${encodeURIComponent(id)}/finish`, {
    method: "POST",
    signal,
  });
  await asJson<{ stream_id: string }>(res);
}

/** Abandon a session without finalizing (recorder torn down before finish) so the
 *  server frees its worker + buffered audio. Best-effort — errors are ignored. */
export async function cancelStream(id: string): Promise<void> {
  try {
    await fetch(`${API}/stream/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* best-effort cleanup */
  }
}

/** Poll a session's status + growing transcript + final result. */
export async function getStream(id: string, signal?: AbortSignal): Promise<StreamStatus> {
  const res = await fetch(`${API}/stream/${encodeURIComponent(id)}`, { signal });
  return asJson<StreamStatus>(res);
}

/** URL for the SSE stream of transcript deltas + stages. */
export function streamEventsUrl(id: string): string {
  return `${API}/stream/${encodeURIComponent(id)}/events`;
}

// ---------------------------------------------------------------------------
// Clinical note generation
// ---------------------------------------------------------------------------

/** List the available note templates + which provider the server will use. */
export async function getNoteTemplates(
  signal?: AbortSignal,
): Promise<NoteTemplatesResponse> {
  const res = await fetch(`${API}/notes/templates`, { signal });
  return asJson<NoteTemplatesResponse>(res);
}

/** List the note providers the UI may offer (+ the default). */
export async function getProviders(
  signal?: AbortSignal,
): Promise<ProvidersResponse> {
  const res = await fetch(`${API}/notes/providers`, { signal });
  return asJson<ProvidersResponse>(res);
}

/** Kick off a note-generation job from a transcript. */
export async function createNote(
  body: CreateNoteBody,
  signal?: AbortSignal,
): Promise<CreateNoteResponse> {
  const res = await fetch(`${API}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return asJson<CreateNoteResponse>(res);
}

/** Fetch the current status + result of a note-generation job. */
export async function getNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}`, { signal });
  return asJson<Note>(res);
}

/** URL for the Server-Sent Events token stream of a note job. */
export function noteEventsUrl(id: string): string {
  return `${API}/notes/${encodeURIComponent(id)}/events`;
}

// ---------------------------------------------------------------------------
// Transcript reuse + note history
// ---------------------------------------------------------------------------

/** List existing CLI transcripts under out/*.json, available for reuse. */
export async function getTranscripts(
  signal?: AbortSignal,
): Promise<TranscriptInfo[]> {
  const res = await fetch(`${API}/transcripts`, { signal });
  const body = await asJson<{ transcripts: TranscriptInfo[] }>(res);
  return body.transcripts ?? [];
}

/** Fetch a chosen transcript's flattened text (to feed into a note). */
export async function getTranscript(
  name: string,
  signal?: AbortSignal,
): Promise<TranscriptText> {
  const res = await fetch(`${API}/transcripts/${encodeURIComponent(name)}`, {
    signal,
  });
  return asJson<TranscriptText>(res);
}

/** List saved notes (history), newest first. */
export async function listNotes(
  signal?: AbortSignal,
): Promise<SavedNoteSummary[]> {
  const res = await fetch(`${API}/notes`, { signal });
  const body = await asJson<{ notes: SavedNoteSummary[] }>(res);
  return body.notes ?? [];
}

/** Delete a saved note from history. */
export async function deleteNote(
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });
  const body = await asJson<{ deleted: boolean }>(res);
  return body.deleted ?? false;
}

// ---------------------------------------------------------------------------
// Active (in-progress / failed) work — shown at the top of the sidebar
// ---------------------------------------------------------------------------

/** List active (queued/running/failed) transcriptions. */
export async function listActiveJobs(signal?: AbortSignal): Promise<ActiveJob[]> {
  const res = await fetch(`${API}/jobs`, { signal });
  const body = await asJson<{ jobs: ActiveJob[] }>(res);
  return body.jobs ?? [];
}

/** List active (queued/running/failed) note generations. */
export async function listActiveNotes(signal?: AbortSignal): Promise<ActiveNote[]> {
  const res = await fetch(`${API}/notes/active`, { signal });
  const body = await asJson<{ notes: ActiveNote[] }>(res);
  return body.notes ?? [];
}

/** Retry a failed transcription with the same uploaded audio. */
export async function retryJob(id: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API}/jobs/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    signal,
  });
  await asJson<{ job_id: string }>(res);
}

/** Retry a failed note with the same transcript + options. */
export async function retryNote(id: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    signal,
  });
  await asJson<{ note_id: string }>(res);
}
