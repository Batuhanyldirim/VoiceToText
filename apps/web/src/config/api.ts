// Single source of truth for the backend API base URL + typed fetch helpers.

import type {
  CreateJobResponse,
  CreateNoteBody,
  CreateNoteResponse,
  DownloadFormat,
  HealthResponse,
  Job,
  JobOptions,
  Note,
  NoteTemplatesResponse,
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
// Clinical note generation
// ---------------------------------------------------------------------------

/** List the available note templates + which provider the server will use. */
export async function getNoteTemplates(
  signal?: AbortSignal,
): Promise<NoteTemplatesResponse> {
  const res = await fetch(`${API}/notes/templates`, { signal });
  return asJson<NoteTemplatesResponse>(res);
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
