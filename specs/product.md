# Product — `stt-diarization-prototype`

*Steering doc: what this is, who it's for, and the promises it must keep.
Read alongside [`tech.md`](tech.md) and [`structure.md`](structure.md).*

## Purpose

Turn a recording of a conversation into a **speaker-labeled transcript** —
who said what — running entirely on the user's own Mac.

## Who it's for

A single technical user prototyping a speech-to-text product. Not a hosted
service, not multi-tenant, no accounts. Privacy matters: audio never leaves the
machine (all models run locally).

## The product promise (the UX contract)

**Point it at a file, get a transcript. No flags required.**

```bash
source env.sh
python transcribe.py meeting.mp4
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

- **One-command cleanup** — everything downloaded lives inside the project
  folder; `rm -rf` the folder removes 100% of it. See
  [`adr/0003-self-contained-caches.md`](adr/0003-self-contained-caches.md).
- **The `.txt` output mirrors the terminal exactly** and is written live.

## Explicit non-goals (for now)

- No real-time / streaming transcription (batch files only).
- No GPU acceleration (CPU-only by design — see
  [`adr/0001-cpu-only.md`](adr/0001-cpu-only.md)).
- No speaker *identification* (naming real people); speakers are anonymous
  `Speaker 1/2/…` per recording.
- No web UI or API; it's a CLI.
