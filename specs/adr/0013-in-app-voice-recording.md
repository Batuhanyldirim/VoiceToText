# ADR-0013 — In-app voice recording reuses the file-upload path

**Status:** Accepted · **Relates to:** REQ-120–REQ-124, ADR-0008, ADR-0012, ADR-0003, `apps/web/src/components/VoiceRecorder.tsx`, `apps/web/src/components/UploadScreen.tsx`, `apps/api/src/stt_api/main.py`

## Context

The upload screen offered two ways to start work: drag/drop a file, or reuse an
existing CLI transcript. Users also want to **record directly in the browser** —
dictate a consult, capture a two-person conversation — without first recording
into another app and exporting a file.

The transcription path is already entirely file-based: the web
`UploadScreen.onSubmit(file, options)` → `App.handleSubmit` → `createJob(file,
options)` posts a multipart `FormData` with a `file` field to `POST /jobs`, and
everything downstream (the single in-process worker, SSE progress, the sessions
sidebar, the refresh-safe live timer, retry) is keyed only by the returned
`job_id` (ADR-0008, ADR-0012). A browser `MediaRecorder` produces a `Blob`, and a
`Blob` wraps into a `File` for free. So recording is a **capture-and-wrap** UI
problem, not a pipeline problem — the temptation to add a streaming/websocket
audio path would be a second pipeline for no benefit here.

The one real constraint is the **container/codec**: `MediaRecorder` emits
`audio/webm` (Opus) on Chromium, `audio/mp4` on Safari, sometimes `audio/ogg`.
The server validates uploads by **filename suffix** (`ALLOWED_SUFFIXES` in
`main.py`), and ffmpeg (already a dependency, used by `enhance_audio` and
whisperx `load_audio`) decodes all of these. `.webm`, `.ogg`, `.mp4`, `.m4a`,
`.wav` are **already allowed**, so the decision is really about the client naming
the blob with a suffix the server accepts.

## Decision

Add a **client-only** recording affordance that reuses the existing upload path
verbatim; **no new backend pipeline, no new API endpoint, no new job type.**

- **Capture → File → existing `onSubmit`.** A new `VoiceRecorder` component uses
  `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder`,
  accumulates chunks into a `Blob` on stop, wraps it as
  `new File([blob], "kayit-<ts>.<ext>", { type })`, and hands it to the **same**
  `UploadScreen` submit → `createJob` → `POST /jobs`. The recorder lives *inside*
  `UploadScreen` as a mode toggle so it shares the existing options (model,
  diarize, language, speaker bounds) and the single "Deşifre et" submit; the
  resulting job is indistinguishable from an uploaded one downstream. (REQ-120)
- **Pick a nameable container up front.** A small helper probes
  `MediaRecorder.isTypeSupported` for a preferred, server-accepted MIME
  (`audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` → `audio/ogg`), and maps
  the chosen `blob.type` to a matching allowed extension. If the browser exposes
  none of these it falls back to the default and a best-effort extension; if
  `MediaRecorder`/`getUserMedia` is entirely absent the UI refuses with a clear
  message rather than producing an un-decodable upload. (REQ-124)
- **Reuse the shared timer + preview before submit.** The in-recording elapsed
  counter reuses `hooks/useElapsed.ts` (the same hook the progress screen and the
  session timer use), and the captured clip is playable via an `<audio>` blob URL
  (mirroring `TranscriptViewer`'s player) so the user can **preview or re-record**
  before committing to a transcription. (REQ-123)
- **Privacy posture unchanged.** The recording only ever leaves the machine as the
  same multipart upload to the `127.0.0.1` API; no third-party/off-device transfer
  is introduced. (REQ-121, ADR-0003, REQ-097)
- **Backend: confirm, don't expand.** `ALLOWED_SUFFIXES` already covers every
  container the client will name (`.webm`/`.ogg`/`.mp4`/`.m4a`/`.wav`); the
  client's job is to name the blob accordingly. No backend change is required for
  the common browsers; any future container is a one-line suffix addition, not a
  new path.

## Consequences

- ✅ Recording is a thin, client-only feature: one component + a mode toggle in
  `UploadScreen`. The sessions sidebar, live timer, refresh-persistence, and retry
  work unchanged because a recording *is* an ordinary transcription job.
- ✅ No second pipeline, no streaming audio transport, no new job type or endpoint
  to maintain; the privacy story is identical to file upload.
- ➖ Recording quality/robustness is bounded by the browser's `MediaRecorder`
  (container/codec, no built-in noise handling beyond the pipeline's `enhance`
  step). Acceptable — the pipeline already levels audio (ADR-0004).
- ⚠️ **Do not** add a websocket/streaming audio path or a recording-specific
  backend endpoint — the wrap-as-`File` reuse is the whole point. **Do not** name
  the blob with a suffix outside `ALLOWED_SUFFIXES`; keep the client's MIME→ext map
  in sync with the server's allow-set. The recording is **not** persisted server
  side beyond the normal job scratch (ADR-0003) and, like any in-flight job, does
  not survive a server restart (ADR-0012).
