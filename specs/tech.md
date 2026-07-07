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

## Clinical note stack (`packages/note-core`)

A pure package that parallels `stt_core`: `generate(transcript, opts, progress)
-> NoteResult`, streaming token deltas through a callback. The AI backend is
**pluggable** with two providers. → [`adr/0009-clinical-note-pluggable-provider.md`](adr/0009-clinical-note-pluggable-provider.md)

| Layer | Component | Notes |
|---|---|---|
| Local provider (**default**) | [Ollama](https://ollama.com) via `POST http://localhost:11434/api/chat` (plain HTTP, streamed) | fully offline; transcript never leaves the Mac. Default model **`qwen2.5:32b-instruct`** |
| Cloud provider (**opt-in**) | Anthropic SDK (`anthropic`), model `claude-opus-4-8` | optional extra: `uv sync --extra claude`; gated behind `STT_NOTE_PROVIDER=claude` + a server-env token |
| Prompt/templates | `prompt.py` (verbatim clinical-documentation prompt) + `templates.py` | templates: `soap`, `hp`, plus a free-text paste |

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
`STT_NOTE_MODEL` default `qwen2.5:32b-instruct`), set by `env.sh`.

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
