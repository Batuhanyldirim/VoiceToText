# Source this file before running anything:  source env.sh
# It makes the prototype FULLY SELF-CONTAINED: every model, cache, and package
# download lands INSIDE this project folder, so `rm -rf` this folder removes
# 100% of what we downloaded (nothing leaks into ~/.cache or ~/Library).

# Resolve the project root (directory containing this script)
export PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"

# --- Redirect ALL ML model / cache downloads into the project ---
# Hugging Face (Whisper models, pyannote diarization, Turkish aligner) -> models/hf
export HF_HOME="$PROJECT_ROOT/models/hf"
export HUGGINGFACE_HUB_CACHE="$PROJECT_ROOT/models/hf/hub"
export TRANSFORMERS_CACHE="$PROJECT_ROOT/models/hf/transformers"
# PyTorch hub / torch.hub weights -> models/torch
export TORCH_HOME="$PROJECT_ROOT/models/torch"
# pyannote uses its OWN cache dir that ignores TORCH_HOME -> pin it into the project
export PYANNOTE_CACHE="$PROJECT_ROOT/models/pyannote"
export XDG_CACHE_HOME="$PROJECT_ROOT/models/xdg"     # catch-all for stray caches
# pip download cache -> .pip-cache
export PIP_CACHE_DIR="$PROJECT_ROOT/.pip-cache"
# MPLCONFIGDIR / numba caches sometimes used by audio libs
export MPLCONFIGDIR="$PROJECT_ROOT/models/mpl"
export NUMBA_CACHE_DIR="$PROJECT_ROOT/models/numba"
# Ollama (local LLM for clinical note generation) stores models in ~/.ollama by
# default, which would leak outside the project. Redirect it INTO the project so
# `rm -rf` still removes everything (ADR-0003). Start `ollama serve` in a shell
# that has sourced this file so the server honors OLLAMA_MODELS.
export OLLAMA_MODELS="$PROJECT_ROOT/models/ollama"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

# --- Clinical note generation (packages/note-core) ---
# Provider is LOCAL by default so transcripts (PHI) never leave the machine
# (ADR-0009). "claude" is a cloud opt-in the operator sets deliberately; the API
# refuses the cloud path unless this is exactly "claude" AND a token is set.
export STT_NOTE_PROVIDER="${STT_NOTE_PROVIDER:-ollama}"
export STT_NOTE_MODEL="${STT_NOTE_MODEL:-qwen2.5:32b-instruct}"
# Cloud opt-in (only used when STT_NOTE_PROVIDER=claude). Never logged/returned.
#   export STT_NOTE_PROVIDER=claude
#   export STT_CLAUDE_API_KEY=sk-ant-...   # or ANTHROPIC_API_KEY
#   export STT_CLAUDE_MODEL=claude-opus-4-8

# --- Your Hugging Face token (needed for pyannote diarization) ---
# Provide it EITHER way (both are git-ignored / never committed):
#   1. Export it yourself before sourcing:   export HF_TOKEN=hf_xxx
#   2. Put it in an untracked .hf_token file (see .hf_token.example)
# An already-exported HF_TOKEN takes precedence; otherwise we read the file.
if [ -z "$HF_TOKEN" ] && [ -f "$PROJECT_ROOT/.hf_token" ]; then
  export HF_TOKEN="$(tr -d '[:space:]' < "$PROJECT_ROOT/.hf_token")"
fi

# --- Activate the isolated Python 3.11 venv if it exists ---
if [ -f "$PROJECT_ROOT/.venv/bin/activate" ]; then
  source "$PROJECT_ROOT/.venv/bin/activate"
fi

echo "[env] Project root: $PROJECT_ROOT"
echo "[env] HF_HOME=$HF_HOME"
echo "[env] HF_TOKEN set: $([ -n "$HF_TOKEN" ] && echo yes || echo NO)"
echo "[env] venv active: ${VIRTUAL_ENV:-none}"
echo "[env] Note provider: $STT_NOTE_PROVIDER (model: $STT_NOTE_MODEL); OLLAMA_MODELS=$OLLAMA_MODELS"
