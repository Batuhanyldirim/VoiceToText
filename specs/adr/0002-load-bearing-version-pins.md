# ADR-0002 — Version pins are load-bearing

**Status:** Accepted · **Relates to:** `requirements.txt`, `tech.md`

## Context

WhisperX 3.4.2 declares only loose lower-bound dependencies (e.g.
`pyannote-audio>=3.3.2`, no upper bounds). A naive `pip install whisperx` on a
fresh environment therefore resolves to bleeding-edge transitive deps that break
its integration code. Concretely, during setup we hit — in sequence — these
failures from unpinned installs:

- `ctranslate2` 4.5.x conflicted with WhisperX's `<4.5.0` constraint.
- pyannote-audio **4.x** changed the API (`Inference(use_auth_token=…)` removed),
  crashing WhisperX's VAD loader.
- torch/**torchaudio 2.11** removed `torchaudio.AudioMetaData`, which pyannote
  3.x imports.
- `omegaconf` and `matplotlib` are imported by pyannote 3.3.2 but were not always
  pulled in automatically.

## Decision

Pin a **coherent, hand-verified set** that WhisperX 3.4.2 actually works with:

```
whisperx==3.4.2
torch==2.5.1
torchaudio==2.5.1
transformers==4.48.0
pyannote-audio==3.3.2
ctranslate2==4.4.0
omegaconf>=2.3.0
matplotlib>=3.7.0
tqdm>=4.66.0
```

Each pin carries an explanatory comment in `requirements.txt`.

## Consequences

- ✅ Reproducible, working install on macOS arm64 / Python 3.11.
- ➖ Not the newest models/APIs; upgrades require deliberate, tested work.
- ⚠️ **Do not bump these casually.** To upgrade: change one layer, reinstall, and
  re-run the verification gate (`bash make_sample.sh && python transcribe.py
  samples/conversation.wav`). If it breaks, revert. Treat any green-field
  "upgrade everything" as a project with its own task plan.
