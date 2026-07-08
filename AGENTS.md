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
  **selectable, pluggable AI provider** (local Ollama default; more enabled via an
  operator allowlist over a generic seam). The chosen template **is** the note (+
  one appended review section). Output is **Turkish**. → [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md), [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)
- **CLI** ([`apps/cli`](apps/cli)) — thin `transcribe` wrapper; same flags/output as before.
- **API** ([`apps/api`](apps/api)) — FastAPI backend (upload → job → live progress → download; plus note endpoints).
- **Web** ([`apps/web`](apps/web)) — Vite + React + TS + MUI UI (built on the API).

Product promise is unchanged: **point it at a file, get a transcript — no flags
required.** The web UI adds a **no-terminal-needed** path, and now a
transcript → **clinical note draft** step (local by default; PHI stays on-device),
a **selectable note provider/model**, **timing chips + a live elapsed timer**, and
a **sessions sidebar** ("Oturumlar") that shows in-progress work (returnable,
refresh-safe, retryable) above saved notes. Full context in
[`specs/product.md`](specs/product.md).

## Monorepo map

```
stt-diarization-prototype/
├── AGENTS.md                 # this file (CLAUDE.md is a symlink to it)
├── env.sh, cleanup.sh        # source env.sh first; cleanup reports footprint
├── pyproject.toml            # uv workspace root: members = packages/*, apps/cli, apps/api
├── uv.lock                   # ONE lockfile for all Python packages
├── specs/                    # product/tech/structure/requirements/design + adr/ + tasks/
├── packages/core/            # stt-core: shared transcription pipeline (HOLDS THE VERSION PINS)
├── packages/note-core/       # note-core: pure clinical-note generation (pluggable provider, Turkish; ADR-0009)
├── apps/cli/                 # stt-cli: thin CLI wrapper (transcribe)
├── apps/api/                 # stt-api: FastAPI backend + in-process job worker (transcribe + notes)
│                             #   store.py = SQLite note history; notes.db = saved notes (git-ignored, PHI; ADR-0010)
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
`apps/api/notes.db`, `node_modules/`, and `.hf_token` are git-ignored, so a clone
has none of them yet.

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
make api          # sources env.sh inside the recipe (HF_TOKEN + caches +
                  # STT_NOTE_PROVIDERS/provider dropdown), runs uvicorn — NO --reload
# editing backend code? use `make api-dev` (reload SCOPED to apps/api/src + packages)
# manual equivalent: source env.sh && .venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000
# then open http://127.0.0.1:8000/docs
```

`make api` deliberately runs **without `--reload`**: jobs live in memory and a
reload orphans in-flight work (dead SSE stream, "stuck at done"). It also sources
`env.sh` for you — running bare uvicorn in a shell that didn't source it silently
drops `HF_TOKEN`, the cache redirects, and the provider selector.

Endpoints: `POST /jobs` (multipart upload) · `GET /jobs` (active transcriptions) ·
`GET /jobs/{id}` (status+result) · `GET /jobs/{id}/events` (SSE progress) ·
`POST /jobs/{id}/retry` · `GET /jobs/{id}/download/{fmt}` (`txt`|`srt`|`json`).
See [`apps/api/README.md`](apps/api/README.md).

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

Notes are generated in **Turkish** (Turkish prompt + templates "SOAP notu" /
"Öykü ve Muayene (Ö&M)"; the **chosen template IS the note** + one appended
"Klinik İnceleme Gerekli" review section) and the whole web UI is Turkish. From a
completed transcript, generate a note via the API note endpoints:
`GET /notes/templates` · `GET /notes/providers` · `POST /notes` · `GET /notes/{id}`
(poll) · `GET /notes/{id}/events` (SSE token deltas). In the web UI: transcript
viewer → pick a provider/model + template (or paste a serbest metin format) →
live-streamed note → copy / download `.md`.

**Selectable provider (→ [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)).**
The committed default exposes **only Ollama** (the provider/model selector hides
when one provider is enabled). More are enabled by the operator via
`STT_NOTE_PROVIDERS` (comma list, default `ollama`) — set it in the git-ignored
`env.local.sh` that `env.sh` sources last. A provider's `off_device` flag drives
the PHI warning banner. The first-party cloud (Claude) path stays gated behind
`STT_NOTE_PROVIDER=claude` + a server-env token (`uv sync --extra claude`).
Machine-specific integrations go in an uncommitted `note_core._local_providers`
module (self-hidden unless usable) — never in committed code.

**Timing (→ [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)).**
Transcription/note wall-clock is measured in the worker, persisted
(`transcribe_seconds` into `out/*.json`; `transcribe_seconds`/`note_seconds`
columns in the notes DB), and shown as "Deşifre: Xs" / "Not: Ys" + model chips. A
live elapsed timer is anchored to the server `started_at` so it survives a refresh.

Three conveniences layer on top:
- **Transcript reuse** (→ [`ADR-0010`](specs/adr/0010-persistent-notes-sqlite.md)) —
  instead of re-uploading, pick an existing CLI transcript from `out/`
  (`GET /transcripts` → `GET /transcripts/{name}`, e.g. `HistoryTaking_YA`) and
  generate a note from it — a dev-cycle speedup.
- **Persistent history** (→ [`ADR-0010`](specs/adr/0010-persistent-notes-sqlite.md)) —
  completed notes are saved to a project-local SQLite DB (`apps/api/notes.db`,
  `STT_DB_PATH` override, git-ignored). Browse: `GET /notes` (list) ·
  `GET /notes/{id}` (open; also serves saved notes) · `DELETE /notes/{id}`.
- **Sessions sidebar + retry** (→ [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)) —
  the web "Oturumlar" sidebar shows active work on top (`GET /jobs`,
  `GET /notes/active`; spinner + Turkish stage, or ⚠ + "Tekrar dene"), a divider,
  then saved notes. Failed work retries in place (`POST /jobs/{id}/retry` re-uses
  the uploaded file on disk; `POST /notes/{id}/retry` re-uses transcript+opts). A
  `localStorage` pointer + SSE re-attach make an in-progress job survive a page
  refresh. Active jobs are **in-memory** — a server restart drops them.

### Tests: fast pytest suite (store + API) + the behavioral pipeline gate

Two layers (→ [`ADR-0017`](specs/adr/0017-pytest-store-and-api-suite.md)):

**1. `make test`** — the fast pytest suite (`apps/api/tests/`) for the pure-Python
store + API layer (migrations, note edit/finalize lifecycle, patient organization,
endpoint status codes). No ML models; runs in <1 s; uses a **temp DB** (never the
real `apps/api/notes.db`). Run it after any change to `store.py` / the note+patient
endpoints, and add a test with new store/endpoint logic.

**2. The behavioral pipeline gate** (the ML models are too slow/nondeterministic
to unit-test):

```bash
source env.sh
bash make_sample.sh                               # regenerate samples/conversation.wav (2 speakers)
transcribe samples/conversation.wav               # add --model small to go ~4x faster
```

**PASS** = a transcript with **≥ 2 distinct `Speaker N` labels** and sensible
text. Via the CLI: check `out/conversation.txt`. Via the API: upload the sample
and confirm `result.num_speakers ≥ 2` (poll `GET /jobs/{id}`). Any pipeline change
must still pass this gate.

**Note gate:** with `ollama serve` running, generating a note from that
transcript on the default local provider must produce a **Turkish** note in the
chosen template's headings, ending in a populated **"Klinik İnceleme Gerekli"**
section (and no A–E scaffold / banner / preamble), flag an ambiguous term rather
than silently "correcting" it, and keep off-device providers refused unless the
operator enabled them (`STT_NOTE_PROVIDERS`; cloud also needs
`STT_NOTE_PROVIDER=claude` + a token).

**History round-trip:** reuse a transcript from `out/` (`GET /transcripts` →
`GET /transcripts/{name}`), generate a note, confirm it appears in `GET /notes`,
re-open it in full via `GET /notes/{id}` **after restarting the server** (proves
it persisted to `apps/api/notes.db`), then `DELETE /notes/{id}`. The DB must stay
git-ignored (`git status` should never show `notes.db`).

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

## Live (streaming) transcription — the approach we chose (design-level)

> Keep this. It records **what** we decided for transcribing-while-recording and
> **why**, so nobody re-litigates it or reaches for a worse approach. Full detail:
> [`ADR-0014`](specs/adr/0014-live-streaming-transcription.md) + [`specs/design.md`](specs/design.md) (REQ-125–131).

**Goal.** Use the recording time to do the slow work, so the wait *after* the user
hits stop is short. Not real-time captions — a few seconds behind is fine.

**What we chose (and proved with a throwaway spike before building):**
- **Chunk the ASR during recording; diarize ONCE at finish.** ASR is the slow,
  local-window part and can overlap recording. Diarization needs the whole audio
  (pyannote clusters speakers globally), so it stays a **single global pass at the
  end** — never per-chunk (per-chunk speaker labels can't be matched across chunks).
- **Cut chunks on SILENCE only, never on a fixed timer.** The spike measured
  **99.4% word-parity** with one-shot for silence-aligned cuts vs **59.4% for
  naive fixed cuts** — a mid-word cut mangles the word on both sides because
  Whisper decodes each window independently (`condition_on_previous_text=False`).
  Keep each chunk **< ~30 s** (the model window) and **offset each chunk's
  timestamps by its absolute start** or the finish-time diarization fusion
  misaligns.
- **Client sends raw PCM via an `AudioWorklet`, not `MediaRecorder`.** WebM/Opus
  `MediaRecorder` chunks aren't independently decodable (only the first has the
  container header); PCM frames are. Downsample to 16 kHz mono in the browser.
- **A SEPARATE ingest path.** Unlike the plain voice recorder (which reuses the
  file-upload `POST /jobs` path — [`ADR-0013`](specs/adr/0013-in-app-voice-recording.md)),
  streaming has its own `stt_core.StreamingTranscriber` + `/stream` endpoints.
  `finish()` returns a normal `TranscribeResult`, so the transcript viewer,
  downloads, and note generation are **reused unchanged**.
- **Local-only + a tradeoff.** PCM goes only to `127.0.0.1`; **no browser/cloud
  speech API** (the Web Speech API ships audio to Google — banned, ADR-0003).
  Streaming **skips whole-file enhancement** (ADR-0004 needs the complete file) —
  a documented tradeoff; a quiet/far speaker is better served by the batch
  record/upload path. Sessions are **in-memory** (ADR-0008/0012): a restart drops
  an in-flight stream.

Measured payoff: ~43% less waiting after stop on a 60 s clip (`large-v3`), growing
with recording length.

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
- **Do NOT** commit or move the notes DB. `apps/api/notes.db` holds **PHI**
  (transcript + generated note); it's git-ignored and project-local (override with
  `STT_DB_PATH`) so `rm -rf` still cleans up and nothing is ever committed. Keep
  the note prompt/templates/UI **Turkish** (REQ-106) — don't revert to English.
  → [`ADR-0010`](specs/adr/0010-persistent-notes-sqlite.md), [`ADR-0003`](specs/adr/0003-self-contained-caches.md)
- **Do NOT** hardcode a specific cloud/off-device provider or commit
  machine-specific integrations. Providers are resolved through a generic seam
  gated by `STT_NOTE_PROVIDERS` (committed default = only Ollama). Local/off-device
  ones live in an **uncommitted `note_core._local_providers`** module + git-ignored
  `env.local.sh`; committed code has no Opus/cloud-CLI wording.
  → [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)
- **Do NOT** add `--reload` to `make api` or assume jobs are durable. Active
  transcriptions/notes live **in memory in the server process** — a restart (incl.
  a reload) **drops in-flight work**. Use `make api-dev` (reload scoped to source
  dirs) only while editing code; only *completed* notes persist (SQLite).
  → [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md), [`ADR-0008`](specs/adr/0008-fastapi-inprocess-jobs-sse.md)
- **Do NOT** re-emit the pipeline's own `"done"` to clients. The worker swallows
  it and emits the authoritative terminal `"done"` only after `job.result` is set —
  removing that ordering reintroduces the "stuck at done" race on large files.
  → [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)
- **Do NOT** revive the mandatory A–E note scaffold. The chosen template IS the
  note (+ one appended "Klinik İnceleme Gerekli"); no banner/preamble, no repeated
  content. → [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md)
- **Do NOT** cut streaming ASR chunks on a fixed timer, diarize per-chunk, or
  forget to offset chunk timestamps. Cut on **silence** (mid-word cuts drop
  words — measured 59% vs 99% parity), diarize **once at finish**, offset each
  chunk's timestamps by its absolute start. And **never** route audio through a
  browser/cloud speech API — streaming ASR is local-only.
  → [`ADR-0014`](specs/adr/0014-live-streaming-transcription.md)

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
| Understand the provider seam / timing / sessions | [`specs/adr/0011-selectable-note-provider-plugin-seam.md`](specs/adr/0011-selectable-note-provider-plugin-seam.md) + [`specs/design.md`](specs/design.md) |
| Understand in-app voice recording | [`specs/adr/0013-in-app-voice-recording.md`](specs/adr/0013-in-app-voice-recording.md) |
| Understand live/streaming transcription | the "Live (streaming) transcription" section above + [`specs/adr/0014-live-streaming-transcription.md`](specs/adr/0014-live-streaming-transcription.md) |
| Add a feature or refactor | copy [`specs/tasks/TEMPLATE.md`](specs/tasks/TEMPLATE.md) |

## Shipped features

- **Clinical note generation** — turn a transcript into a structured **Turkish**
  clinical **note draft** via a **pluggable AI provider** (local Ollama by
  default, Claude opt-in; PHI stays local). Pure logic in
  [`packages/note-core`](packages/note-core); API note endpoints + web note
  screens on top. Full plan, operational knowledge, and the clinical prompt are in
  [`specs/tasks/clinical-note-generation.md`](specs/tasks/clinical-note-generation.md);
  the decision is [`ADR-0009`](specs/adr/0009-clinical-note-pluggable-provider.md)
  (REQ-100–106).
- **Transcript reuse + persistent history** — generate notes from existing `out/`
  transcripts (`GET /transcripts`) instead of re-uploading, and browse completed
  notes saved to a project-local, git-ignored SQLite DB (`GET`/`DELETE /notes`,
  `apps/api/notes.db`). → [`ADR-0010`](specs/adr/0010-persistent-notes-sqlite.md)
  (REQ-107–110).
- **Selectable provider + plugin seam** — pick provider/model in the UI (hidden
  when one provider); operator allowlist (`STT_NOTE_PROVIDERS`) over a generic seam;
  git-ignored `_local_providers` + `env.local.sh` for machine-specific/off-device
  backends; committed repo ships only Ollama. Includes the **note-output reshape**
  (chosen template IS the note). → [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md)
  (REQ-111–114).
- **Timing metrics + sessions sidebar** — `transcribe_seconds`/`note_seconds` chips
  + refresh-safe live timer (anchored to `started_at`); the "Oturumlar" sidebar
  shows active work (returnable, retryable via `POST /jobs|notes/{id}/retry`,
  refresh-safe) above saved notes. Active jobs are in-memory (die on restart).
  → [`ADR-0011`](specs/adr/0011-selectable-note-provider-plugin-seam.md) (REQ-115–119).

## How to add a feature (the spec-driven loop)

1. Read this file + the relevant `specs/`.
2. Add/adjust an EARS line in `specs/requirements.md` (give it a new `REQ-###`).
3. Note the design impact in `specs/design.md`; add an ADR if it's a real decision.
4. Copy `specs/tasks/TEMPLATE.md` → `specs/tasks/<feature>.md`, fill the checklist
   (each task back-referencing its `REQ-###`).
5. Implement against the plan — pipeline changes go in `stt_core`; keep CLI/API thin.
6. Verify with the gate above. Update docs if behavior changed.
