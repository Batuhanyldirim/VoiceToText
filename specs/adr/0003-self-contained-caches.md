# ADR-0003 — Self-contained caches (one-command cleanup)

**Status:** Accepted · **Relates to:** REQ-080, `env.sh`, `cleanup.sh`, `tech.md`

## Context

The requirement is that the user can remove **everything** this prototype
downloaded by deleting the project folder — no residue in `~/.cache`,
`~/Library`, or a global Hugging Face cache. By default, the ML libraries scatter
multi-GB downloads across several home-directory locations, and some (pyannote)
use their own cache dir that ignores `TORCH_HOME`.

## Decision

`env.sh` redirects **every** relevant cache into the project before anything
runs, by exporting:

- `HF_HOME`, `HUGGINGFACE_HUB_CACHE`, `TRANSFORMERS_CACHE` → `models/hf/…`
- `TORCH_HOME` → `models/torch`
- `PYANNOTE_CACHE` → `models/pyannote` *(pyannote ignores TORCH_HOME — needs its own var)*
- `XDG_CACHE_HOME` → `models/xdg` (catch-all)
- `MPLCONFIGDIR` → `models/mpl`, `NUMBA_CACHE_DIR` → `models/numba`
- `PIP_CACHE_DIR` → `.pip-cache`

`cleanup.sh` reports the footprint and the removal command.

## Decision rationale for cleanup

```bash
rm -rf /Users/ybatu/workspace/stt-diarization-prototype
```

removes the venv, all models, and all caches. Shared Homebrew tools (`ffmpeg`,
`python@3.11`) are intentionally **not** removed by this (they may be used by
other things); `cleanup.sh` prints the optional `brew uninstall` command.

## Consequences

- ✅ True one-command cleanup; nothing leaks (verified — no `~/.cache/huggingface`,
  `~/.cache/torch/pyannote`, or `~/Library` residue after a full run).
- ➖ Models aren't shared with other projects, so they re-download if you clone
  the tool elsewhere. Acceptable for a self-contained prototype.
- ⚠️ **Any new download path must be redirected into the project.** If you add a
  library that caches models, add its cache env var to `env.sh` and confirm with
  a post-run check that nothing new appeared under `~`.
