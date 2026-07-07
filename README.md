# Speech-to-Text + Speaker Diarization (Prototype)

Transcribes audio **and** labels who spoke each part (`Speaker 1:`, `Speaker 2:`, …),
using open-source models running locally on this Mac (Apple Silicon, CPU).
Language is **auto-detected** by default and works for any language Whisper
supports (override with `--language`).

**Stack:** [WhisperX](https://github.com/m-bain/whisperX) →
faster-whisper `large-v3` (ASR) → forced alignment (word timestamps) →
[pyannote](https://github.com/pyannote/pyannote-audio) diarization →
word→speaker fusion.

> **Working on the code (human or AI agent)?** Start with [`AGENTS.md`](AGENTS.md)
> and the [`specs/`](specs/) directory — this project is spec-driven: behavior is
> defined in `specs/requirements.md` (EARS), architecture in `specs/design.md`,
> and design decisions in `specs/adr/`.

---

## Fully self-contained (easy cleanup)

Everything this prototype downloads — Python packages, Whisper/pyannote/aligner
models, and all caches — is redirected **inside this folder** by `env.sh`
(via `HF_HOME`, `TORCH_HOME`, `PYANNOTE_CACHE`, `PIP_CACHE_DIR`, etc.).
Nothing leaks into `~/.cache` or `~/Library`.

**To delete everything we downloaded, just delete this folder:**

```bash
rm -rf /Users/ybatu/workspace/stt-diarization-prototype
```

Run `bash cleanup.sh` first if you want to see sizes and the (optional) command
to also remove the shared Homebrew tools (`ffmpeg`, `python@3.11`).

---

## Usage

```bash
cd /Users/ybatu/workspace/stt-diarization-prototype
source env.sh                      # activates venv, sets HF_TOKEN, redirects caches

# Just point it at a file — no flags needed:
python transcribe.py /path/to/meeting.m4a
```

That's it. By default the tool auto-detects the language, auto-detects the number
of speakers, and **automatically levels the audio** so a quiet/far speaker isn't
lost next to a loud/close one. It favors accuracy over speed. A live progress bar
shows transcription progress. Outputs land in `out/` (named after the input file):

**Accepted inputs:** any audio (`.wav`, `.mp3`, `.m4a`, `.flac`, …) **or video**
(`.mp4`, `.mov`, `.mkv`, `.webm`, …). For video, the audio track is extracted
automatically — you don't need to convert it first.

| File | Contents |
|------|----------|
| `<name>.txt`  | Human-readable labeled transcript |
| `<name>.srt`  | Subtitles with speaker labels |
| `<name>.json` | Full structured result (turns, segments, words, speaker map) |

### Optional flags (you usually don't need any)

Everything below has a sensible default. Reach for these only to tune a specific case.

| Flag | Default | Purpose |
|------|---------|---------|
| `--min-speakers` / `--max-speakers` | auto | Bound the speaker count when you know it — improves accuracy. |
| `--language` | auto-detect | Force a language, e.g. `--language en` or `--language tr`. |
| `--model` | `large-v3` | Whisper size. Use `medium`/`small` for a faster, lower-accuracy run. |
| `--no-enhance` | (enhance on) | Turn OFF the default audio leveling (rarely needed). |
| `--vad-onset` | 0.35 | Lower (~0.25) to catch even quieter speech; raise to reduce false detections. |
| `--no-diarize` | off | Transcript only, no speaker labels (skips pyannote / HF token). |
| `--compute-type` | `int8` | `int8` (fast, CPU) or `float32` (slightly better, slower). |

### Uneven microphone distance (handled by default)

If one person is close to the mic and another is far, the quiet speaker's words
would normally get skipped and their speaker label confused. The tool now levels
the audio automatically (compression + loudness normalization) before
transcription, so this works out of the box. In testing on a clip where the
quiet speaker was ~30 dB lower, this recovered lines that were otherwise dropped
entirely. If a very quiet speaker is still missed, add `--vad-onset 0.25`. The
best long-term fix is still a better recording (a mic per speaker, or equal
distances).

---

## First-run notes

- The **first** run downloads a few GB of models into `models/`. Later runs are fast.
- Runs on **CPU** — CTranslate2 (faster-whisper's backend) has no Apple-GPU
  support. On an M4 Pro a few minutes of audio transcribes in well under real time.
- Diarization needs a Hugging Face token (already saved in `.hf_token`, loaded by
  `env.sh`). The pipeline first tries `pyannote/speaker-diarization-3.1` and
  automatically falls back to building the diarizer from its component models
  (`segmentation-3.0` + `wespeaker`) if that meta-model's terms aren't accepted.
- Word-level alignment is applied when an aligner exists for the detected
  language; otherwise speakers are assigned at the segment level.

## Requirements recreated from scratch

```bash
brew install ffmpeg python@3.11
/opt/homebrew/opt/python@3.11/bin/python3.11 -m venv .venv
source env.sh
pip install -r requirements.txt
```
