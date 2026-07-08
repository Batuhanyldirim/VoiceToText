# ADR-0014 — Live (streaming) transcription: chunk ASR during recording, diarize once at finish

**Status:** Accepted · **Relates to:** REQ-125–REQ-131, ADR-0013, ADR-0008, ADR-0012, ADR-0004, ADR-0003, ADR-0001, `packages/core/src/stt_core/streaming.py`, `apps/api/src/stt_api/stream.py`, `apps/web/src/components/StreamingRecorder.tsx`, `apps/web/public/pcm-worklet.js`

## Context

Transcription is slow on CPU (ADR-0001): for a several-minute recording the user
records, hits stop, then **waits out the entire pipeline** (`enhance → ASR →
align → diarize → fuse`). ASR dominates (~60–65% of wall-clock). The recording
time itself is dead time.

The idea: **transcribe while recording**, so when the user stops, most of the ASR
is already done and only a short finalize remains. The result doesn't need to be
live captions — a few seconds behind is fine.

We de-risked this with a throwaway spike before committing (findings in the
project memory). Two results decided the design:

1. **Accuracy is preserved *only* if chunks are cut on silence.** Silence-aligned
   chunked ASR measured **99.4% word-parity** vs one-shot (the sole diff across a
   full transcript was one comma). **Naive fixed-interval cutting measured 59.4%**
   — cutting mid-word mangles/loses the word on both sides, because Whisper
   decodes each window independently with no cross-window context
   (`condition_on_previous_text=False` in whisperx's batched pipeline). This is
   exactly the user's worry, confirmed and then designed out.
2. **Diarization cannot be chunked.** pyannote clusters speaker embeddings across
   the whole recording; per-chunk labels can't be matched across chunks without a
   re-identification step that erodes accuracy. It also isn't the bottleneck. So
   diarization stays a **single global pass at finish**, which is also what the
   batch pipeline and whisperx itself do.

Reading whisperx's own source (`asr.py: FasterWhisperPipeline.transcribe`,
`merge_chunks`) confirmed the design is faithful to its internals: 30 s default
window, no context carry-over, timestamps taken from the VAD window (so we must
offset each chunk's timestamps by its absolute start).

## Decision

Add a **new streaming ingest path** — deliberately *not* the file-upload reuse of
ADR-0013, because the input is a live PCM stream, not a finished file.

- **Client: raw PCM, not `MediaRecorder`.** WebM/Opus `MediaRecorder` chunks
  aren't independently decodable (only the first carries the container header), so
  streaming them is fragile. Instead an **`AudioWorklet`** (`public/pcm-worklet.js`)
  taps the mic graph and posts Float32 PCM frames; `StreamingRecorder.tsx`
  downsamples to 16 kHz mono and POSTs them to the API as they accumulate. Nothing
  leaves the machine except this stream to `127.0.0.1` — **no Web Speech API / no
  cloud STT** (REQ-128, ADR-0003).
- **Server: `stt_core.StreamingTranscriber`.** A stateful object that
  `feed(pcm)`s audio into a buffer, and whenever ≥ a chunk target has accumulated
  **cuts at the quietest frame in a bounded silence-search window** (never
  mid-word; RMS-based), runs **ASR + align on that chunk**, offsets the returned
  timestamps by the chunk's absolute start, and appends the segments. Chunk text is
  streamed out incrementally. `finish()` flushes the tail, runs **one global
  diarization pass** over the full accumulated audio, fuses (word- or
  segment-level, same as batch), builds turns, and returns a normal
  **`TranscribeResult`** — so downloads, note generation, and the transcript viewer
  are all reused unchanged. `stt_core` stays pure (no I/O, no printing).
- **API: `/stream` endpoints on the same in-process worker model (ADR-0008).**
  `POST /stream` opens a session (returns `stream_id`); `POST /stream/{id}/audio`
  appends a PCM frame (chunk ASR runs on the worker); `GET /stream/{id}/events` is
  the SSE feed of incremental transcript deltas + stage; `POST /stream/{id}/finish`
  runs finalize and publishes a `TranscribeResult`; `GET /stream/{id}` polls
  status/result; downloads reuse the job download shape. Sessions are **in-memory,
  server-process-scoped** (ADR-0012): a restart drops an in-flight stream.
- **Enhancement is skipped in streaming mode** (REQ-131). The whole-file leveling
  pass (ADR-0004) needs the complete file; incremental chunks can't get it without
  re-processing. This is a **documented tradeoff** — streaming trades the
  enhancement pass for incremental speed; the batch upload/record paths keep
  enhancement. Diarization still happens (at finish).

## Consequences

- ✅ Post-stop wait drops to roughly the finalize (diarize) pass — the spike
  measured ~43% less waiting on a 60 s clip with `large-v3`, and the win grows
  with recording length (more ASR overlaps recording).
- ✅ Accuracy matches one-shot (~99%+) because chunks are silence-aligned and
  diarization is global; the transcript viewer / note flow / downloads are reused.
- ✅ Privacy posture holds — PCM goes only to the local API; all ASR is local.
- ➖ **A genuine second ingest path** (new core object + endpoints + client PCM
  capture), unlike the recorder that reused the upload path. More surface to
  maintain; justified by the latency win.
- ➖ Streaming forgoes whole-file **enhancement** (REQ-131) — a quiet/far speaker
  is better served by the batch record/upload path. Total *CPU* is slightly higher
  (per-chunk model invocations), but *perceived* wall-clock after stop is much
  lower, which is the point.
- ⚠️ **Do not** cut chunks on a fixed timer (mid-word damage — measured 59% parity);
  cut on silence only, keep chunks < ~30 s, and **offset chunk timestamps** by
  their absolute start or diarization fusion misaligns. **Do not** diarize
  per-chunk. **Do not** route audio through any browser/cloud speech API. **Do
  not** assume a streaming session survives a server restart (in-memory, ADR-0012).
