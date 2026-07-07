# AGENTS.md — agent guide for `stt-diarization-prototype`

> Entry point for any AI agent (Claude Code, Kiro, Cursor, Codex, …) or human
> working on this repo. Read this first, then the specs it links to. Keep this
> file short; deep detail lives in [`specs/`](specs/).

## What this is

A local, private CLI that turns an audio **or video** file into a
speaker-labeled transcript (`Speaker 1: … / Speaker 2: …`). Runs entirely on
this Mac (CPU). Product promise: **point it at a file, get a transcript — no
flags required.** Full context in [`specs/product.md`](specs/product.md).

## Golden rule (the #1 gotcha)

**Always `source env.sh` before running or testing anything.** It (a) activates
the Python 3.11 venv, (b) exports `HF_TOKEN` from `.hf_token`, and (c) redirects
every model/cache download *into this project folder*. Nothing works correctly
without it, and skipping (c) leaks gigabytes into `~/.cache`.

## Setup (from scratch)

```bash
brew install ffmpeg python@3.11
/opt/homebrew/opt/python@3.11/bin/python3.11 -m venv .venv
source env.sh                       # activate venv + env before installing
pip install -r requirements.txt
```

## Run

```bash
source env.sh
python transcribe.py <audio-or-video-file>        # e.g. meeting.mp4, call.m4a, talk.wav
```

Defaults (see `specs/requirements.md` for the authoritative list):
`--model large-v3`, language auto-detect, speaker count auto, `--device cpu`,
`--compute-type int8`, enhancement ON, `--vad-onset 0.35`. Outputs go to
`out/<name>.txt` (mirrors the terminal), `out/<name>.srt`, `out/<name>.json`.

## Test / verify (the PASS/FAIL gate)

There is no unit-test suite; verification is behavioral:

```bash
source env.sh
bash make_sample.sh                               # regenerate samples/conversation.wav (2 speakers)
python transcribe.py samples/conversation.wav     # add --model small to go ~4x faster
```

**PASS** = `out/conversation.txt` contains a transcript with **≥ 2 distinct
`Speaker N` labels** and sensible text. Any change must still pass this gate.

## Conventions

- All status output goes through `log()` (prefixes `[transcribe] `). The final
  transcript is emitted via the `emit()` closure that prints AND writes the
  `.txt` in one pass — keep them identical.
- Heavy imports (`whisperx`, `torch`, `pyannote`) are **lazy** — done inside
  functions, not at module top — so `python transcribe.py --help` works without
  the ML deps installed. Preserve this.
- Output files are named after the input **stem** and land in `out/`.
- Single-file design: all logic is in `transcribe.py`. Prefer keeping it that
  way unless a change is large enough to warrant a module.

## Gotchas — things agents get wrong here (each backed by an ADR)

- **Do NOT** switch `--device` to `mps`/`cuda`. CTranslate2 (faster-whisper's
  backend) has no Metal/MPS support on Mac. → [`ADR-0001`](specs/adr/0001-cpu-only.md)
- **Do NOT** casually bump the pinned versions in `requirements.txt`. WhisperX
  3.4.2 breaks against newer torch/pyannote; the pins are a hand-verified
  coherent set. → [`ADR-0002`](specs/adr/0002-load-bearing-version-pins.md)
- **Do NOT** add caches or downloads outside the project. Cleanup =
  `rm -rf` the folder; leaking breaks that promise. → [`ADR-0003`](specs/adr/0003-self-contained-caches.md)
- **Do NOT** remove enhancement / lower VAD sensitivity by default — it's a
  deliberate UX choice that recovers quiet speakers. → [`ADR-0004`](specs/adr/0004-enhance-and-sensitive-vad-by-default.md)
- **Do NOT** delete the diarizer's second (component-pipeline) attempt in
  `load_diarizer()` — it's the fallback that lets diarization work without the
  gated pyannote meta-model. → [`ADR-0005`](specs/adr/0005-diarizer-component-fallback.md)

## Where to look

| You want to… | Read |
|---|---|
| Understand the product & who it's for | [`specs/product.md`](specs/product.md) |
| Understand the stack, pins, constraints | [`specs/tech.md`](specs/tech.md) |
| Find which function owns a pipeline stage | [`specs/structure.md`](specs/structure.md) |
| Know the exact required behavior (EARS) | [`specs/requirements.md`](specs/requirements.md) |
| Understand architecture & data flow | [`specs/design.md`](specs/design.md) |
| Know *why* a decision was made | [`specs/adr/`](specs/adr/) |
| Add a feature or refactor | copy [`specs/tasks/TEMPLATE.md`](specs/tasks/TEMPLATE.md) |

## How to add a feature (the spec-driven loop)

1. Read this file + the relevant `specs/`.
2. Add/adjust an EARS line in `specs/requirements.md` (give it a new `REQ-###`).
3. Note the design impact in `specs/design.md`; add an ADR if it's a real decision.
4. Copy `specs/tasks/TEMPLATE.md` → `specs/tasks/<feature>.md`, fill the checklist
   (each task back-referencing its `REQ-###`).
5. Implement against the plan.
6. Verify with the gate above. Update docs if behavior changed.
