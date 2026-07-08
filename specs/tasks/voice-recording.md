# Task: In-app voice recording (record → transcribe)

**Status:** APPROVED, not yet started. Cross-chat handoff — read `AGENTS.md`
first, then this. The previous chat ran out of context right after approving
this feature; everything else in the repo is up to date in the specs.

## Goal

Let the user **record audio in the browser** (their microphone, live) and feed
that recording straight into the existing transcription pipeline — as an
alternative to uploading a file or reusing an existing transcript. No new
pipeline: a recording becomes a `File` and flows through the **exact same path**
as an upload.

Product framing: the upload screen currently offers "drag & drop a file" and
"use an existing transcript". Add a third path: **"Ses kaydet"** (record voice).
Everything stays local (recording never leaves the machine except to the local
API, same as uploads; ADR-0003/REQ-097).

## Why this is small (reuse, don't rebuild)

The transcription path is entirely file-based and already accepts any `File`:
- Web: `UploadScreen.onSubmit(file: File, options: JobOptions)` →
  `App.handleSubmit` → `createJob(file, options)` (multipart `FormData` with a
  `file` field) → `POST /jobs`. See `apps/web/src/config/api.ts:createJob` and
  `apps/web/src/components/UploadScreen.tsx`.
- A browser recording from `MediaRecorder` is a `Blob`; wrap it in a `File`
  (`new File([blob], "kayit-<ts>.webm", { type: blob.type })`) and call the
  **same** `onSubmit`. The sessions-sidebar, progress screen, live timer,
  refresh-persistence, and retry all work unchanged (they're job-id based).

So the real work is: (1) a recording UI + `MediaRecorder` capture, (2) make the
backend accept the recording's container/codec.

## Build plan

### 1. Frontend — recording UI + capture
- New component (e.g. `apps/web/src/components/VoiceRecorder.tsx`) or a mode
  inside `UploadScreen.tsx`. A record button → `navigator.mediaDevices.getUserMedia({ audio: true })`
  → `MediaRecorder`. Show: a live **elapsed timer** (reuse `hooks/useElapsed.ts`!),
  a level/pulse indicator, and Stop. On stop, assemble the chunks into a `Blob`,
  wrap as a `File`, and hand to the existing `onSubmit(file, options)` — dropping
  the user straight into the normal progress flow.
- All UI text **Turkish** (the whole app is Turkish): "Ses kaydet", "Kaydı
  durdur", "Kaydediliyor…", plus a mic-permission-denied message. Match the MUI
  v9 style used across the app (Card/Stack/Button startIcon/Alert).
- Let the user re-record before submitting, and allow a quick playback of the
  captured clip (Blob URL in an `<audio>`), mirroring `TranscriptViewer`'s player.
- Wire the entry point into `UploadScreen` (a third action alongside upload /
  "Mevcut deşifreyi kullan") and/or the sidebar "Yeni not"-style affordance.

### 2. Backend — accept the recorded container
- `MediaRecorder` on Chrome produces **`audio/webm`** (Opus); Safari produces
  **`audio/mp4`**; some builds `audio/ogg`. `.webm`/`.ogg` are already in
  `apps/api/src/stt_api/main.py:ALLOWED_SUFFIXES`; **confirm** and add any missing
  ones (`.weba`?) — the file is named from the Blob, so pick a filename whose
  suffix is allowed. ffmpeg (already a dependency, used by `enhance_audio`) decodes
  all of these, so the pipeline itself needs no change.
- Verify: a `.webm`/Opus recording round-trips through `POST /jobs` →
  transcription (the enhance step + whisperx `load_audio` go through ffmpeg).

### 3. Consider a MIME→extension guard
- The web should choose a `MediaRecorder` mimeType it can name correctly
  (`MediaRecorder.isTypeSupported`), and pick a matching filename extension so the
  server's suffix check passes. Prefer `audio/webm` where supported; fall back to
  the browser default and map its `blob.type` to an allowed extension.

## Requirements to add (EARS) — reserve REQ-111+ AFTER the spec backfill

> NOTE: a spec backfill (provider selection, timing, sessions sidebar) is landing
> just before this and will consume REQ-111+. **Check the current highest REQ in
> `specs/requirements.md` and continue from there** — do not hard-code a number.

Draft under a new "## Voice recording" section, e.g.:
- (Event) WHEN the user records audio in the browser and stops, THE SYSTEM SHALL
  create a transcription job from that recording via the same path as an upload.
- (Ubiquitous) THE SYSTEM SHALL keep the recording on-device except for the
  upload to the local API (same privacy posture as file upload). *(→ ADR-0003)*
- (Unwanted) IF microphone permission is denied or no input device exists, THEN
  THE SYSTEM SHALL show a clear message and not start a job.
- (State) WHILE recording, THE SYSTEM SHALL show a live elapsed timer and allow
  the user to stop (and optionally re-record / preview before submitting).
- (Unwanted) IF the recorded container/codec is one the server rejects, THEN THE
  SYSTEM SHALL surface the error (or, better, the client SHALL pick a supported
  container up front).

## Design / ADR
- Likely **no new ADR** (it reuses the file-upload path). If the recording
  approach warrants a decision (e.g. chosen container/codec, or client-side
  encoding), add the next ADR in sequence and note it in `specs/design.md`.
- Add a short data-flow note to `specs/design.md`: mic → MediaRecorder → Blob →
  File → existing `POST /jobs` flow.

## Verify (this feature)
```bash
source env.sh
make api          # sources env.sh, no --reload
make web          # Vite dev server
```
PASS =
1. On the upload screen, "Ses kaydet" records from the mic with a live timer;
   Stop → the app transitions into the normal progress flow and produces a
   transcript with speaker labels (the standard ≥2-speaker gate if 2 speakers).
2. The recording appears as an active session in the left sidebar immediately,
   is returnable, and survives a page refresh (reuses the sessions layer).
3. Mic-denied shows a Turkish error and starts no job.
4. `npm run build` + `npm run lint` green (only the 2 pre-existing
   TranscriptViewer exhaustive-deps warnings).

## Constraints to respect (don't violate)
- [ ] Reuse the existing upload→`POST /jobs` path; do NOT add a second pipeline.
- [ ] All new user-facing text in Turkish; match the MUI v9 style.
- [ ] Recording stays local (only to the 127.0.0.1 API); no third-party upload.
- [ ] Reuse `hooks/useElapsed.ts` for the recording timer; reuse the sessions
      sidebar / persistence / retry (all job-id based, already working).
- [ ] Keep the backend change minimal (ALLOWED_SUFFIXES only, if anything).
- [ ] Work on a feature branch off the latest `main` (see handoff prompt).
