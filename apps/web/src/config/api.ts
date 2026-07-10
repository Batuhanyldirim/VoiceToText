// Single source of truth for the backend API base URL + typed fetch helpers.

import type {
  ActiveJob,
  ActiveNote,
  CreateJobResponse,
  CreateNoteBody,
  CreateNoteResponse,
  CreateStreamResponse,
  CustomTemplate,
  DownloadFormat,
  HealthResponse,
  Job,
  JobOptions,
  Note,
  NoteTemplatesResponse,
  NoteVersion,
  Patient,
  PatientDetail,
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

/** URL of a note's source recording (range-enabled; ADR-0019). */
export function noteAudioUrl(id: string): string {
  return `${API}/notes/${encodeURIComponent(id)}/audio`;
}

/** Re-assign speaker labels on the note's transcript via the local LLM's
 * doctor-asks/parent-answers reasoning (ADR-0030) — recovers the speaker split
 * when acoustic diarization merged similar voices. Applies only if confident
 * (fail-closed). Returns the updated note (with a `rediar` summary field). */
export async function rediarizeNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/rediar`, {
    method: "POST",
    signal,
  });
  return asJson<Note>(res);
}

/** Correct a single source-transcript turn after verifying it against the audio
 * (ADR-0029). Fixes only the transcript turn + resolves its STT-review flag;
 * never touches the note body. Returns the updated note.
 *
 * When the edit came from a single flag, pass its `flagIndex` + `newQuote` (the
 * corrected phrase): only that flag resolves and its quote re-anchors to the new
 * text, so it can be re-edited later. Omit for a full-turn edit. */
export async function correctTurn(
  id: string,
  turnIndex: number,
  text: string,
  opts?: { flagIndex?: number; newQuote?: string },
  signal?: AbortSignal,
): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/turns`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turn_index: turnIndex,
      text,
      ...(opts?.flagIndex != null ? { flag_index: opts.flagIndex } : {}),
      ...(opts?.newQuote != null ? { new_quote: opts.newQuote } : {}),
    }),
    signal,
  });
  return asJson<Note>(res);
}

/** Mark an STT-review flag reviewed without editing the transcript (ADR-0029):
 * the doctor checked it against the audio and the text is already correct. Tags
 * it resolution="acknowledged". Pass resolved=false to un-acknowledge. Returns
 * the updated note. */
export async function resolveFlag(
  id: string,
  flagIndex: number,
  resolved = true,
  signal?: AbortSignal,
): Promise<Note> {
  const res = await fetch(
    `${API}/notes/${encodeURIComponent(id)}/flags/${flagIndex}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved }),
      signal,
    },
  );
  return asJson<Note>(res);
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

/** List saved notes (history), newest first. Optionally filter by patient and/or
 *  a search query (matched against title / patient / body). */
export async function listNotes(
  signal?: AbortSignal,
  patientId?: string,
  q?: string,
): Promise<SavedNoteSummary[]> {
  const params = new URLSearchParams();
  if (patientId) params.set("patient_id", patientId);
  if (q && q.trim()) params.set("q", q.trim());
  const qs = params.toString();
  const res = await fetch(`${API}/notes${qs ? `?${qs}` : ""}`, { signal });
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
// Edit / finalize lifecycle for a saved note (ADR-0015)
// ---------------------------------------------------------------------------

/** Save a clinician-edited note body (overlay; AI original preserved). Throws
 *  ApiError(409) if the note is finalized. Returns the updated note. */
export async function editNote(
  id: string,
  note: string,
  signal?: AbortSignal,
): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
    signal,
  });
  return asJson<Note>(res);
}

/** Mark a note final (locks edits). */
export async function finalizeNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/finalize`, {
    method: "POST",
    signal,
  });
  return asJson<Note>(res);
}

/** Reopen a finalized note back to draft so it can be edited. */
export async function reopenNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/reopen`, {
    method: "POST",
    signal,
  });
  return asJson<Note>(res);
}

/** Discard the clinician edit overlay so the effective body is the AI draft. */
export async function revertNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/revert`, {
    method: "POST",
    signal,
  });
  return asJson<Note>(res);
}

/** Extract structured problem + medication lists from a note (ADR-0023).
 *  Synchronous on the server (one short generation); returns the updated note. */
export async function extractNote(id: string, signal?: AbortSignal): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/extract`, {
    method: "POST",
    signal,
  });
  return asJson<Note>(res);
}

// --- custom note templates (ADR-0021) --------------------------------------

/** List the user's custom note templates. */
export async function listCustomTemplates(
  signal?: AbortSignal,
): Promise<CustomTemplate[]> {
  const res = await fetch(`${API}/note-templates`, { signal });
  const body = await asJson<{ templates: CustomTemplate[] }>(res);
  return body.templates ?? [];
}

/** Create a custom template. */
export async function createCustomTemplate(
  name: string,
  body: string,
  signal?: AbortSignal,
): Promise<CustomTemplate> {
  const res = await fetch(`${API}/note-templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, body }),
    signal,
  });
  return asJson<CustomTemplate>(res);
}

/** Update a custom template (name and/or body). */
export async function updateCustomTemplate(
  id: string,
  fields: { name?: string; body?: string },
  signal?: AbortSignal,
): Promise<CustomTemplate> {
  const res = await fetch(`${API}/note-templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
    signal,
  });
  return asJson<CustomTemplate>(res);
}

/** Delete a custom template. */
export async function deleteCustomTemplate(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/note-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
  });
  await asJson<{ deleted: boolean }>(res);
}

// --- version history (ADR-0020) --------------------------------------------

/** A note's prior saved bodies, newest first. */
export async function listNoteVersions(
  id: string,
  signal?: AbortSignal,
): Promise<NoteVersion[]> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/versions`, { signal });
  const body = await asJson<{ versions: NoteVersion[] }>(res);
  return body.versions ?? [];
}

/** Restore a prior version as the current edited body. */
export async function restoreNoteVersion(
  id: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version_id: versionId }),
    signal,
  });
  return asJson<Note>(res);
}

// ---------------------------------------------------------------------------
// Patient organization (ADR-0016)
// ---------------------------------------------------------------------------

/** List all patients (name order) with each one's note count + last visit. */
export async function listPatients(signal?: AbortSignal): Promise<Patient[]> {
  const res = await fetch(`${API}/patients`, { signal });
  const body = await asJson<{ patients: Patient[] }>(res);
  return body.patients ?? [];
}

/** A patient + its notes + the union problem/med rollup (ADR-0024). */
export async function getPatient(id: string, signal?: AbortSignal): Promise<PatientDetail> {
  const res = await fetch(`${API}/patients/${encodeURIComponent(id)}`, { signal });
  return asJson<PatientDetail>(res);
}

/** Create a patient — or reuse an existing one with the same name. */
export async function createPatient(
  name: string,
  mrn?: string,
  signal?: AbortSignal,
): Promise<Patient> {
  const res = await fetch(`${API}/patients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mrn: mrn || undefined }),
    signal,
  });
  return asJson<Patient>(res);
}

/** (Re)file a note under a patient, or clear it (patientId=null). */
export async function setNotePatient(
  noteId: string,
  patientId: string | null,
  signal?: AbortSignal,
): Promise<Note> {
  const res = await fetch(`${API}/notes/${encodeURIComponent(noteId)}/patient`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_id: patientId }),
    signal,
  });
  return asJson<Note>(res);
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
