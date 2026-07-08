# Task: Problem & medication extraction (Tier 3)

**Status:** DONE on `feat/tier3-problem-med-extraction`. REQ-156–159, ADR-0023.

## What shipped
- **note_core/extract.py** — `extract(text, opts) -> ExtractionResult` reuses the
  gated provider seam (local default; PHI on-device). Turkish, grounded-only-in-
  the-text prompt demanding strict JSON; `parse_extraction()` tolerates code
  fences / prose, coerces to schema, drops malformed entries, and **fails closed
  to empty lists** (never fabricates, never raises on bad content). Exported.
- **store.py** — `notes.problems_json` + `medications_json` columns (migration);
  `SavedNote.problems`/`.medications`/`.extracted`; `set_extraction()` overwrites.
- **main.py** — `POST /notes/{id}/extract` runs extraction on the EFFECTIVE body
  via the same provider gating as generation (sync `def` → threadpool), persists,
  returns the note (404 unknown; 400 on ProviderError — no data sent when cloud
  refused). `GET /notes/{id}` carries `problems`/`medications`/`extracted`.
- **NoteViewer** — a "Sorunlar ve İlaçlar" card with "Çıkar / Yeniden çıkar"
  (spinner) and two lists; a prompt when not yet extracted.
- API client `extractNote` + `Problem`/`Medication` types.

## Verified
- Parser unit-tested against raw/fenced/prose/string-items/garbage/malformed →
  correct + fail-closed. Store set/overwrite/missing. Endpoint (monkeypatched
  extractor — no Ollama needed): persists + surfaces on GET; 404 unknown; 400 on
  ProviderError. `make test` → 69 passed. Build + lint green.

## Notes
Reuses the note-generation provider path — no new AI/privacy surface. Extraction
is a re-runnable review aid (model-bound quality), not an authoritative record;
lists are denormalized JSON on the note (PHI, git-ignored, deleted with the note).
Live model quality is unverified without Ollama running — spot-check with a real
note.
