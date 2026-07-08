# Task: Live (streaming) transcription during recording

**Status:** IN PROGRESS. Spec landed (REQ-125–131, ADR-0014, design.md data-flow,
AGENTS.md design section). De-risked by a throwaway spike first (99.4% word-parity
for silence-cut chunking vs 59.4% naive; ~43% less post-stop wait) — findings in
project memory.

## Goal

Transcribe **while** recording so the wait after "stop" shrinks to ~the finalize
(diarize) pass. Not live captions — a few seconds behind is fine. Accuracy must
match one-shot.

## The chosen design (→ ADR-0014)

- Client: `AudioWorklet` → raw Float32 PCM → downsample 16 kHz mono → POST frames.
- Server `stt_core.StreamingTranscriber`: buffer; cut on **silence** when ≥ chunk
  target (never mid-word); ASR+align each chunk; **offset timestamps by abs start**;
  stream text deltas. `finish()` = flush tail → **one global diarization pass** →
  fuse → build_turns → return a normal `TranscribeResult`.
- API `/stream` endpoints on the ADR-0008 in-process worker; in-memory sessions.
- Local-only (no Web Speech API); **enhancement skipped** in streaming (REQ-131).

## Build plan / checklist

- [ ] REQ-125–131 in requirements.md · ADR-0014 · design.md · AGENTS.md  *(done)*
- [ ] `stt_core/streaming.py`: `StreamingTranscriber` (feed/finish), silence
      chunker, word/segment fuse reuse, `TranscribeResult` out. Pure (no I/O).
- [ ] Export from `stt_core/__init__.py`.
- [ ] `apps/api/.../stream.py`: `StreamManager` + session dataclass on the worker.
- [ ] `/stream` endpoints in `main.py`: open, audio-append, SSE events, finish,
      poll, download (reuse job download shape).
- [ ] Headless verify: stream a WAV's PCM → finish → compare transcript + speakers
      to one-shot `transcribe()`; expect ~99% parity, ≥2 speakers, lower post-stop.
- [ ] `apps/web/public/pcm-worklet.js` + `StreamingRecorder.tsx`; wire into
      `UploadScreen` as a live-transcription toggle; on finish → TranscriptViewer.
- [x] build + lint green (only the 2 pre-existing TranscriptViewer warnings).
- [x] Adversarial multi-agent review; fix confirmed findings; commit.
      Review confirmed 5 medium findings, all fixed:
      1+3. Stream sessions no longer listed in GET /jobs (they misrouted to
           /jobs/{streamId} → 404 / broken retry / abandoned recording); the
           StreamingRecorder self-polls to completion instead.
      2.   Abandoned stream leaked a blocked worker thread + buffered audio →
           added DELETE /stream/{id} (client cancels on unmount) + a 120s
           idle-timeout that auto-reaps; verified the worker unblocks + is removed.
      4.   Note-from-stream → back kept downloadSource=stream (threaded a
           `source` flag through the note views) so downloads hit /stream/{id}.
      5.   Refresh of a stream-sourced note restores via noteId (note-stream-fresh)
           instead of getJob(streamId) → 404.
      (core-correctness + frontend-audio reviewers stalled on the large diff;
      covered manually: headless 100% word parity + HTTP round-trip re-run green
      post-fix; downsample math + cancel/unblock unit-tested.)

## Verify (this feature)

```bash
source env.sh && make api      # /stream endpoints
make web                        # live-transcription toggle in the recorder
```
PASS =
1. Record with live transcription on → transcript grows during recording; on stop
   the finalize is short and the full transcript shows ≥2 speakers (the gate).
2. Headless: streamed transcript ≈ one-shot transcript (~99% word parity) for the
   same audio; speaker count matches.
3. Mic/AudioWorklet unavailable or denied → Turkish message, no session (REQ-130).
4. No audio leaves 127.0.0.1 (REQ-128).

## Constraints (don't violate)
- Cut on silence only; chunks < ~30 s; offset chunk timestamps. (REQ-126)
- Diarize once at finish, never per-chunk. (REQ-127)
- Local-only ASR; no browser/cloud speech API. (REQ-128, ADR-0003)
- `stt_core` stays pure (no printing / no file writes); reuse fuse/build_turns.
- Reuse the transcript viewer / downloads / note flow via a normal
  `TranscribeResult` from `finish()`.
