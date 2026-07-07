# ADR-0009 — Clinical note generation via a pluggable provider (local default, cloud opt-in)

**Status:** Accepted · **Relates to:** REQ-100–REQ-105, `tech.md`, `packages/note-core`, `apps/api`, `apps/web`, ADR-0003, ADR-0007, ADR-0008

## Context

After transcription, the user wants to turn a patient–doctor transcript into a
**structured, clinician-review-ready clinical note** (SOAP, H&P, or a pasted
sample format). The note step is an LLM call: `system` = a clinical-documentation
prompt, `user` = the chosen template + the transcript, streamed back token by
token.

The transcripts are **real / realistic patient recordings (PHI)**. The whole
project's privacy promise is that audio and results never leave the machine
(REQ-097, ADR-0003, API bound to `127.0.0.1`). Sending a transcript to a cloud
LLM API **breaks that promise** unless the operator has explicit authorization
(BAA / de-identified / consented data). So the AI backend cannot be hardwired to
a cloud vendor, and it cannot silently default to one.

At the same time, a strong model materially improves extraction quality, and the
development Mac (M4 Pro, 48 GB unified memory) can run a large local model. A
cloud option (Claude) is still worth having for authorized use — so the provider
must be **pluggable**, not baked in.

## Decision

A **new pure package `note_core`** (`packages/note-core`, parallels `stt_core`):
`generate(transcript, opts, progress) -> NoteResult`. It does **not** print and
does **not** write files; it streams token deltas through a structured
`NoteEvent` callback. The API and web reuse it via **import, not subprocess**
(ADR-0007), and the API drives it on the same `ThreadPoolExecutor(1)` + in-memory
registry + SSE pattern as transcription (ADR-0008), exposing `GET /notes/templates`,
`POST /notes`, `GET /notes/{id}`, and `GET /notes/{id}/events`.

- **Pluggable providers.** A provider protocol with two implementations:
  - **`OllamaProvider` — the DEFAULT, fully local/offline.** Streams from
    `POST http://localhost:11434/api/chat`. The transcript never leaves the Mac.
    Default model **`qwen2.5:32b-instruct`** (~20 GB, Q4) — the strongest
    practical model that fits 48 GB unified memory with a large context window (a
    72B would exceed Metal's allocation ceiling). `num_ctx` defaults to **16384**
    because transcript + prompt are long and Ollama silently truncates otherwise.
  - **`ClaudeProvider` — OPT-IN cloud only.** Uses the Anthropic SDK
    (`claude-opus-4-8`), installed via an optional extra (`uv sync --extra claude`).
- **Cloud is gated at the core.** Requesting `provider="claude"` raises
  `ProviderError` **unless** server env `STT_NOTE_PROVIDER == "claude"`. When
  refused, **no transcript data is sent**. The API/UI never enable the cloud path
  on their own; the operator sets the env flag deliberately.
- **Secrets stay server-side.** The Claude token is read **only** from server env
  (`STT_CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`), never accepted from the browser,
  never logged, never returned. Error messages are user-safe and never contain a
  secret. (Mirrors the `HF_TOKEN` rule in ADR-0008.)
- **The note is a DRAFT for clinician review**, never a finalized record. The
  prompt's five sections (A–E) — including **"Clinician Review Needed"** — are
  preserved, and the UI shows a review-draft framing and (when the cloud provider
  is enabled) a warning banner that the transcript will be sent to Anthropic.
- **Cleanup promise holds (ADR-0003).** `env.sh` sets
  `OLLAMA_MODELS="$PROJECT_ROOT/models/ollama"` so the multi-GB model blobs land
  inside the project and `rm -rf` still removes everything.

## Consequences

- ✅ PHI stays on-device by default — the privacy promise survives the new
  feature; the cloud path is a deliberate, gated exception, not a default.
- ✅ `note_core` stays pure and parallels `stt_core`; the API/web reuse the
  established job + SSE plumbing, so there's little new backend surface.
- ✅ One-command cleanup preserved: local model blobs live under `models/ollama`.
- ➖ **Honest caveat:** Ollama still creates a tiny (~12 KB) ssh-style identity
  keypair and an empty cache dir under `~/.ollama` regardless of `OLLAMA_MODELS`.
  This is negligible and is **not** a model download — the cleanup promise is
  about the multi-GB blobs, which do go into the project.
- ➖ Requires Ollama installed and `ollama serve` running (started in a shell that
  sourced `env.sh` so it honors `OLLAMA_MODELS`); the 32B model is a ~20 GB pull.
- ⚠️ **Do not** default to or hardwire the cloud provider, remove the
  `STT_NOTE_PROVIDER=claude` gate, accept/log/return the cloud token, drop the
  "Clinician Review Needed" section, or let Ollama write models outside
  `OLLAMA_MODELS` without revisiting this ADR.
