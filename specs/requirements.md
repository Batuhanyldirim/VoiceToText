# Requirements — `stt-diarization-prototype`

Acceptance criteria for the tool's **current** behavior, written in
[EARS](https://alistairmavin.com/ears/) (Easy Approach to Requirements Syntax).
Each line is a testable contract. IDs (`REQ-###`) are stable anchors — a feature
task should reference the REQ it satisfies, and behavior changes should update
the matching REQ.

EARS patterns used:
- **Ubiquitous:** `THE SYSTEM SHALL <requirement>`
- **Event-driven:** `WHEN <trigger>, THE SYSTEM SHALL <response>`
- **State-driven:** `WHILE <state>, THE SYSTEM SHALL <response>`
- **Unwanted:** `IF <condition>, THEN THE SYSTEM SHALL <response>`
- **Optional:** `WHERE <feature is enabled>, THE SYSTEM SHALL <response>`

---

## Input

- **REQ-001** (Event) — WHEN the user runs the CLI (`transcribe`) with a path to
  an audio file (`.wav/.mp3/.m4a/.flac/…`), THE SYSTEM SHALL transcribe its speech.
- **REQ-002** (Event) — WHEN the input is a video file (`.mp4/.mov/.mkv/.webm/…`),
  THE SYSTEM SHALL extract and use its audio track without requiring the user to
  convert the file first.
- **REQ-003** (Unwanted) — IF the input path does not exist, THEN THE SYSTEM
  SHALL print an error and exit with a non-zero status without loading any model.

## Core behavior & defaults (the no-flags path)

- **REQ-010** (Event) — WHEN the user runs `transcribe` with an input file and
  no optional flags, THE SYSTEM SHALL auto-detect the language, auto-detect the
  number of speakers, apply audio enhancement, transcribe with the `large-v3`
  model, diarize, and write `<stem>.txt`, `<stem>.srt`, and `<stem>.json` into
  `out/`.
- **REQ-011** (Ubiquitous) — THE SYSTEM SHALL default to `--model large-v3`,
  `--device cpu`, `--compute-type int8`, `--vad-onset 0.35`, enhancement ON, and
  diarization ON.
- **REQ-012** (State) — WHILE no `--language` is given, THE SYSTEM SHALL detect
  the language from the audio and report it.
- **REQ-013** (State) — WHILE neither `--min-speakers` nor `--max-speakers` is
  given, THE SYSTEM SHALL determine the speaker count automatically.

## Platform constraint

- **REQ-020** (Ubiquitous) — THE SYSTEM SHALL run all inference on CPU and SHALL
  NOT require a CUDA or MPS device. *(→ ADR-0001)*

## Audio enhancement (uneven mic distance)

- **REQ-030** (Optional) — WHERE enhancement is enabled (the default), THE SYSTEM
  SHALL level the audio (high-pass + speechnorm + dynaudnorm + loudnorm) before
  transcription so a quiet/far speaker is not dropped next to a loud/close one.
  *(→ ADR-0004)*
- **REQ-031** (Event) — WHEN the user passes `--no-enhance`, THE SYSTEM SHALL
  transcribe the original audio unmodified.
- **REQ-032** (Unwanted) — IF `ffmpeg` is not available when enhancement is
  requested, THEN THE SYSTEM SHALL warn and continue with the original audio
  rather than failing.

## Transcription & progress

- **REQ-040** (Ubiquitous) — THE SYSTEM SHALL display a live progress indicator
  during transcription.
- **REQ-041** (Unwanted) — IF `tqdm` is not installed, THEN THE SYSTEM SHALL
  still transcribe, degrading to plain text output without a progress bar.
- **REQ-042** (Ubiquitous) — THE SYSTEM SHALL support `--help` without importing
  the heavy ML dependencies (imports are lazy).

## Alignment

- **REQ-050** (Event) — WHEN a forced-alignment model exists for the detected
  language, THE SYSTEM SHALL produce word-level timestamps.
- **REQ-051** (State) — WHILE no alignment model is available for the detected
  language, THE SYSTEM SHALL continue and assign speakers at the segment level
  instead of the word level (no hard failure).

## Diarization

- **REQ-060** (Event) — WHEN diarization is enabled (the default), THE SYSTEM
  SHALL label each spoken segment with a speaker and render turns as
  `Speaker 1`, `Speaker 2`, … in stable first-appearance order.
- **REQ-061** (Unwanted) — IF the gated pyannote meta-model
  (`speaker-diarization-3.1`) is unavailable or its terms are unaccepted, THEN
  THE SYSTEM SHALL fall back to a component pipeline (`segmentation-3.0` +
  `wespeaker`) and continue diarization. *(→ ADR-0005)*
- **REQ-062** (Unwanted) — IF diarization is requested and `HF_TOKEN` is not set,
  THEN THE SYSTEM SHALL exit non-zero and instruct the user to `source env.sh`
  or pass `--no-diarize`.
- **REQ-063** (Event) — WHEN the user passes `--no-diarize`, THE SYSTEM SHALL
  produce a transcript with no speaker labels and SHALL NOT require `HF_TOKEN`.
- **REQ-064** (Optional) — WHERE `--min-speakers` and/or `--max-speakers` are
  given, THE SYSTEM SHALL constrain the diarization speaker count accordingly.

## Output

- **REQ-070** (Ubiquitous) — THE SYSTEM SHALL write three files per run into the
  output directory, named after the input stem: `<stem>.txt` (human transcript),
  `<stem>.srt` (subtitles), `<stem>.json` (full structured result).
- **REQ-071** (Ubiquitous) — THE SYSTEM SHALL print the transcript to the
  terminal and write `<stem>.txt` in the same pass, so the file content matches
  the terminal output exactly and is flushed line-by-line.
- **REQ-072** (Ubiquitous) — THE SYSTEM SHALL prefix the `.txt` with a header
  reporting the source filename, detected language, and speaker count.
- **REQ-073** (Optional) — WHERE `--out-dir` is given, THE SYSTEM SHALL write
  outputs there instead of `out/`.

## Cleanliness / footprint

- **REQ-080** (Ubiquitous) — THE SYSTEM SHALL store all downloaded models and
  caches inside the project directory and SHALL NOT write them to `~/.cache`,
  `~/Library`, or other locations outside the project. *(→ ADR-0003)*

## Web app (API + frontend)

The web surface reuses the same pipeline (`stt_core`) as the CLI; "the system"
below means the API backend (`apps/api`) and its web client (`apps/web`).
*(→ ADR-0006, ADR-0007, ADR-0008)*

- **REQ-090** (Event) — WHEN the user uploads an audio or video file via the web
  app (`POST /jobs`, multipart), THE SYSTEM SHALL accept supported audio
  (`.wav/.mp3/.m4a/.flac/.ogg/.aac`) and video (`.mp4/.mov/.mkv/.webm/.avi`)
  types and create a job. *(→ REQ-001, REQ-002)*
- **REQ-091** (Unwanted) — IF the uploaded file has an unsupported type or is
  empty or exceeds the size cap, THEN THE SYSTEM SHALL reject the request with a
  4xx error and SHALL NOT start a job.
- **REQ-092** (Event) — WHEN a job is created, THE SYSTEM SHALL run the
  transcription in the background (a single in-process worker) and return a
  `job_id` immediately without blocking the request. *(→ ADR-0008)*
- **REQ-093** (State) — WHILE a job is running, THE SYSTEM SHALL stream progress
  events (stage, and percent during transcription) to the client over SSE
  (`GET /jobs/{id}/events`), AND SHALL expose the same status via a poll endpoint
  (`GET /jobs/{id}`) as a fallback. *(→ ADR-0008)*
- **REQ-094** (Event) — WHEN a job completes, THE SYSTEM SHALL make available a
  result containing the detected language, the speaker count, and speaker-labeled
  turns (`Speaker 1/2/…` with text and timestamps). *(→ REQ-060)*
- **REQ-095** (Event) — WHEN a job has completed, THE SYSTEM SHALL let the client
  download the transcript in `txt`, `srt`, and `json`
  (`GET /jobs/{id}/download/{fmt}`), named after the original upload.
  *(→ REQ-070)*
- **REQ-096** (Ubiquitous) — THE SYSTEM SHALL read `HF_TOKEN` only from the server
  environment and SHALL NOT accept it from the browser, log it, or return it in
  any response. IF diarization is requested and `HF_TOKEN` is unset on the server,
  THEN THE SYSTEM SHALL reject the job with a 4xx error explaining how to fix it.
  *(→ REQ-062, ADR-0008)*
- **REQ-097** (Ubiquitous) — THE SYSTEM SHALL bind the API to `127.0.0.1` (not a
  public interface) so audio and results never leave the machine, and SHALL keep
  per-job scratch files inside the project (`apps/api/jobs/`). *(→ ADR-0003, ADR-0008)*

## Clinical note generation

An optional step *after* transcription: turn a transcript into a structured
**Turkish** clinical note via a **pluggable AI provider** — a local LLM (Ollama)
by default, a cloud model (Claude) as an explicit opt-in. The note-generation
logic lives in `note_core` (parallels `stt_core`) and is driven by the same
API/web surface. A transcript can come from a fresh upload or be **reused** from
an existing CLI transcript in `out/`; completed notes are **persisted** to a
project-local SQLite DB and browsable as history. The provider is **selectable**
from the UI when more than one is enabled, extra providers plug in via an
optional git-ignored module, and both transcription and note runs are **timed**,
**listed as in-progress sessions**, **refresh-safe**, and **retryable**.
*(→ ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0003, ADR-0008)*

- **REQ-100** (Event) — WHEN the user requests a note for a completed transcript
  with a chosen template (`soap`, `hp`, or a pasted `free` sample format), THE
  SYSTEM SHALL generate a structured clinical note via the configured provider.
  *(→ ADR-0009)*
- **REQ-101** (Ubiquitous) — THE SYSTEM SHALL default to the local Ollama
  provider and SHALL NOT send the transcript off-device unless the operator
  explicitly selects a cloud provider via server env (`STT_NOTE_PROVIDER=claude`).
  *(→ ADR-0009, ADR-0003)*
- **REQ-102** (Unwanted) — IF a cloud provider is requested but its env flag is
  not set to that provider or its token is unset, THEN THE SYSTEM SHALL refuse
  with a user-safe explanation and SHALL NOT send any transcript data off-device.
  *(→ ADR-0009)*
- **REQ-103** (State) — WHILE a note is generating, THE SYSTEM SHALL stream it to
  the client over SSE as token deltas (`GET /notes/{id}/events`), AND SHALL expose
  the same status/result via a poll endpoint (`GET /notes/{id}`) as a fallback.
  *(→ ADR-0008)*
- **REQ-104** (Ubiquitous) — THE SYSTEM SHALL present the note as a review draft
  (not a finalized record) and SHALL preserve the prompt's "Clinician Review
  Needed" section. *(→ ADR-0009)*
- **REQ-105** (Ubiquitous) — THE SYSTEM SHALL keep Ollama model downloads inside
  the project (`OLLAMA_MODELS`), preserving one-command cleanup. *(→ ADR-0003)*
- **REQ-106** (Ubiquitous) — THE SYSTEM SHALL generate the clinical note in
  **Turkish** — a Turkish system prompt, Turkish templates (`soap` = "SOAP notu",
  `hp` = "Öykü ve Muayene (Ö&M)"), and Turkish section headings A–E
  (A) "Yapılandırılmış Klinik Not", B) "Hasta Bilgi Özeti", C) "Soyağacı / Aile
  Öyküsü Özeti", D) "İstemler / Plan / Takip", E) "Klinik İnceleme Gerekli") — and
  the web UI SHALL be Turkish throughout. Section **E** ("Klinik İnceleme Gerekli")
  is the review section the UI highlights (the Turkish counterpart of REQ-104's
  "Clinician Review Needed"). *(→ ADR-0009)*
- **REQ-107** (Event) — WHEN the user browses existing CLI transcripts, THE SYSTEM
  SHALL list the JSON transcripts under `out/` (`GET /transcripts`) and return a
  chosen transcript's text (`GET /transcripts/{name}`) so a note can be generated
  from an already-transcribed file (e.g. `HistoryTaking_YA`) **instead of**
  re-uploading — a dev-cycle speedup. *(→ ADR-0009)*
- **REQ-108** (Event) — WHEN a note finishes generating, THE SYSTEM SHALL persist
  the completed note (id, timestamp, title, source name, provider, model,
  template, transcript, and note body) to a project-local SQLite database so it
  survives a server restart. *(→ ADR-0010, ADR-0003)*
- **REQ-109** (Event) — WHEN the user opens the history screen, THE SYSTEM SHALL
  list saved notes newest-first as summaries without bodies (`GET /notes`), open a
  saved note in full (`GET /notes/{id}`, which also serves persisted notes, not
  only live jobs), and delete one (`DELETE /notes/{id}`). *(→ ADR-0010)*
- **REQ-110** (Ubiquitous) — THE SYSTEM SHALL keep the notes database
  project-local and **git-ignored** (`apps/api/notes.db`, overridable via
  `STT_DB_PATH`); it contains PHI and SHALL NOT be committed, and its location
  inside the project preserves the one-command `rm -rf` cleanup.
  *(→ ADR-0010, ADR-0003)*

### Selectable provider + generic plugin seam

- **REQ-111** (Optional) — WHERE more than one note provider is enabled, THE
  SYSTEM SHALL let the user pick the **provider** and its **model** from the web
  UI (a "Sağlayıcı" + "Model" selector), SHALL hide that selector when only one
  provider is enabled, and SHALL drive the off-device PHI warning from the chosen
  provider's `off_device` flag. THE SYSTEM SHALL expose the enabled providers
  (`GET /notes/providers` → `{providers:[{key, label, models, default_model,
  off_device}], default_provider}`) and, on `POST /notes`, SHALL validate the
  requested provider against that enabled set and fill an unspecified model from
  the descriptor's `default_model`. *(→ ADR-0011, ADR-0009)*
- **REQ-112** (Ubiquitous) — THE SYSTEM SHALL gate the set of offered providers
  by the operator allowlist `STT_NOTE_PROVIDERS` (a comma list, **default
  `ollama`**), so the committed/default configuration exposes only the local
  provider and any off-device or plugin provider must be turned on deliberately
  (typically via the git-ignored `env.local.sh`). *(→ ADR-0011, ADR-0009,
  ADR-0003)*
- **REQ-113** (Optional) — WHERE an optional, **git-ignored** local provider
  module (`note_core._local_providers`) is present, THE SYSTEM SHALL merge its
  providers into `get_provider()` / `list_providers()`, SHALL filter each by the
  allowlist and by its own `available()` predicate (so a provider that cannot run
  on this machine never appears), and SHALL consult it last. IF the module is
  absent or broken, THEN THE SYSTEM SHALL fall back to the built-in providers
  without error. THE SYSTEM SHALL keep such machine-specific integrations (e.g. an
  Opus-via-`claude`-CLI provider) **out of version control**. *(→ ADR-0011,
  ADR-0003)*

### Note output shape & concision

- **REQ-114** (Ubiquitous) — THE SYSTEM SHALL make the user's **chosen template
  the whole note** (its own headings/order), append exactly **one** "Klinik
  İnceleme Gerekli" section at the end, and SHALL NOT emit the earlier mandatory
  A–E scaffold that duplicated content across sections. THE SYSTEM SHALL start
  directly with the note — no title banner, cover, blockquote warning, or preamble
  ("İşte not:") — SHALL NOT repeat the same fact in multiple places, and SHALL add
  a pedigree ("Soyağacı") block **only** when the family history is rich (multiple
  relatives). This applies to **every** provider. *(refines REQ-104, REQ-106;
  → ADR-0009)*

### Timing metrics

- **REQ-115** (Ubiquitous) — THE SYSTEM SHALL measure the wall-clock duration of
  transcription (`TranscribeResult.transcribe_seconds`, persisted into
  `out/<stem>.json`) and of note generation (`note_seconds`), SHALL persist both
  onto a saved note (SQLite `transcribe_seconds` + `note_seconds` columns, added
  by an `ALTER TABLE` migration on pre-existing DBs), and SHALL surface them on the
  relevant API responses (`GET /jobs/{id}`, `GET /notes/{id}`, `GET /transcripts`,
  the `GET /notes` list) with `POST /notes` accepting a carried
  `transcribe_seconds`. THE web UI SHALL show "Deşifre: Xs" / "Not: Ys" chips and a
  model chip. *(→ ADR-0009, ADR-0010)*
- **REQ-116** (State) — WHILE a transcription or note is running, THE SYSTEM SHALL
  show a **live elapsed timer** anchored to the process's real start time
  (`started_at`, epoch seconds set on the server at run start and returned by the
  status endpoints) so a page refresh mid-run shows the true elapsed time instead
  of resetting to zero. *(→ ADR-0012, ADR-0008)*

### In-progress sessions, persistence & retry

- **REQ-117** (Event) — WHEN transcriptions or notes are queued, running, or
  failed, THE SYSTEM SHALL list them as active sessions for the sidebar
  (`GET /jobs` for transcriptions, `GET /notes/active` for notes; newest first,
  `done` excluded), and the web "Oturumlar" sidebar SHALL show active items on top
  (spinner + Turkish stage label, or a ⚠ + "Tekrar dene" affordance on failure),
  then a divider, then the saved notes, polling the active lists every ~3s.
  *(→ ADR-0012, ADR-0010)*
- **REQ-118** (Event) — WHEN the page is refreshed mid-run, THE SYSTEM SHALL
  restore the current screen from a client-side pointer (`localStorage`, via
  `utils/session.ts`) and re-attach to the backend by id (re-open the SSE stream or
  re-fetch the result), so an in-progress job survives the refresh and is
  returnable from the sidebar. This persistence is scoped to the **life of the
  server process** — the in-memory job registries are not durable, so a server
  restart (e.g. `make api`) drops in-flight jobs. *(→ ADR-0012, ADR-0008)*
- **REQ-119** (Event) — WHEN the user retries a **failed transcription**
  (`POST /jobs/{id}/retry`), THE SYSTEM SHALL re-run it using the **same uploaded
  file still on disk** (no re-upload); IF that file is gone, THEN THE SYSTEM SHALL
  return 404. WHEN the user retries a **failed note** (`POST /notes/{id}/retry`),
  THE SYSTEM SHALL re-run it with the same transcript + options (no data re-entry).
  *(→ ADR-0012, ADR-0008)*

## Voice recording (record → transcribe)

A third way to start a transcription, alongside file upload and transcript reuse:
record from the browser microphone and feed the recording straight into the
**existing** upload path. A `MediaRecorder` clip becomes a `File` and flows
through `POST /jobs` unchanged — no second pipeline — so the sessions sidebar,
live timer, refresh-persistence, and retry all apply as-is. *(→ ADR-0013,
ADR-0008, ADR-0012, ADR-0003)*

- **REQ-120** (Event) — WHEN the user records audio in the browser and stops,
  THE SYSTEM SHALL create a transcription job from that recording via the **same
  path as a file upload** (a `File` → `POST /jobs`), so the resulting job is
  indistinguishable downstream from an uploaded one (same progress, sidebar
  session, live timer, refresh-persistence, and retry). *(→ ADR-0013, ADR-0008,
  ADR-0012)*
- **REQ-121** (Ubiquitous) — THE SYSTEM SHALL keep the recording **on-device**
  except for the upload to the local `127.0.0.1` API — the same privacy posture
  as a file upload, with no third-party/off-device transfer. *(→ ADR-0003,
  REQ-097)*
- **REQ-122** (Unwanted) — IF microphone permission is denied or no input device
  exists (or the browser lacks `MediaRecorder`/`getUserMedia`), THEN THE SYSTEM
  SHALL show a clear **Turkish** message and SHALL NOT start a recording or a job.
  *(→ ADR-0013)*
- **REQ-123** (State) — WHILE recording, THE SYSTEM SHALL show a **live elapsed
  timer** (reusing `hooks/useElapsed.ts`) and a recording indicator, and SHALL let
  the user **stop** and then **preview / re-record** the captured clip before
  submitting it for transcription. *(→ ADR-0013, REQ-116)*
- **REQ-124** (Unwanted) — THE SYSTEM SHALL choose a `MediaRecorder`
  container/codec it can name with a **server-accepted extension** (probing with
  `MediaRecorder.isTypeSupported`, preferring `audio/webm`/Opus, falling back to
  the browser default mapped to an allowed suffix), so the recording round-trips
  through `POST /jobs`; IF no nameable/supported container is available, THEN THE
  SYSTEM SHALL surface the error rather than starting an un-decodable job.
  *(→ ADR-0013, REQ-090, REQ-091)*

## Live (streaming) transcription during recording

An opt-in mode of the voice recorder that **transcribes while you record** so the
post-stop wait shrinks to roughly the finalize (diarize) pass. The browser
streams raw PCM to the local API, which transcribes silence-aligned chunks
incrementally and, on finish, runs a single global diarization pass and returns a
transcript **whose accuracy matches the one-shot pipeline** (a spike measured
99.4% word-parity vs one-shot; naive fixed-cut chunking measured 59.4%, which is
why silence-aligned cutting is mandatory). This is a **separate ingest path** from
`POST /jobs` — not the file-upload reuse — so it has its own endpoints and its own
ADR. *(→ ADR-0014, ADR-0008, ADR-0012, ADR-0003)*

- **REQ-125** (Event) — WHEN the user records with **live transcription** enabled
  and stops, THE SYSTEM SHALL have transcribed the audio **incrementally during
  recording** (chunk-level ASR as audio arrives) and SHALL, on finish, produce a
  full speaker-labeled transcript **equivalent in accuracy to the one-shot
  pipeline** for the same audio. *(→ ADR-0014)*
- **REQ-126** (Ubiquitous) — THE SYSTEM SHALL cut streaming ASR chunks **only on
  detected silence** (never mid-word), keep each chunk **under the model's ~30 s
  window**, and **offset each chunk's timestamps by its absolute start**, so word
  accuracy at chunk boundaries is preserved. IF a single utterance exceeds the
  chunk target with no pause, THEN THE SYSTEM SHALL cut at the quietest point in a
  bounded search window. *(→ ADR-0014)*
- **REQ-127** (Ubiquitous) — THE SYSTEM SHALL run **diarization as a single global
  pass over the full accumulated audio at finish** (never per-chunk), then align,
  fuse, and build turns — so speaker labels and their stable `Speaker N` ordering
  match the batch pipeline. *(→ ADR-0014, REQ-060)*
- **REQ-128** (Ubiquitous) — THE SYSTEM SHALL keep streamed audio **on-device**:
  raw PCM is sent only to the local `127.0.0.1` API and SHALL NOT use any
  browser/cloud speech service (e.g. the Web Speech API). All ASR runs in the
  local pipeline. *(→ ADR-0014, ADR-0003, REQ-097, REQ-128 mirrors REQ-121)*
- **REQ-129** (State) — WHILE streaming, THE SYSTEM SHALL show the **live-growing
  transcript** (SSE, a few seconds behind speech is acceptable) and a live elapsed
  timer, and on finish SHALL transition to the normal transcript viewer so
  download and note generation are reused unchanged. *(→ ADR-0014, REQ-116)*
- **REQ-130** (Unwanted) — IF the browser lacks `AudioWorklet`/`getUserMedia`, or
  microphone permission is denied, THEN THE SYSTEM SHALL show a clear **Turkish**
  message and SHALL NOT start a streaming session (the non-streaming recorder and
  file upload remain available as fallbacks). *(→ ADR-0014, REQ-122)*
- **REQ-131** (Ubiquitous) — THE SYSTEM SHALL treat live transcription as
  forgoing the **whole-file enhancement** pass (a documented tradeoff for
  incremental speed; the batch upload/record paths keep enhancement), while still
  diarizing at finish. *(→ ADR-0014, ADR-0004)*

## Editable & finalizable notes (Tier 1)

A generated note is an AI **draft**; the doctor must be able to correct it and
mark it a **final** record. The AI's original output is preserved as an audit
trail — edits are an overlay, so the doctor can always see (and revert to) what
the model produced. A finalized note is locked until explicitly reopened. This is
the first of the "patient/encounter" product tier. *(→ ADR-0015, ADR-0010)*

- **REQ-132** (Event) — WHEN the user edits a saved note's body and saves, THE
  SYSTEM SHALL persist the edited text as an **overlay** (`edited_note`) WITHOUT
  overwriting the AI's original (`note`), and SHALL thereafter serve the edited
  text as the note's **effective body** while keeping the original recoverable.
  *(→ ADR-0015, ADR-0010)*
- **REQ-133** (State) — WHILE a note's `status` is `draft`, THE SYSTEM SHALL allow
  editing and re-generation; WHEN the user **finalizes** it (`POST /notes/{id}/finalize`),
  THE SYSTEM SHALL set `status = final`, stamp `finalized_at`, and thereafter
  **reject edits** to it with a 4xx until it is reopened. *(→ ADR-0015)*
- **REQ-134** (Event) — WHEN the user **reopens** a finalized note
  (`POST /notes/{id}/reopen`), THE SYSTEM SHALL return it to `draft` (clearing
  `finalized_at`) so it can be edited again. *(→ ADR-0015)*
- **REQ-135** (Event) — WHEN the user **reverts** a note to the AI draft, THE
  SYSTEM SHALL clear the `edited_note` overlay so the effective body is the
  original AI `note` again (no data loss — the original was never overwritten).
  *(→ ADR-0015)*
- **REQ-136** (Ubiquitous) — THE SYSTEM SHALL surface each saved note's `status`
  (`draft`/`final`), `finalized_at`, and whether it has been edited on the note
  APIs (`GET /notes`, `GET /notes/{id}`), and the web UI SHALL show a
  **Taslak/Tamamlandı** state, an **edit** affordance with save/cancel, a
  **Tamamla/İmzala** ↔ **Yeniden aç** control, and a **revert-to-AI-draft** action.
  The DB migration SHALL add these columns to a pre-existing notes table without
  data loss. *(→ ADR-0015, ADR-0010)*

## Patient organization (Tier 1)

Notes become findable by **patient**: a lightweight patient entity, notes attached
to a patient, and browse-by-patient. This is the structural centerpiece of the
patient/encounter reframing — introduced incrementally so the existing flat note
list keeps working while patient grouping layers on top. *(→ ADR-0016, ADR-0010)*

- **REQ-137** (Event) — WHEN the user creates or selects a **patient** (a
  `{id, name, mrn?, created_at}` record) and assigns it to a note, THE SYSTEM
  SHALL persist the note's `patient_id`, and SHALL let the same patient be reused
  across many notes. Creating a patient by an already-used name SHALL reuse the
  existing patient rather than duplicate it. *(→ ADR-0016, ADR-0010)*
- **REQ-138** (Ubiquitous) — THE SYSTEM SHALL expose patients
  (`GET /patients` with each patient's note count, `POST /patients`,
  `GET /patients/{id}` with that patient's notes newest-first) and SHALL let a
  note's patient be set/cleared (`PUT /notes/{id}/patient`), carrying
  `patient_id` + `patient_name` on the note APIs (`GET /notes`,
  `GET /notes/{id}`). *(→ ADR-0016)*
- **REQ-139** (State) — WHILE a note is `final`, THE SYSTEM SHALL still allow
  changing its **patient assignment** (filing is metadata, not note content — a
  finalized note can still be (re)filed under the correct patient). *(→ ADR-0016,
  REQ-133)*
- **REQ-140** (Ubiquitous) — THE web UI SHALL let the user pick or create a
  patient for a note (a **"Hasta"** selector), show the assigned patient on the
  note and its sidebar row, and **filter the note list by patient**. The DB
  migration SHALL add the patients table + the note `patient_id` column to a
  pre-existing DB without data loss (existing notes remain unassigned). *(→
  ADR-0016, ADR-0010)*

## Search & filter (Tier 1)

- **REQ-141** (Event) — WHEN the user provides a search query, THE SYSTEM SHALL
  filter the saved-note list to notes whose **title, patient name, or note body**
  contains the query (case-insensitive substring), accept it on `GET /notes?q=…`,
  and combine it with the existing `patient_id` filter (both applied together).
  The web sidebar SHALL provide a **search box** ("Notlarda ara…") that narrows
  the list as the user types. *(→ ADR-0018, ADR-0016)*

## Audio-linked source transcript

A generated note can carry its **source transcript** (the speaker-labeled turns
with timestamps) and, when available, the **source audio recording** — so a
clinician who sees an ambiguous or likely-mis-transcribed passage can click that
turn and **hear the original audio** at that moment. This makes the note
verifiable against the recording without leaving the note page. PHI stays local.
*(→ ADR-0019, ADR-0010, ADR-0003)*

- **REQ-143** (Event) — WHEN a note is generated from a transcription result that
  has structured turns, THE SYSTEM SHALL persist those **turns (speaker, text,
  start, end)** alongside the note (`transcript_json`) and surface them on
  `GET /notes/{id}`, so the source transcript can be shown on the note page.
  *(→ ADR-0019, ADR-0010)*
- **REQ-144** (Event) — WHEN a note is generated from a fresh upload/recording or
  a live stream whose **source audio is still on disk**, THE SYSTEM SHALL copy
  that audio into a durable, note-keyed, **git-ignored** project-local store
  (`note_audio/<note_id>.<ext>`) at note-persist time and serve it at
  `GET /notes/{id}/audio`, so it survives the job scratch being cleaned. *(→
  ADR-0019, ADR-0003)*
- **REQ-145** (State) — WHILE viewing a saved note that has a source transcript,
  THE web UI SHALL show a **"Kaynak deşifre"** panel listing the turns; IF the
  note also has source audio, THEN each turn SHALL be **clickable to seek/play**
  that moment in an embedded player; IF there is no audio (e.g. a reused
  transcript or an older note), THEN the panel SHALL still show the transcript and
  simply omit the player. *(→ ADR-0019)*
- **REQ-146** (Event) — WHEN a note is deleted, THE SYSTEM SHALL also remove its
  stored source audio, keeping the one-command `rm -rf` cleanup and never
  committing audio (PHI). *(→ ADR-0019, ADR-0003, ADR-0010)*

## Custom note templates (Tier 2)

Beyond the built-in SOAP / Ö&M formats, the user can save their own reusable note
templates (a named sample format) instead of re-pasting a "free" format each time.
*(→ ADR-0021, ADR-0009, ADR-0010)*

- **REQ-150** (Event) — WHEN the user creates, edits, or deletes a **custom
  template** (a `{id, name, body, created_at}` record), THE SYSTEM SHALL persist
  it in the project-local, git-ignored store and expose CRUD
  (`GET/POST /note-templates`, `PUT/DELETE /note-templates/{id}`). *(→ ADR-0021,
  ADR-0010)*
- **REQ-151** (Event) — WHEN the UI lists note templates (`GET /notes/templates`),
  THE SYSTEM SHALL return the **built-in** templates, the **custom** templates
  (each marked as custom), and the **"free"** paste option — so custom templates
  appear in the same picker. *(→ ADR-0021, ADR-0009)*
- **REQ-152** (Event) — WHEN a note is generated with a **custom** template, THE
  SYSTEM SHALL resolve it to its stored body and drive generation from that format
  (equivalent to a saved "free" sample), producing a note in that layout without
  requiring any change to `note_core`. *(→ ADR-0021, ADR-0009)*

## Autosave & version history (Tier 2)

Editing a note should never lose work, and prior versions should be recoverable.
*(→ ADR-0020, ADR-0015, ADR-0010)*

- **REQ-147** (State) — WHILE the user is editing a draft note, THE SYSTEM SHALL
  **autosave** the edited body a short time after they stop typing (debounced),
  persisting it as the edit overlay (`PATCH /notes/{id}`) and showing a subtle
  saved/saving indicator — so navigating away or a refresh never loses the edit.
  Autosave SHALL NOT apply to a finalized note (it is locked; REQ-133). *(→
  ADR-0020, ADR-0015)*
- **REQ-148** (Event) — WHEN an edited note body is saved and it **differs** from
  the currently-stored body, THE SYSTEM SHALL snapshot the prior body as a
  **version** (id, note_id, sequence, body, saved_at) into a project-local,
  git-ignored store, so earlier revisions are recoverable. Finalizing also
  snapshots the finalized body. *(→ ADR-0020, ADR-0010)*
- **REQ-149** (Event) — WHEN the user opens a note's **version history**
  (`GET /notes/{id}/versions`), THE SYSTEM SHALL list its versions newest-first
  (metadata + body) and let the user **restore** one (`POST /notes/{id}/restore`
  with a version id), which sets it as the current edited body (itself snapshotting
  the pre-restore body). The web UI SHALL show a **"Sürüm geçmişi"** affordance to
  view and restore versions. *(→ ADR-0020)*

## Export (Tier 1)

- **REQ-142** (Event) — WHEN the user exports a note, THE SYSTEM SHALL offer
  (a) **"PDF olarak indir"** — a clean, print-formatted PDF via the browser's
  print dialog (a print stylesheet, no server round-trip, no extra dependency),
  including the note title, patient (if assigned), status, and the formatted note
  body; and (b) **"EHR için kopyala"** — copy the note as clean **plain text**
  (markdown markers stripped, headings/bullets normalized) to the clipboard for
  pasting into a hospital record system. The existing `.md` download and "Kopyala"
  (raw markdown) remain. *(→ REQ-136)*

---

## Verification gate

The behavioral acceptance test (no unit suite — see
[`design.md`](design.md#testing-strategy)):

```bash
source env.sh
bash make_sample.sh
transcribe samples/conversation.wav        # the stt-cli console script (was: python transcribe.py)
```

**PASS** iff `out/conversation.txt` exists, has the header (REQ-072), and lists
**≥ 2 distinct `Speaker N`** turns with plausible text (REQ-060). This exercises
REQ-001/010/011/040/060/070/071 end-to-end. The web path (REQ-090–097) passes the
same gate by uploading the sample and confirming `result.num_speakers ≥ 2`.

**Note generation (REQ-100–106)** passes when, with `ollama serve` running
(models under `OLLAMA_MODELS`), generating a note from that transcript on the
default local provider produces all five **Turkish** sections (A–E) including a
populated "Klinik İnceleme Gerekli" (REQ-104/REQ-106), an ambiguous term is
flagged rather than silently "corrected", and the cloud path stays refused unless
`STT_NOTE_PROVIDER=claude` is set with a token (REQ-101/REQ-102).

**History round-trip (REQ-107–110)** passes when a transcript reused from `out/`
(`GET /transcripts` → `GET /transcripts/{name}`) generates a note that then
appears in `GET /notes`, can be re-opened in full via `GET /notes/{id}` after a
server restart (proving persistence to `apps/api/notes.db`), and can be removed
via `DELETE /notes/{id}` — with the DB file staying git-ignored.
