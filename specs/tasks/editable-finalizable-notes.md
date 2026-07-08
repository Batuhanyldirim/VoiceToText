# Task: Editable & finalizable notes (Tier 1)

**Status:** IMPLEMENTED on `feat/tier1-editable-notes`, pending user functional
check. First slice of the patient/encounter product reframing (see the roadmap).
REQ-132–136, ADR-0015.

## Goal
A generated note is an AI **draft**; the doctor must be able to **correct** it
and mark it a **final** record. The AI original is preserved (audit trail); edits
are an overlay that can be reverted; a final note is locked until reopened.

## What shipped
- **store.py** — `edited_note`/`status`/`finalized_at` columns (ALTER-TABLE
  migration, verified safe on an old-schema DB); `effective_note` = edit ?? AI;
  `update_body`/`revert`/`set_status` + `NoteLockedError`.
- **main.py** — the durable store is now authoritative for a completed note's
  body/lifecycle in `GET /notes/{id}`; `PATCH /notes/{id}` (409 if final),
  `POST /notes/{id}/finalize|reopen|revert`. `GET /notes` list carries
  status/finalized_at/edited.
- **NoteViewer.tsx** — Düzenle (markdown textarea) + Kaydet/İptal; Taslak/
  Tamamlandı chip; Tamamla ↔ Yeniden aç; "AI taslağı" revert; draft vs final
  warning banner. **NotesSidebar** marks final notes (✓ + "Tamamlandı").
- API client + types for the four lifecycle calls.

## Verified
- Headless store lifecycle (edit preserves AI, finalize locks, reopen, revert).
- Old-schema DB migration (no data loss; note stays editable).
- **Full HTTP lifecycle** on a live server: GET→PATCH→GET(AI preserved)→list→
  finalize→PATCH=409→reopen→revert. All pass.
- Web build + lint green (only the 2 pre-existing TranscriptViewer warnings).

## User functional check (do this)
1. Restart the API so the migration runs + new endpoints load: `make api`
   (the previously-running server predates these changes).
2. Open a saved note → **Düzenle** → change text → **Kaydet** → it re-renders as
   formatted markdown, chip shows "Düzenlendi".
3. **Tamamla** → banner turns green "Tamamlandı", edit disabled, sidebar shows ✓.
4. **Yeniden aç** → editable again. **AI taslağı** → your edits are discarded,
   original AI text returns.

## Next (later Tier 1 items — do NOT lose): patient organization, search/filter,
real export (PDF + EHR copy). See the product-roadmap memory.
