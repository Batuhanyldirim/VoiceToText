# Product — `stt-diarization-prototype`

*Steering doc: what this is, who it's for, and the promises it must keep.
Read alongside [`tech.md`](tech.md) and [`structure.md`](structure.md).*

## Purpose

Turn a recording of a conversation into a **speaker-labeled transcript** —
who said what — running entirely on the user's own Mac, and optionally into a
**structured clinical note draft** for clinician review.

## Who it's for

A single technical user prototyping a speech-to-text product. Not a hosted
service, not multi-tenant, no accounts. Privacy matters: audio never leaves the
machine (all models run locally).

## Two ways to use it

Both surfaces share one pipeline library (`stt_core`) — same models, same
results.

1. **CLI** — for terminal users and scripting. `transcribe meeting.mp4`.
2. **Web app** — for a **no-terminal-needed** experience: open the page,
   **upload** a file, watch **live progress**, then read the **transcript
   viewer** and download `.txt`/`.srt`/`.json`. Runs against a local API on
   `127.0.0.1` — still fully offline, audio never leaves the machine.

## From transcript to clinical note (optional next step)

After a transcript is ready, the user can turn it into a **structured clinical
note** — a patient–doctor conversation rendered as an accurate, organized note
(SOAP, H&P, or a pasted sample format). Two promises govern this step:

- **It's a draft for clinician review, never a finalized record.** The note keeps
  a "Clinician Review Needed" section that flags unclear, contradictory, or
  possibly-misheard items instead of silently "fixing" them.
- **Local by default, so PHI stays on the machine.** The AI backend is
  pluggable: a **local model (Ollama) is the default** and the transcript never
  leaves the Mac. A cloud model (Claude) is an **explicit opt-in** the operator
  turns on via server env — and when it's on, the UI warns that the transcript
  will be sent off-device (use only with authorization). See
  [`adr/0009-clinical-note-pluggable-provider.md`](adr/0009-clinical-note-pluggable-provider.md).

The note streams in live and is copy/download-able as Markdown.

## The product promise (the UX contract)

**Point it at a file, get a transcript. No flags required.**

```bash
source env.sh
transcribe meeting.mp4            # CLI
# — or — open the web app and drag the file in (no flags, no terminal)
```

Everything that makes results good is a *default*, not something the user must
know to switch on:

- **Any file works** — audio (`.wav/.mp3/.m4a/.flac/…`) or video
  (`.mp4/.mov/.mkv/.webm/…`); the audio track is extracted automatically.
- **Language is auto-detected** — works for any language Whisper supports.
- **Speaker count is auto-detected** — the user doesn't have to say how many
  people are talking.
- **Uneven mic distance is handled** — a quiet/far speaker is automatically
  leveled up so their words aren't lost next to a loud/close speaker.
- **Accuracy over speed** — defaults favor the best result; the run may be
  roughly real-time on CPU, which is an accepted tradeoff.

Flags exist only as **opt-out / power-user overrides** (e.g. `--model small`
for speed, `--min-speakers`/`--max-speakers` to bound the count). Adding a
feature must not erode the no-flags default path.

## Secondary promises

- **Privacy stays local** — even with the web app, the API binds `127.0.0.1`,
  runs models locally, and reads `HF_TOKEN` only from server env (never from the
  browser, never logged or returned).
- **One-command cleanup** — everything downloaded lives inside the project
  folder; `rm -rf` the folder removes 100% of it (job scratch under
  `apps/api/jobs/` is inside the project too). See
  [`adr/0003-self-contained-caches.md`](adr/0003-self-contained-caches.md).
- **The CLI `.txt` output mirrors the terminal exactly** and is written live.

## Explicit non-goals (for now)

- No real-time / streaming transcription (batch files only).
- No GPU acceleration (CPU-only by design — see
  [`adr/0001-cpu-only.md`](adr/0001-cpu-only.md)).
- No speaker *identification* (naming real people); speakers are anonymous
  `Speaker 1/2/…` per recording.
- **Not a hosted/multi-tenant service.** The web app is a single-user local
  convenience (one machine, one worker), not a deployed multi-user backend — no
  accounts, no auth, bound to localhost.
