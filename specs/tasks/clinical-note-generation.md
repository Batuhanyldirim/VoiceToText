# Task: Clinical note generation (transcript → structured note via pluggable AI)

**Status:** IMPLEMENTED. `packages/note-core` ships the pure `generate(...)` with
the Ollama (default) and Claude (opt-in) providers; the API exposes the note
endpoints and the web app the note screens; docs (ADR-0009, REQ-100–105,
AGENTS/tech/structure/product + per-app READMEs) are updated. This file is
retained as the design record + operational knowledge. Read `AGENTS.md` first,
then this.

### v2: Turkish + reuse + persistence (shipped)

Three additions on top of the original feature (docs: REQ-106–110, ADR-0010, and
the Turkish update to ADR-0009):

- **Turkish by default.** The system prompt, the templates (`soap` = "SOAP notu",
  `hp` = "Öykü ve Muayene (Ö&M)", plus the `free`/serbest-metin paste option), and
  the output section headings A–E are all **Turkish** (E = "Klinik İnceleme
  Gerekli", the review section the UI highlights). The whole web UI is Turkish.
  The behavioral rules (faithful extraction, preserved negations, uncertainty
  flagging, review-draft framing) are unchanged. → REQ-106, ADR-0009 (update).
- **Transcript reuse.** `GET /transcripts` lists `out/*.json` and
  `GET /transcripts/{name}` returns a chosen transcript's text, so a note can be
  generated from an already-transcribed file (e.g. `HistoryTaking_YA`) instead of
  re-uploading — a dev-cycle speedup. → REQ-107.
- **Persistent history.** Completed notes are saved to a project-local SQLite DB
  (`apps/api/notes.db`, `STT_DB_PATH` override, git-ignored — holds PHI) via
  `apps/api/src/stt_api/store.py` (`NoteStore`/`SavedNote`, stdlib `sqlite3`, no
  new dep). New endpoints: `GET /notes` (history list), `GET /notes/{id}` (also
  serves saved notes), `DELETE /notes/{id}`. The web app has a history screen
  (list / open / delete / new). The in-memory `NoteJobManager` still owns the live
  streaming lifecycle; only completed notes are persisted. → REQ-108–110, ADR-0010.

## Goal

After transcription, let the user turn a transcript into a **structured clinical
note** (a patient–doctor conversation → an accurate, clinician-review-ready note).
The AI step is **pluggable**: a **local LLM via Ollama is the default** (keeps PHI
on-device); **Claude API is an opt-in** alternative behind an explicit flag.
Result is rendered in the UI, streamed live, copy/download-able.

## Why local-default is non-negotiable here

The user tests with **real / realistic patient recordings (PHI)**. The whole
project's privacy promise is "audio and results never leave the machine"
(REQ-097, ADR-0003, API bound to 127.0.0.1). Sending a transcript to a cloud API
**breaks that promise**, so:
- **Default = Ollama, fully local/offline.** Transcript never leaves the Mac.
- **Claude = opt-in only** (`STT_NOTE_PROVIDER=claude` + a token). When selected,
  the UI MUST show a clear "⚠️ transcript will be sent to Anthropic — only use
  with authorization (BAA / de-identified / consented data)" banner, and the API
  MUST refuse the cloud path unless the env flag is explicitly set.
- The note is a **draft for clinician review**, never a finalized record — carry
  that framing into the UI (the prompt already says so).

## The AI call (both providers use the SAME shape)

`system` = the clinical-documentation prompt (below).
`user`   = the chosen note template + the transcript.
Stream tokens back → render live. Providers differ only in transport:

- **Ollama (default, local, VERIFIED):**
  `POST http://localhost:11434/api/chat`
  Body: `{"model": "<model>", "messages": [{"role":"system","content":...},{"role":"user","content":...}], "stream": true, "options": {"num_ctx": <large>, "temperature": 0.2}}`
  Streamed chunks: `{"message": {"content": "<piece>"}, "done": false}` … final chunk `{"message":{"content":""}, "done": true, ...stats}`. Set `stream:false` for one-shot.
  **`num_ctx` matters** — transcripts + prompt are long; default context is small. Set it generously (e.g. 8192–16384) or the model silently truncates input.
- **Claude (opt-in):** `client.messages.stream(model="claude-opus-4-8", system=..., messages=[{"role":"user","content":...}], max_tokens=16000)` with adaptive thinking off (or `{"type":"adaptive"}`). Same system/user split. The `claude-api` skill has exact SDK usage; model IDs and params drift — re-load that skill, don't code from memory.

## Model choice (local, on this M4 Pro / 48 GB)

- Default candidate: **`qwen2.5:14b-instruct`** (strong instruction-following for
  structured extraction) or **`llama3.1:8b-instruct`** (lighter/faster). Pick one,
  pull it, verify note quality on a sample transcript. ~5–9 GB download.
- CPU/Metal inference — expect tens of seconds per note; that's fine.

> **Shipped:** the default is **`qwen2.5:32b-instruct`** (~20 GB, Q4) — the
> strongest model that fits 48 GB unified memory with a large `num_ctx` (a 72B
> exceeds Metal's alloc ceiling). `num_ctx` defaults to 16384. See `tech.md`.

## Cleanup promise (ADR-0003) — DO NOT BREAK

Ollama stores models in `~/.ollama` by default, which would leak outside the
project. **Redirect it into the project**: set `OLLAMA_MODELS="$PROJECT_ROOT/models/ollama"`
in `env.sh` (and start the Ollama server with that env set). Verify after a pull
that nothing new landed in `~/.ollama`. `rm -rf` the project folder must still
remove everything.

## Proposed structure (spec-driven)

```
packages/note-core/src/note_core/     # NEW package, parallels stt_core; add to uv workspace members
  ├── prompt.py       # the clinical-documentation system prompt (store verbatim — see below)
  ├── providers.py    # Provider protocol + OllamaProvider (default) + ClaudeProvider (opt-in)
  ├── generate.py     # generate(transcript, template, opts, progress) -> streams note text
  └── models.py       # NoteOptions(provider, model, template, ...), NoteResult
apps/api/…/main.py     # + POST /notes, GET /notes/{id}, GET /notes/{id}/events (SSE token stream)
apps/api/…/jobs.py     # reuse the ThreadPoolExecutor(1) + registry pattern (same as transcription)
apps/web/src/          # + TemplateInput, NoteGenerator, NoteViewer (new screen AFTER transcript viewer)
env.sh                 # + STT_NOTE_PROVIDER=ollama (default), STT_NOTE_MODEL, OLLAMA_MODELS, (STT_CLAUDE_* opt-in)
```

Keep the established conventions: **note-core is pure** (no printing/file writes),
**API stays thin**, **import not subprocess**, **heavy imports lazy**, progress via
a structured callback → SSE (mirror the transcription job exactly).

## Requirements to add (EARS) — reserve REQ-100+

Draft these into `specs/requirements.md` under a new "Clinical note generation" section:
- REQ-100 (Event) — WHEN the user requests a note for a completed transcript with
  a template, THE SYSTEM SHALL generate a structured note via the configured provider.
- REQ-101 (Ubiquitous) — THE SYSTEM SHALL default to the local Ollama provider and
  SHALL NOT send the transcript off-device unless the operator explicitly selects
  a cloud provider via server env (`STT_NOTE_PROVIDER=claude`). *(→ new ADR-0009, ADR-0003)*
- REQ-102 (Unwanted) — IF a cloud provider is requested but its env flag/token is
  unset, THEN THE SYSTEM SHALL refuse and explain, without sending any data.
- REQ-103 (State) — WHILE a note is generating, THE SYSTEM SHALL stream it to the
  client over SSE (token deltas), with a poll fallback. *(→ ADR-0008 pattern)*
- REQ-104 (Ubiquitous) — THE SYSTEM SHALL present the note as a review draft
  (not a finalized record) and preserve the prompt's "Clinician Review Needed" section.
- REQ-105 (Ubiquitous) — THE SYSTEM SHALL keep Ollama model downloads inside the
  project (`OLLAMA_MODELS`), preserving one-command cleanup. *(→ ADR-0003)*

Add **ADR-0009 — clinical-note pluggable provider (local default, cloud opt-in)**
capturing the PHI rationale above.

## Templates (decided)

Ship 2 starter templates as picks (SOAP note, H&P) **plus a free-text paste box**.
Note screen sits AFTER the transcript viewer: transcript → "Generate Note" → note screen.

## The clinical-documentation system prompt (store verbatim in prompt.py)

The user supplied a detailed prompt. Its intent (reproduce faithfully; the full
text was given in the originating chat — if not recoverable, ask the user to
re-paste before building): a **clinical documentation assistant** that converts a
transcribed patient–doctor conversation into an accurate, structured clinical
note using provided sample note formats. Key rules the prompt enforces —
**preserve all of these**:
- Prioritize factual accuracy, faithful extraction, clinical usefulness. Do NOT
  invent/assume/diagnose. Mark unclear/missing/contradictory/implied info as
  "unclear", "not stated", or "requires clinician review".
- Treat the transcript as possibly containing STT errors (misheard meds, wrong
  doses, confused family relations, wrong names/dates/ages). Correct only obvious
  errors when meaning is highly clear; otherwise preserve original wording + flag.
  Never silently change meaning; never turn uncertain text into confirmed fact.
- Preserve negations ("no chest pain", "denies fever", "never smoked").
  Separate patient-reported history from clinician assessment/plan.
- Extract: patient demographics, chief complaint, HPI, PMH, PSH, meds
  (dose/route/freq/adherence/changes), allergies, social history, ROS, exam
  (only if mentioned), labs/imaging/genetic/path results, assessment & plan,
  follow-up/referrals/orders/return precautions.
- Build a **pedigree / family-history** summary when family history is present
  (proband; maternal vs paternal only if explicitly stated; relation, sex, age,
  age at dx/death, conditions; label unknowns "unknown", don't guess; don't invent
  relatives). Otherwise state none was stated.
- Follow the provided sample note **format** (headings/order/tone/detail). Add an
  "Additional Extracted Clinical Information" / "Clinician Review Items" section if
  the format lacks a needed slot.
- Output sections **A–E**: A) Structured Clinical Note (in the sample format),
  B) Patient Information Summary, C) Pedigree/Family History Summary (or "none
  stated"), D) Orders/Plan/Follow-Up, E) Clinician Review Needed (unclear items,
  contradictions, possible transcription errors, missing info, items needing
  confirmation).
- Safety rules: no clinical recommendations beyond what the clinician stated; no
  inferred dx/relations/doses/allergies/results; don't normalize abnormal findings;
  don't omit important negatives; don't overstate certainty; concise clinical
  language; final note is for clinician review, not a finalized record.
- Do a self-check before finalizing (no unsupported info added; negations
  preserved; patient vs clinician separated; unclear/missing marked; format
  followed; pedigree only when supported).

Inputs the prompt takes: (1) sample note format(s), (2) the transcript.

> ‼️ **Before building, confirm with the user you have the exact prompt text.**
> The summary above is faithful to intent but the user's original wording should
> be pasted in verbatim — ask for it if this chat's copy isn't available.

## Build phases (each a shippable checkpoint)

1. `packages/note-core` + `OllamaProvider`. Install Ollama (`brew install ollama`),
   set `OLLAMA_MODELS` in env.sh, `ollama serve` + `ollama pull <model>`. Verify a
   note generates from `out/conversation.json`'s transcript via a tiny CLI/script.
2. API: `POST /notes` (+ poll + SSE), reusing the transcription job pattern. Verify via `/docs`.
3. UI: template picker/paste → "Generate Note" → live-streamed NoteViewer (A–E,
   highlight "Clinician Review Needed") → copy / download `.md`.
4. `ClaudeProvider` + `STT_NOTE_PROVIDER=claude` opt-in + UI warning banner. Re-load
   the `claude-api` skill for exact SDK usage.
5. Docs: ADR-0009, REQ-100+, update AGENTS.md/tech.md/structure.md/product.md and
   per-app READMEs. Add a note-generation line to the verify gate.

## Verify (this feature)

```bash
source env.sh
ollama serve &                 # if not already running (OLLAMA_MODELS set by env.sh)
# generate a note from the sample transcript via the new path (CLI or API)
```
PASS = a note with all five sections (A–E), a populated "Clinician Review Needed",
and — for a transcript containing an ambiguous term — that term flagged rather
than silently "corrected". Cloud path stays refused unless the env flag is set.

## Constraints to respect (don't violate)

- [x] Local (Ollama) is the DEFAULT; cloud is opt-in only, with a UI warning (ADR-0009)
- [x] Ollama models redirected into the project via `OLLAMA_MODELS` (ADR-0003)
- [x] note-core is pure; API stays thin; import-not-subprocess; lazy heavy imports
- [x] Stream the note over SSE, same pattern as transcription (ADR-0008)
- [x] Never send PHI off-device on the default path; never log/return a cloud token
- [x] Store the clinical prompt verbatim; preserve negations + uncertainty flagging
