# ADR-0007 — Shared `stt_core`; CLI and API import it (not subprocess)

**Status:** Accepted · **Relates to:** `structure.md`, `design.md`, ADR-0006, ADR-0008

## Context

The original `transcribe.py` mixed everything in one `main()`: argument parsing,
the enhance→ASR→align→diarize→fuse pipeline, progress printing, and file writing.
Adding a web backend created two consumers of the same pipeline. Two ways to give
the API access to it:

1. **Shell out** — the API runs the CLI as a subprocess and parses its output
   files.
2. **Import** — extract the pipeline into a library both the CLI and API import
   and call in-process.

Subprocessing looks simple but re-loads the multi-GB models on every run, only
exposes progress as scraped stdout, and turns errors into exit codes + text to
re-parse.

## Decision

Extract the pipeline into **`stt_core`** (`packages/core`). `main()`'s pipeline
body becomes:

```python
transcribe(input_path, opts: TranscribeOptions,
           progress: Callable[[ProgressEvent], None]) -> TranscribeResult
```

`stt_core.transcribe()` is **pure**: it does **not** print and does **not** write
files. It surfaces progress through a structured `ProgressEvent` callback and
returns a typed `TranscribeResult`; it raises typed exceptions (e.g.
`MissingTokenError`). Callers decide presentation and persistence:

- **CLI** (`apps/cli`) wires the callback to a tqdm bar and calls `emit.*` to
  write `out/<stem>.{txt,srt,json}`.
- **API** (`apps/api`) wires the callback to an `asyncio.Queue` → SSE and calls
  `emit.*` to write into the job dir.

Both **import `stt_core` and call `transcribe(...)` directly** — neither shells
out to the CLI. Heavy ML imports stay lazy inside `stt_core` functions (ADR
carried over from the single-file design), so `--help` and API startup are cheap.

## Consequences

- ✅ **Warm models** — the API loads models once and reuses them across jobs
  instead of paying subprocess cold-start each time.
- ✅ **Structured progress** — the same `ProgressEvent` stream feeds the CLI's bar
  and the API's SSE, instead of scraping another process's stdout.
- ✅ **Typed results/exceptions** — callers branch on `TranscribeResult` fields and
  `MissingTokenError`, not exit codes and log lines.
- ✅ One place to change pipeline behavior; CLI and API pick it up automatically.
- ➖ Requires the discipline that `stt_core` stays pure (no prints/writes) and
  CLI/API stay thin. Enforced by convention (see `AGENTS.md`).
- ⚠️ **Do not** make the API call the `transcribe` CLI, and **do not** move
  printing/file-writing into `stt_core`. That reintroduces the coupling this ADR
  removed.
