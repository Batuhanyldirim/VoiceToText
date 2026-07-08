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
