# Tech — `stt-diarization-prototype`

*Steering doc: the stack and the load-bearing constraints. Read alongside
[`product.md`](product.md) and [`structure.md`](structure.md).*

## Platform

- **macOS on Apple Silicon** (developed on an M4 Pro). CPU-only inference.
- **Python 3.11** in a shared project-local venv (`.venv/`). System Python (3.9)
  is too old for the ML stack — do not use it.
- **ffmpeg** (Homebrew) — required for audio decoding, video-track extraction,
  and the enhancement filter chain.
- **Node.js + npm** (Homebrew) — only for the web frontend (`apps/web`).
- **Ollama** (Homebrew) — local LLM runtime for clinical note generation
  (`brew install ollama`); optional (only the note feature needs it).

## Monorepo tooling

The repo is a **uv workspace** for the four Python packages plus a **separate
npm project** for the frontend. → [`adr/0006-monorepo-uv-workspace.md`](adr/0006-monorepo-uv-workspace.md)

| Concern | Tool | Notes |
|---|---|---|
| Python packages | [uv](https://docs.astral.sh/uv/) workspace | `pyproject.toml` root: `members = ["packages/*", "apps/cli", "apps/api"]` (`packages/*` now covers `stt-core` + `note-core`) |
| One lockfile | `uv.lock` | single lock across `stt-core`, `note-core`, `stt-cli`, `stt-api` |
| Editable interdeps | `[tool.uv.sources] stt-core = { workspace = true }` | CLI/API import `stt_core` in-place, no rebuild |
| Whole-workspace install | `uv sync --all-packages` | add `--python /opt/homebrew/opt/python@3.11/bin/python3.11` on first run |
| Frontend | plain `npm` (Vite) | **not** in the uv workspace, **not** pnpm |

Deliberately **not** used: Nx / Turborepo / pnpm workspaces (over-engineered for
4 Python packages + 1 web app), and Celery / Redis (see backend below).

## Python stack (shared pipeline)

| Layer | Component | Notes |
|---|---|---|
| Orchestration | [WhisperX](https://github.com/m-bain/whisperX) 3.4.2 | ties ASR + alignment + diarization together |
| ASR | faster-whisper (CTranslate2 4.4.0) | model `large-v3` by default; CPU int8 |
| Alignment | wav2vec2 forced-alignment (via WhisperX) | per-language; auto-selected |
| Diarization | pyannote-audio 3.3.2 | `speaker-diarization-3.1`, or component fallback |
| Tensor runtime | torch 2.5.1 / torchaudio 2.5.1 | CPU wheels |
| Misc | transformers 4.48.0, omegaconf, matplotlib, tqdm | see pins below |

The authoritative, commented pin list now lives in
[`packages/core/pyproject.toml`](../packages/core/pyproject.toml) (the `stt-core`
`dependencies`). The root [`requirements.txt`](../requirements.txt) is retained as
a legacy reference; `packages/core` is the source of truth for the load-bearing set.

## Backend stack (`apps/api`)

| Layer | Component | Notes |
|---|---|---|
| Web framework | FastAPI ≥ 0.115 | typed endpoints + `/docs`; binds `127.0.0.1:8000` |
| ASGI server | Uvicorn ≥ 0.32 (`[standard]`) | single process, no reload in normal run |
| Uploads | python-multipart ≥ 0.0.12 | multipart file upload on `POST /jobs` |
| Live progress | [sse-starlette](https://github.com/sysid/sse-starlette) ≥ 2.1 | Server-Sent Events on `GET /jobs/{id}/events` |
| Job execution | stdlib `concurrent.futures.ThreadPoolExecutor(max_workers=1)` | in-process worker + in-memory registry dict; **no broker** |

Rationale (in-process jobs + SSE, no Celery/Redis/WebSocket) →
[`adr/0008-fastapi-inprocess-jobs-sse.md`](adr/0008-fastapi-inprocess-jobs-sse.md).
Import-not-subprocess (API imports `stt_core` directly) →
[`adr/0007-shared-core-import-not-subprocess.md`](adr/0007-shared-core-import-not-subprocess.md).

The API logging config surfaces our job/note lifecycle `INFO` lines and quiets a
known set of benign third-party warnings (torch `weights_only`, `TRANSFORMERS_CACHE`
deprecation, pyannote/torch version mismatch, and noisy loggers) that otherwise
fire on every job. `STT_LOG_LEVEL=DEBUG` shows everything; `STT_QUIET_DEPS=0` keeps
the third-party noise. (The same pyannote/torch version-warning noise is muted in
`stt_core`.)

## Clinical note stack (`packages/note-core`)

A pure package that parallels `stt_core`: `generate(transcript, opts, progress)
-> NoteResult`, streaming token deltas through a callback. The AI backend is
**pluggable** behind a small provider protocol (`stream(system, user, opts,
result)`). → [`adr/0009-clinical-note-pluggable-provider.md`](adr/0009-clinical-note-pluggable-provider.md)
(plus the plugin-seam decision, planned as ADR-0011)

| Layer | Component | Notes |
|---|---|---|
| Local provider (**default**) | [Ollama](https://ollama.com) via `POST http://localhost:11434/api/chat` (plain HTTP, streamed) | fully offline; transcript never leaves the Mac. Default model **`qwen2.5:32b-instruct`** |
| Cloud provider (**opt-in**) | Anthropic SDK (`anthropic`), model `claude-opus-4-8` | optional extra: `uv sync --extra claude`; gated behind `STT_NOTE_PROVIDER=claude` + a server-env token |
| Local-only plugin (**machine-specific**) | `ClaudeCliProvider` (Opus 4.8 via the authenticated `claude` CLI) | GIT-IGNORED `_local_providers.py`; enabled via `STT_NOTE_PROVIDERS`; self-hides unless `claude` is on PATH — see the plugin seam below |
| Prompt/templates | `prompt.py` (verbatim **Turkish** clinical-documentation prompt) + `templates.py` | templates: `soap`, `hp`, plus a free-text paste — all Turkish |

### Provider plugin seam (`STT_NOTE_PROVIDERS`)

The committed repo offers exactly one provider — local Ollama — but note
generation is pluggable so a deployment can add extra providers **without
touching committed code**. → planned ADR-0011 (note-provider plugin seam)

- `providers.list_providers()` returns UI descriptors (`{key, label, models,
  default_model, off_device}`), filtered by an operator **allowlist** and each
  provider's own availability. `_provider_allowlist()` reads `STT_NOTE_PROVIDERS`
  (comma list, **default `ollama`**), so a non-default/off-device provider must be
  turned on deliberately. `get_provider()` resolves the built-ins first and the
  local plugin **last**.
- `_local_registry()` optionally imports a `_local_providers` module sitting next
  to `providers.py` and merges its `PROVIDERS` (factories) + `DESCRIPTORS`. A
  missing or broken plugin never breaks the app (the loader swallows import
  errors). Each descriptor carries an `available()` predicate so a provider that
  can't run on this machine never appears in the list.
- The API surfaces this at `GET /notes/providers` (`{providers, default_provider}`);
  `POST /notes` validates the requested `provider` against `list_providers()` and
  fills `model` from the descriptor's `default_model`. The web NoteGenerator shows
  a **"Sağlayıcı"** (+ "Model") selector, hidden when only one provider exists;
  `off_device` drives the PHI warning.

**The optional Claude-CLI local provider.** This machine ships a git-ignored
`_local_providers.py` whose `ClaudeCliProvider` runs **Opus 4.8** by shelling out
to the locally-authenticated `claude` CLI. It exists because this box runs Claude
Code on **Amazon Bedrock** — there is no `ANTHROPIC_API_KEY`, so the first-party
Anthropic SDK path (`ClaudeProvider`) can't authenticate, but the CLI carries its
own credentials. It streams `--output-format stream-json --include-partial-messages`
token deltas, runs in a neutral temp cwd with tools disallowed (so it doesn't
inherit this repo's context), and self-hides unless `claude` is on PATH. It is
`off_device` (transcript goes to the model via Bedrock), so the UI shows the PHI
warning. **None of this is committed** — `_local_providers.py`, `env.local.sh`,
and `README.local.md` are all git-ignored, keeping machine-specific integrations
out of version control and the default repo local-only.

**Default local model — `qwen2.5:32b-instruct`** (~20 GB, Q4): the strongest
practical model on a 48 GB M4 Pro — it fits unified memory alongside a large
context window, whereas a 72B would exceed Metal's allocation ceiling. **`num_ctx`
defaults to 16384** (`STT_NOTE_NUM_CTX`) because transcript + prompt are long and
Ollama silently truncates input past the (small) default context.

**Ollama setup + cleanup.** Install with `brew install ollama`; `env.sh` sets
`OLLAMA_MODELS="$PROJECT_ROOT/models/ollama"` (and `OLLAMA_HOST`), so the ~20 GB
model blobs land inside the project and `rm -rf` still removes them (ADR-0003).
Start the server in a shell that sourced `env.sh` (`ollama serve`) then
`ollama pull qwen2.5:32b-instruct`. **Honest caveat:** Ollama still creates a tiny
(~12 KB) ssh-style identity keypair and an empty cache dir under `~/.ollama`
regardless of `OLLAMA_MODELS` — negligible, and not a model download; the cleanup
promise is about the multi-GB blobs, which do go into the project.

Provider/model defaults are read from env (`STT_NOTE_PROVIDER` default `ollama`,
`STT_NOTE_MODEL` default `qwen2.5:32b-instruct`), set by `env.sh`. The set of
providers the UI may offer is a separate knob — `STT_NOTE_PROVIDERS` (comma list,
default `ollama`) — read by `list_providers()` (see the plugin seam above). `env.sh`
sources an optional git-ignored `env.local.sh` **last**, which is where a machine
sets `STT_NOTE_PROVIDERS` (e.g. `ollama,claude-cli`) and any local-only vars — so
the committed default config exposes only the local model.

### Timing metrics

Both stages report wall-clock durations, surfaced end-to-end:

- `stt_core` records `TranscribeResult.transcribe_seconds`; the API worker sets it
  before writing files, and `emit.write_json` persists it into `out/<stem>.json`
  (so it survives transcript reuse). `NoteJob` records `note_seconds`.
- `Job`/`NoteJob` carry `created_at` (ISO-8601, at registration) + `started_at`
  (epoch seconds, at `_run` start). `SavedNote`/the SQLite store gain
  `transcribe_seconds` + `note_seconds` columns (added to a pre-existing DB by an
  in-place `ALTER TABLE` migration).
- The API returns these on `GET /jobs/{id}`, `GET /notes/{id}`, `GET /transcripts[...]`,
  and the `/notes` list; `POST /notes` accepts `transcribe_seconds` (carried from
  the chosen transcript). The web shows **"Deşifre: Xs" / "Not: Ys"** chips, a model
  chip, and a **live elapsed timer** (`useElapsed` hook) anchored to the server's
  `started_at` so it shows true elapsed time after a page refresh.

### Sessions / persistence model (and its scope)

Job state is **in-memory**, living with the server process (`JobManager` /
`NoteJobManager` registries + a single worker thread each — no broker; ADR-0007/0008).
On top of that:

- `list_active()` exposes queued/running/failed jobs for the sidebar; `retry()`
  re-runs a failed transcription (from the SAME uploaded file still on disk) or
  note (same transcript + options) — surfaced at `GET /jobs`, `GET /notes/active`,
  `POST /jobs\|notes/{id}/retry`.
- The web `NotesSidebar` ("Oturumlar") polls the active lists every 3s; `utils/session.ts`
  persists the current screen to `localStorage` and `App.tsx` rehydrates on load
  (re-attaches SSE / re-fetches the finished result), so an in-progress job is
  returnable after a page refresh.
- **Scope caveat:** this durability is client-side re-attachment to a *still-running*
  server. The job registry itself is not persisted — a **`make api` restart drops
  all in-flight jobs** (only completed notes survive, in the SQLite store). Durable
  history is limited to finished notes.

**`make api` vs `make api-dev` (env-sourcing + no-reload).** `make api` runs the
server with **no `--reload`** on purpose: a reload restarts the process and orphans
any in-flight job — its SSE stream dies with no `done` event ("stuck at done") and
the in-memory registry is wiped. `make api-dev` enables reload but **scopes it to
the source dirs only** (`apps/api/src` + `packages`) — never `.venv`, `models/`, or
`jobs/` — so a model load or job-output write doesn't trigger a restart. Both
recipes `source env.sh` inside the recipe (a single `&&` chain, since each make
line is its own shell) so the server always has `HF_TOKEN`, the in-project cache
redirects, and `STT_NOTE_PROVIDERS` (without which the provider selector would
silently disappear).

## Frontend stack (`apps/web`)

| Layer | Component | Notes |
|---|---|---|
| Build/dev | Vite | dev server on `http://localhost:5173`; CORS-allowed by the API in dev |
| Framework | React + TypeScript | upload → live progress → transcript viewer → (optional) note generator/viewer |
| UI kit | MUI (Material UI) | components + theming |

Separate `package.json` / `npm install` / `npm run dev` — it does **not** use
`env.sh` and is **not** part of the uv workspace.

## Load-bearing constraints (do not break these)

1. **CPU-only.** CTranslate2 has no Metal/MPS backend on Mac, so `--device` must
   stay `cpu`. → [`adr/0001-cpu-only.md`](adr/0001-cpu-only.md)
2. **The version pins are a coherent, hand-verified set** (now in
   [`packages/core/pyproject.toml`](../packages/core/pyproject.toml)). WhisperX
   3.4.2 only declares loose lower bounds, so a naive install pulls bleeding-edge
   torch/pyannote/transformers that break it (observed failures: pyannote 4.x
   API change, `torchaudio.AudioMetaData` removal, missing `omegaconf`/`matplotlib`).
   Change pins only deliberately and re-run the verify gate.
   → [`adr/0002-load-bearing-version-pins.md`](adr/0002-load-bearing-version-pins.md)
3. **All downloads stay inside the project.** `env.sh` sets `HF_HOME`,
   `HUGGINGFACE_HUB_CACHE`, `TRANSFORMERS_CACHE`, `TORCH_HOME`, `PYANNOTE_CACHE`,
   `XDG_CACHE_HOME`, `PIP_CACHE_DIR`, `MPLCONFIGDIR`, `NUMBA_CACHE_DIR` into
   `models/` and `.pip-cache/`. Never introduce a download path outside the repo.
   → [`adr/0003-self-contained-caches.md`](adr/0003-self-contained-caches.md)

## Secrets

- `HF_TOKEN` is read from the untracked `.hf_token` file by `env.sh` (chmod 600).
  Needed for pyannote model access. Never hardcode it or print it.
- The cloud note token (`STT_CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`) is read
  **only** from server env, used only when `STT_NOTE_PROVIDER=claude`, and is
  never accepted from the browser, logged, or returned. → ADR-0009.
- The local Claude-CLI provider holds **no token in this repo**: it relies on the
  `claude` CLI's own ambient (Bedrock) credentials. Provider error messages never
  contain a secret. Machine-specific enablement (`env.local.sh`) is git-ignored.

## First-run footprint

First run downloads a few GB of models into `models/` (Whisper `large-v3`
~3 GB, alignment model per language ~360 MB, pyannote components ~tens of MB).
Subsequent runs are fast (models cached locally).

## Performance (measured, M4 Pro, warm run, 60 s audio)

| Model | Transcribe | Full pipeline | ~Realtime |
|---|---|---|---|
| `large-v3` (default) | ~32 s | ~51 s | ~0.8× |
| `small` | ~8 s | ~20 s | ~3× |

Diarization adds ~9 s. Speed lever is `--model small`/`medium`. Accuracy-over-speed
is the intended default (see [`product.md`](product.md)).
