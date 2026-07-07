// Shared domain types for the VoiceToText frontend.

export type JobStatus = "queued" | "running" | "done" | "error";

export type Stage =
  | "enhance"
  | "transcribe"
  | "align"
  | "diarize"
  | "fuse"
  | "done"
  | "error";

export interface Turn {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/** Word/segment level payload from the backend. Shape is loose on purpose. */
export interface Segment {
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export interface JobResult {
  audio: string | null;
  language: string;
  num_speakers: number;
  speaker_map: Record<string, string>;
  turns: Turn[];
  segments: Segment[];
}

export interface Job {
  job_id: string;
  status: JobStatus;
  stage: Stage | null;
  percent: number | null;
  result: JobResult | null;
  error: string | null;
  original_name: string | null;
}

export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
}

export interface HealthResponse {
  status: string;
  hf_token: boolean;
}

export type ModelName = "large-v3" | "small";

export interface JobOptions {
  language?: string;
  min_speakers?: number;
  max_speakers?: number;
  diarize: boolean;
  model: ModelName;
}

export type DownloadFormat = "txt" | "srt" | "json";

/** Payload carried by every named SSE event on /jobs/{id}/events. */
export interface SSEPayload {
  stage: Stage;
  percent?: number;
  message?: string;
}
