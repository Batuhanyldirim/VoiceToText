# ADR-0001 — CPU-only inference

**Status:** Accepted · **Relates to:** REQ-020, `tech.md`

## Context

The tool runs on macOS / Apple Silicon (M4 Pro). Apple GPUs use Metal (MPS), not
CUDA. faster-whisper — the ASR engine WhisperX uses — runs on CTranslate2, which
has **no Metal/MPS backend**. Its GPU support is CUDA-only, which does not exist
on a Mac.

## Decision

Run all inference on **CPU**. The `--device` flag defaults to `cpu` and is not
expected to be changed on this platform. `--compute-type int8` is used for CPU
speed.

## Consequences

- ✅ Works out of the box on the target machine; no driver/toolkit setup.
- ✅ Deterministic, simple deployment.
- ➖ Slower than a CUDA GPU. Measured ~0.8× realtime with `large-v3` (see
  `tech.md`). Accepted tradeoff; `--model small` is the speed lever.
- ⚠️ **Do not** set `--device mps` or `--device cuda` expecting acceleration —
  CTranslate2 will not use them (and CUDA is absent). If Apple-GPU speed ever
  becomes a requirement, that means **replacing the ASR engine** (e.g.
  `mlx-whisper`, which is MPS-native) — a real project, not a flag flip.
