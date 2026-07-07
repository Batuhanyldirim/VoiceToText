# VoiceToText monorepo — dev convenience targets.
# Always run from the repo root. `source env.sh` first for Python targets
# (activates the shared .venv + HF_TOKEN + in-project caches).

PY := /opt/homebrew/opt/python@3.11/bin/python3.11

.PHONY: help setup api api-dev web cli sample verify clean

help:
	@echo "Targets:"
	@echo "  make setup    - uv sync all Python packages + npm install web"
	@echo "  make api      - run the FastAPI backend on 127.0.0.1:8000 (source env.sh first)"
	@echo "  make api-dev  - same, WITH auto-reload scoped to source dirs only (for editing code)"
	@echo "  make web      - run the Vite dev server on :5173"
	@echo "  make cli f=... - transcribe a file via the CLI (e.g. make cli f=meeting.mp4)"
	@echo "  make sample   - generate samples/conversation.wav"
	@echo "  make verify   - run the CLI on the sample and check >=2 speakers"
	@echo "  make clean    - see cleanup.sh (rm -rf the repo removes everything)"

setup:
	uv sync --all-packages --python $(PY)
	cd apps/web && npm install

# Backend. Source env.sh in your shell first so HF_TOKEN + caches are set.
# NOTE: NO --reload here on purpose. Jobs live in memory (JobManager + a single
# worker thread); a reload restarts the process and orphans any in-flight job —
# its SSE stream dies with no `done` event ("stuck at done") and the registry is
# wiped, so the next upload can't resolve until you restart. --reload also
# watched the whole repo root (incl. .venv's ~30k files), so an unrelated .py
# touch would silently kill a running transcription. Use `make api-dev` when you
# are editing backend code and want reload.
api:
	.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000

# Backend with auto-reload for active development. Reload is scoped to the
# source dirs ONLY (apps/api + packages) — never .venv, models/, or jobs/ — so
# model loads and job-output writes don't trigger a restart. A restart still
# drops in-flight jobs; that's fine while iterating on code, not during a real run.
api-dev:
	.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000 \
		--reload --reload-dir apps/api/src --reload-dir packages

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
