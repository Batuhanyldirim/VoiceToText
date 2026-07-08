# ADR-0017 — Introduce a pytest suite for the store + API layer

**Status:** Accepted · **Relates to:** ADR-0007, ADR-0010, ADR-0015, ADR-0016, `apps/api/tests/`, `pyproject.toml`, `Makefile` · **Supersedes** the "no unit-test suite" stance in `specs/design.md` (testing strategy) for the non-ML layers only.

## Context

The original testing strategy (design.md) was **"no unit suite — verification is
behavioral"**, on the reasoning that this is a prototype and *the models are the
hard part* (slow, nondeterministic, GB of weights). That held when the app was
essentially an ML pipeline with thin wrappers.

It no longer holds for the whole app. The backend has grown a real, **pure-Python,
deterministic** layer with non-trivial logic and a growing bug surface:
- The SQLite **store**: schema migrations (ADR-0010/0015/0016), the note
  edit/finalize lifecycle (overlay vs. AI original, draft→final lock), patient
  CRUD with name-reuse.
- The **note/patient API endpoints**: status-code contracts (409 on editing a
  final note, 400 on an unknown patient, refile-allowed-when-final), the
  effective-body resolution, filtering.

Recent regressions lived exactly here (a shared-rename confusion; a store branch
that had to become authoritative). We'd been verifying these with throwaway `/tmp`
scripts that were then deleted — the verification effort was real but left no
permanent guard. (Building the suite immediately caught a genuine bug — a test
that polluted the real `notes.db` via module-reload — proving the point.)

## Decision

Add a **pytest suite for the store + API layer**, run fast and offline, and keep
the behavioral gate for the ML pipeline.

- **Scope:** `apps/api/tests/` — `test_store.py` (store logic + migration safety)
  and `test_api.py` (note/patient endpoints via FastAPI `TestClient`). **No ML
  models are imported**, so the whole suite runs in <1 s.
- **Isolation (load-bearing):** tests use a **temp DB** and MUST never touch the
  real `apps/api/notes.db` (it holds PHI — ADR-0010). The `client` fixture imports
  the app once and **rebinds `main.note_store`** to a temp-DB `NoteStore` rather
  than reloading the module (reloading duplicates `store.py`'s classes — e.g. two
  `NoteLockedError` identities — which breaks `pytest.raises`). A fixture assertion
  refuses to run if the store path isn't under the temp dir.
- **Deps + entry points:** `pytest` is a **dev-only** dependency
  (`[dependency-groups].dev`); `[tool.pytest.ini_options].testpaths = apps/api/tests`.
  Run with `make test` (or `uv run --group dev pytest`).
- **Explicitly still out of scope:** the transcription/diarization/streaming
  pipeline (whisperx/pyannote) — too slow and nondeterministic to unit-test; it
  stays under the behavioral gate (`make verify`, the ≥2-speaker sample). Frontend
  (Vitest) tests are deferred — bigger setup, lower payoff right now.

## Consequences

- ✅ The store/API logic — where the recent bugs are — now has a permanent
  regression guard that runs in seconds on every change.
- ✅ Tests are hermetic (temp DB, no network, no models) so they're safe to run
  anywhere, including a fresh clone, without leaking into project data.
- ✅ The behavioral gate is unchanged for the part it's actually good at (the ML
  pipeline).
- ➖ A second testing modality to maintain alongside the behavioral gate; contained
  by keeping the suite focused on the deterministic layer.
- ⚠️ **Do not** point tests at the real DB — always a temp path; **do not** reload
  `stt_api.store`/`main` in fixtures (duplicates classes and breaks `raises`) —
  rebind the singleton instead. **Do not** try to unit-test the ML pipeline here.
