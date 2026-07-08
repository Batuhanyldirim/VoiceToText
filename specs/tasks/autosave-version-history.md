# Task: Autosave + version history (Tier 2)

**Status:** DONE on `feat/tier2-autosave-history`. REQ-147–149, ADR-0020.

## What shipped
- **store.py** — `note_versions` table (id, note_id, seq, body, saved_at) +
  `_snapshot_version`; `update_body`/`revert`/`set_status`(finalize)/`restore_version`
  snapshot the PRIOR body **only when it changes** (autosave no-ops don't create
  versions); `list_versions`, `restore_version` (blocked when final, itself
  versioned); `delete` removes a note's versions.
- **main.py** — `GET /notes/{id}/versions`, `POST /notes/{id}/restore` (404
  unknown, 409 final).
- **NoteViewer** — debounced (~1.5s) autosave while editing a draft (reuses
  PATCH; "Kaydediliyor…/Otomatik kaydedildi" chip), a "Sürüm geçmişi" dialog
  (timestamp + preview, click to restore). Manual Kaydet still works.
- API client + `NoteVersion` type.

## Verified
- 11 new pytest cases (snapshot-on-change, no-op skip, restore + re-versioning,
  finalize snapshot + restore-blocked-when-final, revert snapshot, delete cleanup,
  unknown-version 404/409). `make test` → 54 passed.
- Headless logic trace + web build + lint green.

## Notes
Snapshots are full-body (not diffs) — right-sized for one local user; a pruning
policy can come later. Autosave only for drafts (final is locked). Versions are
PHI: git-ignored project DB, deleted with the note.
