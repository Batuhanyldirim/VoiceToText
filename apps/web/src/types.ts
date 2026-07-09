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
  /** True once a clinician manually corrected this turn against the audio (ADR-0029). */
  corrected?: boolean;
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
  transcribe_seconds?: number | null;
}

export interface Job {
  job_id: string;
  status: JobStatus;
  stage: Stage | null;
  percent: number | null;
  result: JobResult | null;
  error: string | null;
  original_name: string | null;
  /** Epoch SECONDS when the job's worker actually started (anchors the live
   *  timer so it survives a refresh). Null until running. */
  started_at?: number | null;
  created_at?: string | null;
}

/** One active (queued/running/failed) transcription, for the sidebar. */
export interface ActiveJob {
  id: string;
  kind: "transcription";
  status: JobStatus;
  stage: Stage | null;
  percent: number | null;
  name: string;
  started_at: number | null;
  created_at: string | null;
  error: string | null;
}

/** One active (queued/running/failed) note generation, for the sidebar. */
export interface ActiveNote {
  id: string;
  kind: "note";
  status: NoteJobStatus;
  stage: NoteStage | null;
  title: string | null;
  source_name: string | null;
  provider: string;
  model: string;
  started_at: number | null;
  created_at: string | null;
  error: string | null;
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

/** POST /stream response — a live transcription session id. */
export interface CreateStreamResponse {
  stream_id: string;
  status: string;
}

/** GET /stream/{id} — status + growing transcript + final result. */
export interface StreamStatus {
  stream_id: string;
  status: "recording" | "finalizing" | "done" | "error";
  stage: Stage | null;
  live_text: string;
  result: JobResult | null;
  error: string | null;
  original_name: string | null;
  transcribe_seconds?: number | null;
  started_at?: number | null;
  created_at?: string | null;
}

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
  /** True for a user-created custom template (key "custom:<id>"; ADR-0021). */
  custom?: boolean;
}

/** A user-created custom template record (GET/POST /note-templates; ADR-0021). */
export interface CustomTemplate {
  id: string;
  name: string;
  body: string;
  created_at: string;
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
  /** How long the source transcription took (carried so the note shows it). */
  transcribe_seconds?: number | null;
  /** Structured source turns to persist for the "Kaynak deşifre" panel (ADR-0019). */
  transcript_json?: Turn[];
  /** The originating job/stream id whose source audio to link (ADR-0019). */
  audio_source_id?: string;
  /** Encounter metadata captured up front (ADR-0022). */
  patient_id?: string;
  visit_type?: string;
  chief_complaint?: string;
}

/** A reusable transcript from out/*.json (GET /transcripts). */
export interface TranscriptInfo {
  name: string;
  turns: number;
  language: string;
  num_speakers: number;
  transcribe_seconds: number | null;
}

/** A chosen transcript's flattened text (GET /transcripts/{name}). */
export interface TranscriptText {
  name: string;
  language: string;
  num_speakers: number;
  text: string;
  transcribe_seconds: number | null;
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
  transcribe_seconds: number | null;
  note_seconds: number | null;
  // Edit/finalize lifecycle (ADR-0015).
  status?: NoteLifecycle;
  finalized_at?: string | null;
  edited?: boolean;
  // Patient organization (ADR-0016).
  patient_id?: string | null;
  patient_name?: string | null;
  // Encounter metadata (ADR-0022) — also returned by the list query.
  visit_type?: string | null;
  chief_complaint?: string | null;
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

/** Edit/finalize lifecycle state of a saved note (ADR-0015). */
export type NoteLifecycle = "draft" | "final";

/** One prior saved body of a note (ADR-0020). */
export interface NoteVersion {
  id: string;
  note_id: string;
  seq: number;
  body: string;
  saved_at: string;
}

/** A patient a note can be filed under (ADR-0016). */
export interface Patient {
  id: string;
  name: string;
  mrn: string | null;
  created_at: string;
  note_count?: number;
  /** Most recent note's created_at (patient list; ADR-0024). */
  last_visit_at?: string | null;
}

/** GET /patients/{id} — a patient + its notes + the union problem/med rollup
 *  across those notes (ADR-0024). */
export interface PatientDetail extends Patient {
  notes: SavedNoteSummary[];
  problems_summary: Problem[];
  medications_summary: Medication[];
}

/** GET /notes/{id} response — the note job status + result. */
export interface Note {
  note_id: string;
  status: NoteJobStatus;
  provider: string | null;
  model: string | null;
  template: string | null;
  note: string | null;          // EFFECTIVE body (clinician edit if any, else AI)
  result: NoteResult | null;
  error: string | null;
  transcribe_seconds?: number | null;
  note_seconds?: number | null;
  started_at?: number | null;
  created_at?: string | null;
  title?: string | null;
  source_name?: string | null;
  // Edit/finalize lifecycle (present once the note is persisted; ADR-0015).
  ai_note?: string | null;        // the AI's original output (for revert/compare)
  edited_note?: string | null;    // the clinician overlay (null = untouched)
  edited?: boolean;
  note_status?: NoteLifecycle;    // draft | final
  finalized_at?: string | null;
  patient_id?: string | null;
  patient_name?: string | null;
  // Encounter metadata (ADR-0022).
  visit_type?: string | null;
  chief_complaint?: string | null;
  // Audio-linked source transcript (ADR-0019).
  turns?: Turn[];
  has_audio?: boolean;
  // Extracted structured lists (ADR-0023).
  problems?: Problem[];
  medications?: Medication[];
  extracted?: boolean;
  // Structured STT-review flags, located to turns for audio seek (ADR-0029).
  review_flags?: ReviewFlag[];
}

/** A located STT-review flag: a likely-mistranscribed span the doctor should
 * verify against the audio (ADR-0029). `turn_index`/`start` present when located. */
export interface ReviewFlag {
  quote: string;
  reason?: string;
  category?: string;
  turn_index?: number | null;
  start?: number | null;
  end?: number | null;
  matched?: boolean;
  resolved?: boolean;
}

/** An extracted problem-list entry (ADR-0023). */
export interface Problem {
  name: string;
  status?: string;
  detail?: string;
}

/** An extracted medication-list entry (ADR-0023). */
export interface Medication {
  name: string;
  dose?: string;
  route?: string;
  frequency?: string;
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
