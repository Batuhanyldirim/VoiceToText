# ADR-0015 — Editable & finalizable notes (edit overlay + draft/final lifecycle)

**Status:** Accepted · **Relates to:** REQ-132–REQ-136, ADR-0010, ADR-0009, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteViewer.tsx`

## Context

Until now a generated note was a read-only artifact: the AI produced it, it was
saved, and the doctor could only copy/download it. That's a toy, not a clinical
tool — a real note **must be correctable** (the model mis-hears drug names,
misattributes speakers, over/under-states findings) and, once correct, must be
**markable as a final record** so it's clear what has been reviewed and signed
off versus what's still an unverified AI draft.

This is the first slice of the agreed product reframing toward
patient/encounter-centric clinical documentation (Tier 1). It deliberately stays
small: it only touches the **note** (the durable SQLite record from ADR-0010) —
no new patient model yet, no new page.

Two design questions:
1. **Do edits overwrite the AI output?** No. The AI's original is an audit trail —
   we want to always be able to show "AI wrote X, clinician changed it to Y" and
   let the doctor revert a bad edit. So edits are an **overlay**, not a mutation.
2. **How is "signed" modeled?** A single `status` (`draft` → `final`) with a
   `finalized_at` stamp and an edit-lock. Not a heavyweight signature/audit-log
   system — this is one local user; the lock + timestamp are enough to distinguish
   "reviewed & final" from "unverified draft" (which the UI's warning banner marks).

## Decision

Extend the durable note record (ADR-0010) with an **edit overlay + a draft/final
lifecycle**; the SQLite store becomes the source of truth for a completed note's
current body.

- **Schema (migrated via `ALTER TABLE` on the existing `notes` table):**
  - `edited_note TEXT NULL` — the clinician's edited body. NULL = untouched.
  - `status TEXT NOT NULL DEFAULT 'draft'` — `draft` | `final`.
  - `finalized_at TEXT NULL` — ISO-8601 UTC when finalized; NULL while draft.
  The AI's original stays in the existing `note` column, **never overwritten**.
- **Effective body.** The note's current text = `edited_note` if present, else
  `note`. `GET /notes/{id}` returns both `note` (AI original) and `edited_note`
  (overlay) plus `status`/`finalized_at`/`edited`, so the UI can render the
  effective body and offer "revert to AI draft".
- **Endpoints (all operate on the durable store):**
  - `PATCH /notes/{id}` `{note}` — save an edited body (REQ-132). **409** if the
    note is `final` (must reopen first).
  - `POST /notes/{id}/finalize` — `status=final` + `finalized_at=now` (REQ-133).
  - `POST /notes/{id}/reopen` — back to `draft`, clear `finalized_at` (REQ-134).
  - `POST /notes/{id}/revert` — clear `edited_note` overlay (REQ-135); rejected
    when `final`.
- **Web UI (NoteViewer).** A **Düzenle** toggle turns the rendered note into an
  editable markdown textarea with **Kaydet/İptal**; a **Taslak/Tamamlandı** status
  chip; a **Tamamla/İmzala** button that flips to **Yeniden aç** once final; a
  **"AI taslağına dön"** revert action shown only when edited. A finalized note is
  read-only (edit disabled) until reopened. The sidebar marks finalized notes.
- **Live vs. saved.** Edit/finalize apply to **completed, persisted** notes only
  (the in-memory `NoteJobManager` still owns the generating lifecycle). This keeps
  the "only finished work is durable" rule (ADR-0010/0012) intact.

## Consequences

- ✅ A note is now a correctable, sign-off-able clinical record — the core gap
  that made the tool non-usable for real documentation.
- ✅ The AI's original is preserved (audit trail + safe revert); edits can't
  silently destroy what the model produced.
- ✅ `final` + `finalized_at` cleanly separate "reviewed" from "unverified draft"
  (the draft warning banner is driven off `status`), with no heavyweight audit
  infra — proportionate to one local user.
- ➖ The store, not just the in-memory job, is now authoritative for a completed
  note's body — `GET /notes/{id}`'s store branch must return the effective body +
  overlay fields (the live-job branch is unchanged; a note is only editable once
  saved).
- ⚠️ **Do not** overwrite the `note` column on edit (breaks the audit trail /
  revert). **Do not** allow edits to a `final` note without an explicit reopen.
  Edits/finalize live only in the durable store (PHI, git-ignored — ADR-0010);
  never log note bodies.
