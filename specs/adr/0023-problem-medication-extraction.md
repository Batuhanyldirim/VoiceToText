# ADR-0023 — Problem & medication extraction (structured lists from a note)

**Status:** Accepted · **Relates to:** REQ-156–REQ-159, ADR-0009, ADR-0010, `packages/note-core/src/note_core/extract.py`, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteViewer.tsx`

## Context

A generated note is free text. To make it *queryable* — "what problems has this
patient had?", "what meds are they on?" — we want a structured **problem list**
and **medication list** pulled from the note. This is the first Tier-3
"intelligence" feature and the groundwork for later logic (reminders, summaries).

Two decisions:
- **How to extract?** Reuse the existing pluggable provider seam (ADR-0009/0011):
  the same `Provider.stream(system, user, opts, result)` used for note generation,
  with an **extraction prompt** that demands strict JSON. This keeps extraction on
  the **local default** (Ollama; PHI on-device) and inherits the cloud gating for
  free — no new AI path, no new privacy surface.
- **Where to store?** On the note row (ADR-0010): `problems_json` /
  `medications_json` (JSON strings). Denormalized onto the note so `GET /notes/{id}`
  is self-contained; deleted with the note.

## Decision

Add a pure `note_core.extract()` that reuses providers to produce validated
structured lists, persist them on the note, expose an extract endpoint, and show
them in the UI.

- **`note_core.extract(text, opts) -> ExtractionResult`** (new `extract.py`):
  builds an extraction system+user prompt (Turkish output; **grounded only in the
  provided text — never invent items**; return STRICT JSON
  `{"problems": [{name, status?, detail?}], "medications": [{name, dose?, route?,
  frequency?}]}`), calls `get_provider(opts.provider).stream(...)`, collects the
  full text, and **robustly parses** it: extract the first JSON object (tolerate
  code fences / prose around it), coerce to the schema, drop malformed entries.
  On unparseable output it returns **empty lists** (never fabricates, never
  raises for that). Pure — no printing/IO. Exposed from `note_core`.
- **Store:** `notes.problems_json` + `notes.medications_json` (nullable TEXT,
  migration); `SavedNote.problems` / `.medications` parse them (→ [] on absent/bad);
  `set_extraction(note_id, problems, medications)` persists; `GET /notes/{id}`
  returns `problems`, `medications`, and `extracted` (bool).
- **API:** `POST /notes/{id}/extract` runs extraction on the note's **effective
  body** (the reviewed text, not a stale AI original), persists, returns the note.
  It's synchronous (extraction is a single short generation) with the same
  provider/gating as `POST /notes`; 404 if the note is unknown. Re-runnable
  (overwrites). Deleting a note drops the lists with the row.
- **Web:** NoteViewer shows **"Sorunlar"** and **"İlaçlar"** panels (chips/rows)
  when present, with a **"Çıkar" / "Yeniden çıkar"** button and a spinner while it
  runs. Absent → a subtle prompt to run extraction. Allowed on draft or final
  (extraction is derived metadata, doesn't modify the note body).

Out of scope: coding to ICD/ATC, cross-note problem/med reconciliation, dosage
validation, and structured allergy/vitals extraction (could follow the same shape
later).

## Consequences

- ✅ The note becomes structured/queryable; foundation for reminders + future
  clinical logic. Runs locally by default — PHI stays on-device (ADR-0009).
- ✅ Zero new AI/provider infra: reuses the generation seam + gating; a bad model
  response degrades to empty lists, never fabricated data.
- ➖ Extraction quality is model-bound (a small local model may miss items);
  re-runnable, and it's a review aid, not an authoritative record.
- ➖ Lists are denormalized JSON on the note (not a queryable table) — fine for
  display now; a real problems/meds table is a later step if cross-note queries
  are wanted.
- ⚠️ Prompt must forbid inventing items and demand strict JSON; the parser must
  tolerate fences/prose and **fail closed to empty lists**. Extract from the
  **effective** body. Run through the gated provider seam (never bypass the cloud
  opt-in). Lists are PHI — on the git-ignored note row, deleted with the note.
