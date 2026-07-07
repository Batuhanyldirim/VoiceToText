# ADR-0006 — Monorepo via uv workspace + separate npm web app

**Status:** Accepted · **Relates to:** `tech.md`, `structure.md`, root `pyproject.toml`

## Context

The prototype outgrew a single `transcribe.py`: we now have a shared pipeline
plus a CLI, a FastAPI backend, and a React frontend. These need to live together,
share the pipeline code, and stay installable/reproducible on one Mac — without
adding a heavy build system for what is still a one-developer prototype.

Options considered for the Python side: separate repos (friction: version skew,
manual re-installs), a flat single package (mixes CLI/API/pipeline deps), or a
workspace. For the whole monorepo: Nx / Turborepo / pnpm workspaces would unify
JS + Python task running but add config, daemons, and concepts far beyond three
Python packages and one web app.

## Decision

Use a **uv workspace** for the three Python packages and keep the **frontend a
separate plain npm project**.

- Root `pyproject.toml`: `[tool.uv.workspace] members = ["packages/*",
  "apps/cli", "apps/api"]`, one `uv.lock`.
- `stt-cli` and `stt-api` depend on `stt-core` via `[tool.uv.sources] stt-core =
  { workspace = true }` — **editable** interdependency, so importing `stt_core`
  picks up local edits with no rebuild.
- One shared `.venv/`; install everything with `uv sync --all-packages` (pass
  `--python /opt/homebrew/opt/python@3.11/bin/python3.11` on the first run).
- `apps/web` has its own `package.json` and `npm install` / `npm run dev`; it is
  **not** a uv workspace member and does **not** use pnpm.

## Consequences

- ✅ Simplest tool that's adequate: one lockfile, one venv, editable core shared
  by CLI and API; the frontend uses the standard Vite/npm flow its ecosystem
  expects.
- ✅ `env.sh` (venv + `HF_TOKEN` + cache redirection) still governs all Python
  work unchanged; the pins stay centralized in `packages/core` (ADR-0002).
- ➖ Two package managers (uv + npm) and no single "build everything" command —
  acceptable given the Python/JS split is a hard boundary anyway.
- ⚠️ **Do not** fold the web app into the uv workspace or introduce
  Nx/Turborepo/pnpm without a real driver (e.g. many JS packages). New Python
  packages go under `packages/*` or `apps/*` and are added to the workspace
  `members`.
