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

// ---------------------------------------------------------------------------
// Clinical note generation
// ---------------------------------------------------------------------------

/** Lifecycle status of a note-generation job (mirrors the transcription job). */
export type NoteJobStatus = "queued" | "running" | "done" | "error";

/** Stage names emitted by note_core's progress callback / SSE stream. */
export type NoteStage = "start" | "generating" | "done" | "error";

/** A single selectable note template, as returned by GET /notes/templates. */
export interface NoteTemplate {
  key: string;
  label: string;
  description: string;
}

/** GET /notes/templates response. */
export interface NoteTemplatesResponse {
  templates: NoteTemplate[];
  provider: string;
  cloud_enabled: boolean;
}

/** One selectable model within a provider. */
export interface ProviderModel {
  id: string;
  label: string;
}

/** A selectable note provider, from GET /notes/providers. `off_device` drives
 *  the PHI warning (the transcript leaves the machine when true). */
export interface ProviderInfo {
  key: string;
  label: string;
  models: ProviderModel[];
  default_model: string | null;
  off_device: boolean;
}

/** GET /notes/providers response. */
export interface ProvidersResponse {
  providers: ProviderInfo[];
  default_provider: string;
}

/** Body for POST /notes. */
export interface CreateNoteBody {
  transcript: string;
  template: string;
  template_text?: string;
  provider?: string;
  model?: string;
  title?: string;
  source_name?: string;
}

/** A reusable transcript from out/*.json (GET /transcripts). */
export interface TranscriptInfo {
  name: string;
  turns: number;
  language: string;
  num_speakers: number;
}

/** A chosen transcript's flattened text (GET /transcripts/{name}). */
export interface TranscriptText {
  name: string;
  language: string;
  num_speakers: number;
  text: string;
}

/** One saved note in the history list (GET /notes). */
export interface SavedNoteSummary {
  id: string;
  created_at: string;
  title: string;
  source_name: string | null;
  provider: string;
  model: string;
  template: string;
}

/** POST /notes response. */
export interface CreateNoteResponse {
  note_id: string;
  status: NoteJobStatus;
}

/** Structured result from note_core.NoteResult (via GET /notes/{id}). */
export interface NoteResult {
  provider: string;
  model: string;
  template: string;
  note: string;
  stopped_early: boolean;
  usage: Record<string, unknown>;
}

/** GET /notes/{id} response — the note job status + result. */
export interface Note {
  note_id: string;
  status: NoteJobStatus;
  provider: string | null;
  model: string | null;
  template: string | null;
  note: string | null;
  result: NoteResult | null;
  error: string | null;
}

/**
 * Payload carried by the named SSE events on /notes/{id}/events. During
 * "generating" the server sends incremental text in `delta`.
 */
export interface NoteSSEPayload {
  stage?: NoteStage;
  delta?: string;
  message?: string;
}
