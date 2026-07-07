// Single source of truth for the backend API base URL + typed fetch helpers.

import type {
  CreateJobResponse,
  DownloadFormat,
  HealthResponse,
  Job,
  JobOptions,
} from "../types";

export const API = "http://127.0.0.1:8000";

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
    throw new Error(
      `Request failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
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
