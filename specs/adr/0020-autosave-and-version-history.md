# ADR-0020 — Autosave + version history for note edits

**Status:** Accepted · **Relates to:** REQ-147–REQ-149, ADR-0015, ADR-0010, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteViewer.tsx`

## Context

ADR-0015 made notes editable (an overlay over the AI original) with a manual
"Kaydet". Two gaps remain for real clinical use:
1. **Losing work.** If the clinician edits and then navigates/refreshes without
   pressing Kaydet, the edit is lost. Autosave fixes that.
2. **No history.** An edit overwrites the previous edited body. If a correction
   was wrong, or text was accidentally deleted, there's no way back (only
   "revert to AI draft", which throws away *all* edits). We want recoverable
   revisions.

Design questions:
- **Autosave transport?** Reuse the existing `PATCH /notes/{id}` (the overlay
  write) — no new endpoint, just a debounced client-side trigger. Only for drafts
  (a final note is locked, REQ-133).
- **How much history, and where?** A per-note append-only list of prior bodies.
  Keep it in the same project-local SQLite DB (ADR-0010) as a `note_versions`
  table — it's PHI, stays git-ignored, and `rm -rf` still cleans up. Not a
  full diff/CRDT system — snapshots of the body are enough and simple.

## Decision

Add **debounced autosave** (reusing the overlay write) and a **`note_versions`**
snapshot table with list + restore.

- **Autosave.** While editing a *draft*, the client debounces (~1.5 s after the
  last keystroke) and calls `PATCH /notes/{id}` with the current text, showing a
  small "Kaydediliyor…/Kaydedildi" indicator. Manual "Kaydet" still works
  (immediate). No autosave when finalized.
- **Versioning (server-side, in `update_body`).** When a note's body is about to
  change and the **new body differs** from the stored body, the store first
  **snapshots the current body** into `note_versions(id, note_id, seq, body,
  saved_at)` (monotonic `seq` per note), then writes the new `edited_note`. This
  captures every distinct saved state — including the AI original the first time
  an edit replaces it, and the finalized body when finalize runs. Identical
  re-saves (autosave with no change) do **not** create a version.
- **Endpoints.** `GET /notes/{id}/versions` → versions newest-first (metadata +
  body). `POST /notes/{id}/restore {version_id}` → sets that version's body as the
  current edited body (which itself snapshots the pre-restore body, so restore is
  undoable). Restore is blocked on a finalized note (reopen first), like editing.
- **Web.** A **"Sürüm geçmişi"** button on the note opens a panel/dialog listing
  versions (timestamp + preview); selecting one shows its body with a **"Bu sürümü
  geri yükle"** action. Autosave status shows inline near the edit controls.
- **Cleanup.** `DELETE /notes/{id}` also deletes its versions. The table lives in
  the git-ignored project DB (ADR-0010/0003).

Out of scope: line-level diffs, branching, per-keystroke history, cross-note
version compare, and a cap/pruning policy (revisit if a note ever accrues an
unreasonable number of versions — not a concern for one local user).

## Consequences

- ✅ Edits are never lost (autosave) and any prior saved revision is recoverable
  (history + restore) — real safety for clinical editing.
- ✅ Reuses the existing overlay write for autosave (no new save path); versioning
  is a small append-only table in the store already used for notes.
- ✅ Every distinct saved body is captured (incl. AI original → first edit, and
  the finalized body); no-op re-saves don't spam versions.
- ➖ Storage grows with edit count (full-body snapshots, not diffs) — negligible
  for one local user; a pruning policy can be added later if needed.
- ⚠️ Snapshot only when the body actually **differs** (else autosave floods
  versions). Block restore on a finalized note (reopen first). Versions are PHI —
  git-ignored, deleted with the note.
