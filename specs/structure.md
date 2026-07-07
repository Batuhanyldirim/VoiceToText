# Structure — `stt-diarization-prototype`

*Steering doc: the file map and the pipeline, so an agent knows where a change
goes. Read alongside [`design.md`](design.md).*

## File map

```
stt-diarization-prototype/
├── transcribe.py       # ALL logic: the CLI + the full pipeline (single file by design)
├── env.sh              # source this first: venv + HF_TOKEN + cache redirection
├── make_sample.sh      # generates samples/conversation.wav (2-speaker fixture)
├── cleanup.sh          # reports footprint + how to fully remove the project
├── requirements.txt    # pinned, commented dependency set
├── README.md           # human-facing usage
├── AGENTS.md           # agent entry point (CLAUDE.md is a symlink to it)
├── specs/              # this spec suite (product/tech/structure/requirements/design/adr/tasks)
├── samples/            # test audio (conversation.wav + any you add)
├── out/                # generated transcripts (<name>.txt/.srt/.json) + <name>.enhanced.wav
├── models/             # ALL downloaded models/caches (git-ignored, removable)
├── .pip-cache/         # pip download cache
├── .venv/              # Python 3.11 virtual environment
└── .hf_token           # untracked Hugging Face token (loaded by env.sh)
```

## The pipeline (6 stages) and the function that owns each

All in `transcribe.py`, driven by `main()`. Data flows audio → text → words →
speakers → transcript.

| # | Stage | Owning function | In → out |
|---|---|---|---|
| 1 | **Enhance** (default on) | `enhance_audio()` | input file → leveled `out/<stem>.enhanced.wav` |
| 2 | **Transcribe** | `main()` via `whisperx.load_model` + `.transcribe()`; progress via `transcription_progress_bar()` | audio → `result` (segments + detected language) |
| 3 | **Align** (best-effort) | `main()` via `whisperx.load_align_model` + `whisperx.align` | segments → word-level timestamps; sets `aligned` flag |
| 4 | **Diarize** | `load_diarizer()` → `_wrap_pipeline()` → `diarize_dataframe()` | audio → speaker-segment DataFrame |
| 5 | **Fuse** (words↔speakers) | `whisperx.assign_word_speakers` if aligned, else `assign_speakers_segment_level()` | result + diar df → segments tagged with `speaker` |
| 6 | **Emit** | `main()` `emit()` closure; `build_turns()`, `speaker_name()`, `fmt_ts()`, `fmt_srt_ts()` | tagged segments → `out/<stem>.txt/.srt/.json` |

## Where a change typically goes

- **New CLI flag / default** → argparse block near top of `main()`.
- **New output format** (e.g. VTT) → the "Emit" section of `main()` + a helper
  like `fmt_srt_ts()`.
- **Different enhancement** → `enhance_audio()` (the ffmpeg filter chain).
- **Different diarization model / hyper-params** → `load_diarizer()`.
- **Fusion logic** → `assign_speakers_segment_level()` (segment path) or how
  `whisperx.assign_word_speakers` is called (word path).
- **Speaker label wording** → `SPEAKER_LABEL` constant + `speaker_name()`.

## Key in-memory shapes

- `result` — WhisperX dict: `{"segments": [ {start, end, text, words?, speaker?} ], "language": str}`.
- diarization DataFrame — columns `segment, label, speaker, start, end` (see
  `diarize_dataframe()`).
- `turns` — display model: `[ {speaker, text, start, end} ]` (see `build_turns()`).
