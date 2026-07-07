# Structure — `stt-diarization-prototype`

*Steering doc: the file map and the pipeline, so an agent knows where a change
goes. Read alongside [`design.md`](design.md).*

## Monorepo map

A **uv workspace** ties three Python packages together with one `uv.lock` and
editable interdependencies. The web app is a **separate npm project** (not in the
workspace). → [`adr/0006-monorepo-uv-workspace.md`](adr/0006-monorepo-uv-workspace.md)

```
stt-diarization-prototype/
├── pyproject.toml       # uv workspace root: members = packages/*, apps/cli, apps/api
├── uv.lock              # ONE lockfile for all Python packages
├── env.sh               # source this first: venv + HF_TOKEN + cache redirection
├── make_sample.sh       # generates samples/conversation.wav (2-speaker fixture)
├── cleanup.sh           # reports footprint + how to fully remove the project
├── requirements.txt     # legacy pin list (authoritative pins now in packages/core)
├── README.md            # human-facing usage (CLI + web quickstart)
├── AGENTS.md            # agent entry point (CLAUDE.md is a symlink to it)
├── specs/               # this spec suite (product/tech/structure/requirements/design/adr/tasks)
│
├── packages/
│   └── core/            # stt-core: the shared pipeline library (HOLDS THE VERSION PINS)
│       ├── pyproject.toml           # load-bearing pins (ADR-0002)
│       └── src/stt_core/
│           ├── __init__.py          # public API: transcribe, TranscribeOptions, TranscribeResult, …
│           ├── pipeline.py          # transcribe(): enhance→ASR→align→diarize→fuse orchestration
│           ├── audio.py             # enhance_audio(): ffmpeg leveling chain
│           ├── diarize.py           # load_diarizer() + component-pipeline fallback + diarize_dataframe()
│           ├── fuse.py              # assign_speakers_segment_level(), build_turns(), speaker_name()
│           ├── emit.py              # write_txt/srt/json + transcript_lines/fmt_ts (pure formatting, no stdout)
│           ├── progress.py          # ProgressEvent, STAGES, capture_transcribe_progress()
│           └── models.py            # TranscribeOptions, Turn, TranscribeResult dataclasses
│
├── apps/
│   ├── cli/             # stt-cli: thin CLI wrapper (same flags/output as the old transcribe.py)
│   │   ├── pyproject.toml            # [project.scripts] transcribe = stt_cli.main:main
│   │   └── src/stt_cli/main.py       # argparse → TranscribeOptions → transcribe(); tqdm progress; writes out/
│   ├── api/             # stt-api: FastAPI backend
│   │   ├── pyproject.toml            # [project.scripts] stt-api = stt_api.main:run
│   │   ├── src/stt_api/main.py       # FastAPI app + endpoints
│   │   ├── src/stt_api/jobs.py       # JobManager: registry dict + ThreadPoolExecutor(1) worker
│   │   └── jobs/                     # per-job scratch (uploads + outputs) — GIT-IGNORED (ADR-0003)
│   └── web/             # Vite + React + TS + MUI frontend (separate npm project; another agent owns it)
│
├── samples/             # test audio (conversation.wav + any you add) — git-ignored
├── out/                 # CLI transcripts (<name>.txt/.srt/.json) + <name>.enhanced.wav — git-ignored
├── models/              # ALL downloaded models/caches — git-ignored, removable
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
