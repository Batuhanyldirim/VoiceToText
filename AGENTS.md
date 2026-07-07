# AGENTS.md — agent guide for `stt-diarization-prototype`

> Entry point for any AI agent (Claude Code, Kiro, Cursor, Codex, …) or human
> working on this repo. Read this first, then the specs it links to. Keep this
> file short; deep detail lives in [`specs/`](specs/).

## What this is

A local, private tool that turns an audio **or video** file into a
speaker-labeled transcript (`Speaker 1: … / Speaker 2: …`), and optionally into a
**structured clinical note draft**. Runs entirely on this Mac (CPU; local LLM via
Ollama). It ships as shared pipeline libraries plus thin CLI/API/web wrappers:

- **`stt_core`** ([`packages/core`](packages/core)) — the transcription pipeline
  as an importable function. Holds the load-bearing version pins.
- **`note_core`** ([`packages/note-core`](packages/note-core)) — pure clinical-note
  generation (`generate(transcript, opts, progress) -> NoteResult`) via a
  **pluggable AI provider** (local Ollama default, Claude opt-in). → [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md)
- **CLI** ([`apps/cli`](apps/cli)) — thin `transcribe` wrapper; same flags/output as before.
- **API** ([`apps/api`](apps/api)) — FastAPI backend (upload → job → live progress → download; plus note endpoints).
- **Web** ([`apps/web`](apps/web)) — Vite + React + TS + MUI UI (built on the API).

Product promise is unchanged: **point it at a file, get a transcript — no flags
required.** The web UI adds a **no-terminal-needed** path, and now a
transcript → **clinical note draft** step (local by default; PHI stays on-device).
Full context in [`specs/product.md`](specs/product.md).

## Monorepo map

```
stt-diarization-prototype/
├── AGENTS.md                 # this file (CLAUDE.md is a symlink to it)
├── env.sh, cleanup.sh        # source env.sh first; cleanup reports footprint
├── pyproject.toml            # uv workspace root: members = packages/*, apps/cli, apps/api
├── uv.lock                   # ONE lockfile for all Python packages
├── specs/                    # product/tech/structure/requirements/design + adr/ + tasks/
├── packages/core/            # stt-core: shared transcription pipeline (HOLDS THE VERSION PINS)
├── packages/note-core/       # note-core: pure clinical-note generation (pluggable provider; ADR-0009)
├── apps/cli/                 # stt-cli: thin CLI wrapper (transcribe)
├── apps/api/                 # stt-api: FastAPI backend + in-process job worker (transcribe + notes)
└── apps/web/                 # Vite+React+TS+MUI frontend (separate npm project, NOT in the uv workspace)
```

The Python packages form **one uv workspace** (one `uv.lock`, editable
interdependencies via `[tool.uv.sources] stt-core = { workspace = true }`). The
web app is a **separate plain npm project** — not in the uv workspace, not pnpm.
→ [`ADR-0006`](specs/adr/0006-monorepo-uv-workspace.md)

## Golden rule (the #1 gotcha)

**Always `source env.sh` before any Python work — CLI or API.** It (a) activates
the shared Python 3.11 venv (`.venv/`), (b) exports `HF_TOKEN` (from an
already-set env var, else from a `.hf_token` file — see Setup), and (c) redirects
every model/cache download *into this project folder*. Nothing works correctly
without it, and skipping (c) leaks gigabytes into `~/.cache`. The **API reads
`HF_TOKEN` once from its own environment** — so start it in a shell that has
sourced `env.sh`. (The web app is pure npm and doesn't need `env.sh`.)

## Setup (from a fresh clone)

The repo is code-only — `.venv/`, `models/`, `samples/`, `out/`, `apps/api/jobs/`,
`node_modules/`, and `.hf_token` are git-ignored, so a clone has none of them yet.

```bash
# 1. System deps (macOS / Apple Silicon)
brew install ffmpeg python@3.11 uv node

# 2. Provide a Hugging Face token (needed for diarization) — pick ONE:
export HF_TOKEN=hf_your_token_here                    # a) env var, OR
cp .hf_token.example .hf_token && $EDITOR .hf_token   # b) token file
#    First create a free token (type: Read) at huggingface.co/settings/tokens
#    and accept model terms — details in .hf_token.example.

# 3. Sync the whole Python workspace into a shared .venv (creates it if absent).
#    On the FIRST run, point uv at Python 3.11 explicitly:
uv sync --all-packages --python /opt/homebrew/opt/python@3.11/bin/python3.11
#    Subsequent syncs: uv sync --all-packages
```

`source env.sh` prints whether `HF_TOKEN` is set and whether the venv is active —
check those two lines. To transcribe *without* diarization, skip the token and
pass `--no-diarize` (CLI) or `diarize=false` (API).

## Run + verify (per app)

### CLI

```bash
source env.sh
transcribe <audio-or-video-file>          # e.g. meeting.mp4, call.m4a, talk.wav
# or, without sourcing: uv run --package stt-cli transcribe <file>
```

Defaults (authoritative list in [`specs/requirements.md`](specs/requirements.md)):
`--model large-v3`, language auto-detect, speaker count auto, `--device cpu`,
`--compute-type int8`, enhancement ON, `--vad-onset 0.35`. Outputs go to
`out/<stem>.txt` (mirrors the terminal), `.srt`, `.json`.

### API

```bash
source env.sh
.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000
# (equivalently: the `stt-api` console script). Then open http://127.0.0.1:8000/docs
```

Endpoints: `POST /jobs` (multipart upload) · `GET /jobs/{id}` (status+result) ·
`GET /jobs/{id}/events` (SSE progress) · `GET /jobs/{id}/download/{fmt}`
(`txt`|`srt`|`json`). See [`apps/api/README.md`](apps/api/README.md).

### Web

```bash
cd apps/web && npm install && npm run dev     # Vite dev server on http://localhost:5173
```

Run the API in another terminal first — the UI talks to it. See
[`apps/web/README.md`](apps/web/README.md).

### Clinical note generation (transcript → note)

Local by default (Ollama), so PHI never leaves the Mac. Install Ollama and pull
the default model once:

```bash
brew install ollama
source env.sh                                 # sets OLLAMA_MODELS (into models/ollama), STT_NOTE_PROVIDER, STT_NOTE_MODEL
ollama serve &                                # start in a shell that sourced env.sh
ollama pull qwen2.5:32b-instruct              # ~20 GB; lands in models/ollama
```

Then, from a completed transcript, generate a note via the API note endpoints:
`GET /notes/templates` · `POST /notes` · `GET /notes/{id}` (poll) ·
`GET /notes/{id}/events` (SSE token deltas). In the web UI: transcript viewer →
pick a template (SOAP / H&P / paste a format) → live-streamed note → copy /
download `.md`. Cloud (Claude) is **opt-in only** — set `STT_NOTE_PROVIDER=claude`
plus `STT_CLAUDE_API_KEY` in server env (`uv sync --extra claude` for the SDK); a
UI banner warns that the transcript is sent off-device.

### The PASS/FAIL gate (behavioral — no unit suite)

```bash
source env.sh
bash make_sample.sh                               # regenerate samples/conversation.wav (2 speakers)
transcribe samples/conversation.wav               # add --model small to go ~4x faster
```

**PASS** = a transcript with **≥ 2 distinct `Speaker N` labels** and sensible
text. Via the CLI: check `out/conversation.txt`. Via the API: upload the sample
and confirm `result.num_speakers ≥ 2` (poll `GET /jobs/{id}`). Any change must
still pass this gate.

**Note gate:** with `ollama serve` running, generating a note from that
transcript on the default local provider must produce all five sections (A–E)
including a populated **"Clinician Review Needed"**, flag an ambiguous term
rather than silently "correcting" it, and keep the cloud path refused unless
`STT_NOTE_PROVIDER=claude` + a token are set.

## Conventions

- **`stt_core` is pure**: `transcribe(input_path, opts, progress)` does NOT print
  and does NOT write files. Callers (CLI/API) decide how to surface progress and
  persist output. Keep it that way.
- **CLI and API are thin wrappers** — argument/HTTP handling + output only; all
  pipeline logic lives in `stt_core`.
- **Import, not subprocess** — CLI and API both `import stt_core` and call
  `transcribe(...)` directly. Do NOT shell out to the CLI from the API.
  → [`ADR-0007`](specs/adr/0007-shared-core-import-not-subprocess.md)
- **Heavy imports (`whisperx`, `torch`, `pyannote`) are lazy** — inside functions,
  not at module top — so `transcribe --help` and API startup don't pay for them.
- Output files are named after the input **stem**; progress flows through the
  structured `ProgressEvent` callback (CLI → tqdm bar; API → SSE).

## Gotchas — things agents get wrong here (each backed by an ADR)

- **Do NOT** switch `--device` to `mps`/`cuda`. CTranslate2 (faster-whisper's
  backend) has no Metal/MPS support on Mac. → [`ADR-0001`](specs/adr/0001-cpu-only.md)
- **Do NOT** casually bump the pinned versions — now in
  [`packages/core/pyproject.toml`](packages/core/pyproject.toml). WhisperX 3.4.2
  breaks against newer torch/pyannote; the pins are a hand-verified coherent set.
  → [`ADR-0002`](specs/adr/0002-load-bearing-version-pins.md)
- **Do NOT** add caches or downloads outside the project. Job scratch under
  `apps/api/jobs/` is git-ignored; cleanup = `rm -rf` the folder. →
  [`ADR-0003`](specs/adr/0003-self-contained-caches.md)
- **Do NOT** remove enhancement / lower VAD sensitivity by default — it's a
  deliberate UX choice that recovers quiet speakers. → [`ADR-0004`](specs/adr/0004-enhance-and-sensitive-vad-by-default.md)
- **Do NOT** delete the diarizer's second (component-pipeline) attempt in
  `load_diarizer()` — it's the fallback that lets diarization work without the
  gated pyannote meta-model. → [`ADR-0005`](specs/adr/0005-diarizer-component-fallback.md)
- **Do NOT** accept `HF_TOKEN` from the browser or log/return it. The API reads
  it once from server env only. → [`ADR-0008`](specs/adr/0008-fastapi-inprocess-jobs-sse.md)
- **Do NOT** default to or hardwire the cloud note provider, or send a transcript
  off-device on the default path. Ollama is the local default; Claude is gated
  behind `STT_NOTE_PROVIDER=claude` + a server-env token (never logged/returned),
  and Ollama models must stay under `OLLAMA_MODELS` (in the project).
  → [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md), [`ADR-0003`](specs/adr/0003-self-contained-caches.md)

## Where to look

| You want to… | Read |
|---|---|
| Understand the product & who it's for | [`specs/product.md`](specs/product.md) |
| Understand the stack, pins, constraints | [`specs/tech.md`](specs/tech.md) |
| Find which package/module owns a pipeline stage | [`specs/structure.md`](specs/structure.md) |
| Know the exact required behavior (EARS) | [`specs/requirements.md`](specs/requirements.md) |
| Understand architecture & data flow | [`specs/design.md`](specs/design.md) |
| Know *why* a decision was made | [`specs/adr/`](specs/adr/) |
| Run/extend the API | [`apps/api/README.md`](apps/api/README.md) |
| Run/extend the web UI | [`apps/web/README.md`](apps/web/README.md) |
| Understand clinical note generation | [`specs/adr/0009-clinical-note-pluggable-provider.md`](specs/adr/0009-clinical-note-pluggable-provider.md) + [`specs/tasks/clinical-note-generation.md`](specs/tasks/clinical-note-generation.md) |
| Add a feature or refactor | copy [`specs/tasks/TEMPLATE.md`](specs/tasks/TEMPLATE.md) |

## Shipped features

- **Clinical note generation** — turn a transcript into a structured clinical
  **note draft** via a **pluggable AI provider** (local Ollama by default, Claude
  opt-in; PHI stays local). Pure logic in [`packages/note-core`](packages/note-core);
  API note endpoints + web note screens on top. Full plan, operational knowledge,
  and the clinical prompt are in
  [`specs/tasks/clinical-note-generation.md`](specs/tasks/clinical-note-generation.md);
  the decision is [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md)
  (REQ-100–105).

## How to add a feature (the spec-driven loop)

1. Read this file + the relevant `specs/`.
2. Add/adjust an EARS line in `specs/requirements.md` (give it a new `REQ-###`).
3. Note the design impact in `specs/design.md`; add an ADR if it's a real decision.
4. Copy `specs/tasks/TEMPLATE.md` → `specs/tasks/<feature>.md`, fill the checklist
   (each task back-referencing its `REQ-###`).
5. Implement against the plan — pipeline changes go in `stt_core`; keep CLI/API thin.
6. Verify with the gate above. Update docs if behavior changed.
