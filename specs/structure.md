# Structure — `stt-diarization-prototype`

*Steering doc: the file map and the pipeline, so an agent knows where a change
goes. Read alongside [`design.md`](design.md).*

## Monorepo map

A **uv workspace** ties four Python packages together with one `uv.lock` and
editable interdependencies. The web app is a **separate npm project** (not in the
workspace). → [`adr/0006-monorepo-uv-workspace.md`](adr/0006-monorepo-uv-workspace.md)

```
stt-diarization-prototype/
├── pyproject.toml       # uv workspace root: members = packages/*, apps/cli, apps/api
├── uv.lock              # ONE lockfile for all Python packages
├── Makefile             # dev targets: setup / api / api-dev / web / cli / sample / verify / clean
├── env.sh               # source this first: venv + HF_TOKEN + cache redirection + Ollama/note-provider env; sources env.local.sh last
├── env.local.sh         # OPTIONAL machine-local env (STT_NOTE_PROVIDERS + local-only vars) — GIT-IGNORED
├── make_sample.sh       # generates samples/conversation.wav (2-speaker fixture)
├── cleanup.sh           # reports footprint + how to fully remove the project
├── requirements.txt     # legacy pin list (authoritative pins now in packages/core)
├── README.md            # human-facing usage (CLI + web quickstart)
├── README.local.md      # how to enable the machine-local Opus/Claude-CLI provider — GIT-IGNORED
├── AGENTS.md            # agent entry point (CLAUDE.md is a symlink to it)
├── specs/               # this spec suite (product/tech/structure/requirements/design/adr/tasks)
│
├── packages/
│   ├── core/            # stt-core: the shared pipeline library (HOLDS THE VERSION PINS)
│   │   ├── pyproject.toml           # load-bearing pins (ADR-0002)
│   │   └── src/stt_core/
│   │       ├── __init__.py          # public API: transcribe, TranscribeOptions, TranscribeResult, …
│   │       ├── pipeline.py          # transcribe(): enhance→ASR→align→diarize→fuse orchestration
│   │       ├── audio.py             # enhance_audio(): ffmpeg leveling chain
│   │       ├── diarize.py           # load_diarizer() + component-pipeline fallback + diarize_dataframe()
│   │       ├── fuse.py              # assign_speakers_segment_level(), build_turns(), speaker_name()
│   │       ├── emit.py              # write_txt/srt/json + transcript_lines/fmt_ts (pure formatting, no stdout)
│   │       ├── progress.py          # ProgressEvent, STAGES, capture_transcribe_progress()
│   │       └── models.py            # TranscribeOptions, Turn, TranscribeResult dataclasses
│   └── note-core/       # note-core: pure clinical-note generation (parallels stt_core) (ADR-0009)
│       ├── pyproject.toml           # optional [claude] extra pulls the Anthropic SDK (uv sync --extra claude)
│       └── src/note_core/
│           ├── __init__.py          # public API: generate, NoteOptions, NoteResult, NoteEvent, STAGES, TEMPLATE_CHOICES, ProviderError, EmptyTranscriptError, list_providers
│           ├── generate.py          # generate(transcript, opts, progress): build prompt → provider → stream deltas
│           ├── providers.py         # provider protocol + OllamaProvider (default, local) + ClaudeProvider (opt-in cloud) + plugin seam: list_providers()/_provider_allowlist()/_local_registry(); cloud gating (ADR-0011)
│           ├── _local_providers.py  # OPTIONAL machine-local plugin (ClaudeCliProvider = Opus 4.8 via `claude` CLI) — GIT-IGNORED, self-hiding via available()
│           ├── prompt.py            # the (Turkish) clinical-documentation system prompt (verbatim) + build_user_prompt()
│           ├── templates.py         # TEMPLATE_CHOICES (Turkish soap, hp) + the free-paste option + resolve_template_text()
│           ├── progress.py          # NoteEvent, STAGES (start/generating/done/error), NoteCallback
│           └── models.py            # NoteOptions, NoteResult dataclasses + DEFAULT_* provider/model/num_ctx
│
├── apps/
│   ├── cli/             # stt-cli: thin CLI wrapper (same flags/output as the old transcribe.py)
│   │   ├── pyproject.toml            # [project.scripts] transcribe = stt_cli.main:main
│   │   └── src/stt_cli/main.py       # argparse → TranscribeOptions → transcribe(); tqdm progress; writes out/
│   ├── api/             # stt-api: FastAPI backend
│   │   ├── pyproject.toml            # [project.scripts] stt-api = stt_api.main:run
│   │   ├── src/stt_api/main.py       # FastAPI app + endpoints (jobs, notes, providers, transcripts, history, retry); dep-warning quieting
│   │   ├── src/stt_api/jobs.py       # JobManager: registry dict + ThreadPoolExecutor(1) worker; list_active()/retry(); started_at anchor
│   │   ├── src/stt_api/notes.py      # NoteJobManager: in-memory note job registry + SSE (live lifecycle); list_active()/retry(); timing
│   │   ├── src/stt_api/store.py      # NoteStore/SavedNote: SQLite persistence for completed notes + timing columns (ADR-0010)
│   │   ├── notes.db                  # persisted notes DB — GIT-IGNORED, contains PHI (ADR-0010/0003)
│   │   └── jobs/                     # per-job scratch (uploads + outputs) — GIT-IGNORED (ADR-0003)
│   └── web/             # Vite + React + TS + MUI frontend (separate npm project; another agent owns it)
│       └── src/
│           ├── App.tsx               # screen router; rehydrates the persisted session on load (re-attach SSE / re-fetch result)
│           ├── hooks/useElapsed.ts   # live elapsed-seconds timer, anchored to server started_at (survives refresh)
│           ├── utils/session.ts      # localStorage persistence of the current screen (save/load/clearSession)
│           └── components/NotesSidebar.tsx  # "Oturumlar": active jobs/notes (spinner/retry) + saved-note history; polls every 3s (replaced NotesHistory.tsx)
│
├── samples/             # test audio (conversation.wav + any you add) — git-ignored
├── out/                 # CLI transcripts (<name>.txt/.srt/.json) + <name>.enhanced.wav — git-ignored
├── models/              # ALL downloaded models/caches (incl. models/ollama) — git-ignored, removable
├── .pip-cache/          # pip download cache — git-ignored
├── .venv/               # shared Python 3.11 virtual environment — git-ignored
└── .hf_token            # untracked Hugging Face token (loaded by env.sh)
```

## The pipeline (6 stages) and the module that owns each

All pipeline logic lives in `packages/core/src/stt_core/`, orchestrated by
`pipeline.transcribe()`. Data flows audio → text → words → speakers → turns.
`transcribe()` is **pure**: it does not print and does not write output files.

| # | Stage | Owning module / function | In → out |
|---|---|---|---|
| 1 | **Enhance** (default on) | `audio.enhance_audio()` | input file → leveled `<stem>.enhanced.wav` in the caller's out/scratch dir |
| 2 | **Transcribe** | `pipeline.transcribe()` via `whisperx.load_model` + `.transcribe()`; % via `progress.capture_transcribe_progress()` | audio → `result` (segments + detected language) |
| 3 | **Align** (best-effort) | `pipeline.transcribe()` via `whisperx.load_align_model` + `whisperx.align` | segments → word-level timestamps; sets `aligned` flag |
| 4 | **Diarize** | `diarize.load_diarizer()` → `_wrap_pipeline()` → `diarize_dataframe()` | audio → speaker-segment DataFrame |
| 5 | **Fuse** (words↔speakers) | `whisperx.assign_word_speakers` if aligned, else `fuse.assign_speakers_segment_level()` | result + diar df → segments tagged with `speaker` |
| 6 | **Turns / emit** | `fuse.build_turns()` + `fuse.speaker_name()` build turns; callers call `emit.write_txt/srt/json` + `emit.fmt_ts/fmt_srt_ts` | tagged segments → `TranscribeResult` → `<stem>.txt/.srt/.json` |

Note: `stt_core` builds the `TranscribeResult`; **the CLI and API** call
`emit.*` to persist files. The CLI additionally prints each `.txt` line as it
writes it (REQ-071).

## Who runs the pipeline (the two callers)

| Caller | Entry | How it drives the pipeline | Progress → user |
|---|---|---|---|
| **CLI** (`apps/cli`) | `stt_cli.main:main` (`transcribe` script) | parse argparse → `TranscribeOptions` → `stt_core.transcribe(...)` → `emit.*` writes `out/` | `ProgressEvent` callback → tqdm bar + `[transcribe]` log lines |
| **API** (`apps/api`) | `stt_api.main:app` (uvicorn) | `jobs.JobManager` runs `transcribe(...)` on a `ThreadPoolExecutor(1)`; `emit.*` writes into the job dir | `ProgressEvent` callback → `asyncio.Queue` → SSE (`GET /jobs/{id}/events`) |
| **Web** (`apps/web`) | Vite/React app | calls the API over HTTP (upload → SSE/poll → download) | rendered from SSE stream |

## Clinical note generation (`note_core` + note endpoints/screens)

An optional step *after* transcription, owned by `packages/note-core` and driven
by the same API/web surface. `note_core.generate()` is **pure** (no printing, no
file writes); it streams token deltas through a `NoteEvent` callback. → ADR-0009.

| Module / surface | Owns |
|---|---|
| `note_core/generate.py` | `generate(transcript, opts, progress) -> NoteResult`; builds system+user prompt, selects the provider, streams deltas |
| `note_core/providers.py` | provider protocol; `OllamaProvider` (default, local `POST /api/chat`) + `ClaudeProvider` (opt-in cloud); enforces the `STT_NOTE_PROVIDER=claude` gate. **Plugin seam:** `list_providers()` (allowlist- + availability-filtered descriptors), `_provider_allowlist()` (reads `STT_NOTE_PROVIDERS`, default `ollama`), `_local_registry()` (loads the optional `_local_providers` module); `get_provider()` consults the local registry last (ADR-0011) |
| `note_core/_local_providers.py` | **GIT-IGNORED, machine-local plugin** — `ClaudeCliProvider` (Opus 4.8 by shelling out to the authenticated `claude` CLI on Bedrock); exports `PROVIDERS`/`DESCRIPTORS`; `available()` self-hides it unless `claude` is on PATH. Absent from the committed repo (ADR-0011) |
| `note_core/prompt.py` | the **Turkish** clinical-documentation system prompt (stored verbatim) + `build_user_prompt()`; the chosen template **is** the whole note (no A–E duplication), one appended "Klinik İnceleme Gerekli" section, anti-preamble/banner rules, pedigree only when family history is rich; preserves negations + uncertainty flagging |
| `note_core/templates.py` | `TEMPLATE_CHOICES` — Turkish `soap` ("SOAP notu"), `hp` ("Öykü ve Muayene (Ö&M)"), plus the `free` ("serbest metin") paste option; `resolve_template_text()` |
| `note_core/models.py` | `NoteOptions` (provider, model, template, template_text, temperature, num_ctx, max_tokens), `NoteResult`; `DEFAULT_PROVIDER`/`DEFAULT_OLLAMA_MODEL`/`DEFAULT_CLAUDE_MODEL`/`DEFAULT_NUM_CTX` (read from env) |
| `note_core/progress.py` | `NoteEvent` (stage ∈ start/generating/done/error, `delta`, `message`), `NoteCallback`, `STAGES` |

Persistence (completed notes only) lives in `apps/api/src/stt_api/store.py`, which
is separate from the in-memory `notes.py` registry that owns the live/streaming
lifecycle. → [`adr/0010`](adr/0010-persistent-notes-sqlite.md)

| Module / surface | Owns |
|---|---|
| `stt_api/notes.py` | `NoteJobManager` — in-memory note-job registry + `ThreadPoolExecutor(1)` + SSE queue; **live** generation lifecycle. `list_active()` (queued/running/error rows for the sidebar) + `retry()` (re-run with same transcript+opts); records `started_at`/`created_at` + `note_seconds`/`transcribe_seconds` per job |
| `stt_api/store.py` | `NoteStore` + `SavedNote` — project-local **SQLite** persistence of completed notes (list/get/save/delete); DB at `apps/api/notes.db` (git-ignored; `STT_DB_PATH` override). Carries `transcribe_seconds` + `note_seconds` columns (added by an in-place `ALTER TABLE` migration on an older DB) |

Note + transcript endpoints (API, reuse the `ThreadPoolExecutor(1)` + registry + SSE pattern):

| Method + path | Purpose |
|---|---|
| `GET /notes/templates` | the available templates (Turkish `TEMPLATE_CHOICES` + the free option) + provider/`cloud_enabled` |
| `GET /notes/providers` | providers the UI may offer — `{providers: [{key, label, models, default_model, off_device}], default_provider}`; allowlist- + availability-filtered (ADR-0011); `off_device` drives the PHI warning |
| `POST /notes` | transcript + `NoteOptions` → `{note_id}`; validates `provider` against `list_providers()`, fills `model` from the descriptor `default_model`; accepts `transcribe_seconds`; runs generation on the worker |
| `GET /notes/active` | active (queued/running/error) note generations for the sidebar |
| `POST /notes/{id}/retry` | re-run a failed note with the same transcript + options |
| `GET /notes/{id}` | status poll + final `NoteResult` (poll fallback) + timings (`transcribe_seconds`, `note_seconds`, `started_at`); also serves a **saved** note from the store |
| `GET /notes/{id}/events` | **SSE** stream of token deltas (`stage`, `delta`) |
| `GET /notes` | **history**: saved notes newest-first, summaries only (no bodies) + timings |
| `DELETE /notes/{id}` | delete a saved note from the store |
| `GET /jobs` | active (queued/running/error) transcriptions for the sidebar (`list_active()`) |
| `POST /jobs/{id}/retry` | re-run a failed transcription with the SAME uploaded file still on disk |
| `GET /transcripts` | list existing CLI transcripts under `out/` (`out/*.json`) for **reuse** (with `transcribe_seconds`) |
| `GET /transcripts/{name}` | return a chosen transcript's text (e.g. `HistoryTaking_YA`) + `transcribe_seconds` so a note can be generated without re-uploading |

Note screens (web, Turkish UI, added *after* the transcript viewer):

| Screen | What it does | API used |
|---|---|---|
| **Source picker** | reuse an existing `out/` transcript instead of uploading (dev-cycle speedup) | `GET /transcripts` · `GET /transcripts/{name}` |
| **Template picker** | choose "SOAP notu" / "Öykü ve Muayene (Ö&M)" / paste a serbest-metin sample format | `GET /notes/templates` |
| **NoteGenerator** | submit transcript + template → start generation; shows a "Sağlayıcı" (+ "Model") selector, hidden when only one provider exists; `off_device` drives the PHI warning | `GET /notes/providers` · `POST /notes` |
| **NoteViewer** | live-streamed Turkish note (chosen template + one "Klinik İnceleme Gerekli" section), copy + download `.md`; a live elapsed timer + "Deşifre: Xs" / "Not: Ys" + model chips; off-device warning banner | `GET /notes/{id}/events` (SSE) · `GET /notes/{id}` |
| **NotesSidebar** ("Oturumlar") | active jobs/notes on top (spinner + Turkish stage label, or ⚠ + "Tekrar dene" retry), divider, then saved notes; open / delete / new; polls active every 3s (replaced the old **History** screen) | `GET /jobs` · `GET /notes/active` · `POST /jobs\|notes/{id}/retry` · `GET /notes` · `GET /notes/{id}` · `DELETE /notes/{id}` |

## Where a change typically goes

- **Pipeline behavior** (any stage, defaults, new fusion logic) → `stt_core`
  (the module in the table above). Both CLI and API pick it up automatically.
- **New CLI flag / default** → argparse block in `stt_cli/main.py` **and** the
  matching field in `stt_core.models.TranscribeOptions`.
- **New output format** (e.g. VTT) → add a `write_vtt()` in `stt_core/emit.py`,
  then call it from the CLI (`main.py`) and the API worker (`jobs.py`).
- **Different enhancement** → `stt_core/audio.py` (the ffmpeg filter chain).
- **Different diarization model / hyper-params** → `stt_core/diarize.py`.
- **Speaker label wording** → `SPEAKER_LABEL` constant + `speaker_name()` in `fuse.py`.
- **New / changed API endpoint** → `stt_api/main.py`; job lifecycle → `stt_api/jobs.py`.
- **New progress stage** → `progress.STAGES` + emit a `ProgressEvent` from `pipeline.py`.
- **Note-generation behavior** (prompt, templates, providers) → `note_core`
  (`prompt.py` / `templates.py` / `providers.py`). Both the API note endpoints
  and the web note screens pick it up.
- **New built-in note provider** → add an implementation in `note_core/providers.py`
  behind the provider protocol, and describe it in `list_providers()`; keep the
  cloud gate + secret-from-server-env rule (ADR-0009).
- **Machine-local / non-committed provider** → drop a `_local_providers.py` next to
  `providers.py` exporting `PROVIDERS` + `DESCRIPTORS` (with an `available()`
  predicate), and enable it via `STT_NOTE_PROVIDERS` in `env.local.sh`. Nothing
  machine-specific goes in git (ADR-0011). The API's `GET /notes/providers` and the
  web provider selector pick it up automatically.
- **Note persistence / history** (saved-note schema, list/get/delete) →
  `stt_api/store.py` (`NoteStore`/`SavedNote`); keep the DB project-local +
  git-ignored (ADR-0010). Live/streaming lifecycle stays in `stt_api/notes.py`.
- **Timing metrics** (a new duration to surface) → set it on the job/`SavedNote`
  in `stt_api/jobs.py`/`notes.py`/`store.py` (persist `TranscribeResult.transcribe_seconds`
  in `stt_core/emit.write_json`), return it from the relevant endpoint in `main.py`,
  and render a chip / live timer in the web (`hooks/useElapsed.ts`, anchored to
  `started_at`).
- **Sessions sidebar / refresh-survival** (active list, retry, screen restore) →
  `JobManager`/`NoteJobManager.list_active()`+`retry()` in `stt_api`, the
  `GET /jobs` · `GET /notes/active` · `/retry` endpoints in `main.py`, and the web
  `NotesSidebar.tsx` + `utils/session.ts` (rehydrated by `App.tsx`).

## Key in-memory shapes

- `TranscribeOptions` — all pipeline knobs (`stt_core/models.py`); defaults mirror
  the CLI (REQ-011). `hf_token` is required when `diarize=True`.
- `result` — WhisperX dict: `{"segments": [ {start, end, text, words?, speaker?} ], "language": str}`.
- diarization DataFrame — columns `segment, label, speaker, start, end` (see `diarize_dataframe()`).
- `turns` — display model: `[ {speaker, text, start, end} ]` (see `build_turns()`).
- `TranscribeResult` — the pipeline's return value: `{audio, language, num_speakers,
  speaker_map, turns, segments}`; `to_dict()` is the JSON shape (`<stem>.json` / API result).
- `ProgressEvent` — `{stage, percent?, message?}`; `stage` ∈ `progress.STAGES`
  (`enhance, transcribe, align, diarize, fuse, done`), percent only during `transcribe`.
