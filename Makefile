# VoiceToText monorepo — dev convenience targets.
# Always run from the repo root. `source env.sh` first for Python targets
# (activates the shared .venv + HF_TOKEN + in-project caches).

PY := /opt/homebrew/opt/python@3.11/bin/python3.11

.PHONY: help setup api web cli sample verify clean

help:
	@echo "Targets:"
	@echo "  make setup    - uv sync all Python packages + npm install web"
	@echo "  make api      - run the FastAPI backend on 127.0.0.1:8000 (source env.sh first)"
	@echo "  make web      - run the Vite dev server on :5173"
	@echo "  make cli f=... - transcribe a file via the CLI (e.g. make cli f=meeting.mp4)"
	@echo "  make sample   - generate samples/conversation.wav"
	@echo "  make verify   - run the CLI on the sample and check >=2 speakers"
	@echo "  make clean    - see cleanup.sh (rm -rf the repo removes everything)"

setup:
	uv sync --all-packages --python $(PY)
	cd apps/web && npm install

# Backend. Source env.sh in your shell first so HF_TOKEN + caches are set.
api:
	.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000 --reload

# Frontend dev server (proxies API calls to :8000).
web:
	cd apps/web && npm run dev

# CLI: `make cli f=path/to/file.mp4`
cli:
	transcribe $(f)

sample:
	bash make_sample.sh

verify:
	transcribe samples/conversation.wav --model small
	@grep -c "Speaker" out/conversation.txt >/dev/null && echo "verify: transcript written" || (echo "verify FAILED" && exit 1)

clean:
	bash cleanup.sh
