# Tech — `stt-diarization-prototype`

*Steering doc: the stack and the load-bearing constraints. Read alongside
[`product.md`](product.md) and [`structure.md`](structure.md).*

## Platform

- **macOS on Apple Silicon** (developed on an M4 Pro). CPU-only inference.
- **Python 3.11** in a project-local venv (`.venv/`). System Python (3.9) is too
  old for the ML stack — do not use it.
- **ffmpeg** (Homebrew) — required for audio decoding, video-track extraction,
  and the enhancement filter chain.

## Stack

| Layer | Component | Notes |
|---|---|---|
| Orchestration | [WhisperX](https://github.com/m-bain/whisperX) 3.4.2 | ties ASR + alignment + diarization together |
| ASR | faster-whisper 1.2.1 (CTranslate2 4.4.0) | model `large-v3` by default; CPU int8 |
| Alignment | wav2vec2 forced-alignment (via WhisperX) | per-language; auto-selected |
| Diarization | pyannote-audio 3.3.2 | `speaker-diarization-3.1`, or component fallback |
| Tensor runtime | torch 2.5.1 / torchaudio 2.5.1 | CPU wheels |
| Misc | transformers 4.48.0, omegaconf, matplotlib, tqdm | see `requirements.txt` |

The authoritative, commented pin list is [`requirements.txt`](../requirements.txt).

## Load-bearing constraints (do not break these)

1. **CPU-only.** CTranslate2 has no Metal/MPS backend on Mac, so `--device` must
   stay `cpu`. → [`adr/0001-cpu-only.md`](adr/0001-cpu-only.md)
2. **The version pins are a coherent, hand-verified set.** WhisperX 3.4.2 only
   declares loose lower bounds, so a naive install pulls bleeding-edge
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
