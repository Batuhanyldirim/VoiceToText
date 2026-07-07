# ADR-0004 — Audio enhancement + sensitive VAD on by default

**Status:** Accepted · **Relates to:** REQ-030, REQ-011, `product.md`

## Context

A common real-world recording has one speaker close to the mic (loud) and
another far (quiet). Measured on a test clip where the quiet speaker was ~30 dB
lower, the raw pipeline **dropped that speaker's lines entirely** and
misattributed them. The product promise is "point at a file, get a good
transcript — no flags," so the robust behavior must be the default, not an
opt-in flag the user has to know about.

Two levers were tested:
1. **Audio enhancement** — an ffmpeg chain (`highpass=f=80`, `speechnorm`,
   `dynaudnorm`, `loudnorm`) that pulls quiet speech up toward loud speech.
2. **VAD sensitivity** — WhisperX's `vad_onset` (default 0.5); lowering it makes
   voice-activity detection catch quieter speech.

Enhancement was verified to **recover the dropped speaker** (2→4 correct turns on
the hard clip) and to be **harmless on clean, balanced audio** (identical output
with and without).

## Decision

Ship with enhancement **ON by default** and `vad_onset = 0.35` (more sensitive
than the 0.5 stock value). Flags are opt-**out** / override:
- `--no-enhance` disables the leveling pass.
- `--vad-onset <float>` overrides sensitivity.

The enhanced file is written to `out/<stem>.enhanced.wav` (inside the project,
per ADR-0003).

## Consequences

- ✅ Uneven-mic recordings work with no flags; the default path is robust.
- ✅ No downside on already-clean audio (verified).
- ➖ Adds a quick ffmpeg pass (~1–2 s) to every run. Accepted.
- ⚠️ **Do not** make enhancement opt-in or raise `vad_onset` back to 0.5 by
  default — that regresses the core UX promise. If enhancement ever hurts a real
  file, prefer adding a smarter/auto-tuned chain over turning it off by default.
- Enhancement cannot recover a speaker who is essentially inaudible; the real fix
  for extreme cases is a better recording (documented in README).
