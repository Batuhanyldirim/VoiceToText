# Task: Custom note templates (Tier 2)

**Status:** DONE on `feat/tier2-template-manager`. REQ-150–152, ADR-0021.

## What shipped
- **store.py** — `note_templates` table + CRUD (`list/get/create/update/delete_template`;
  name+body required).
- **main.py** — `GET/POST /note-templates`, `PUT/DELETE /note-templates/{id}`;
  `GET /notes/templates` merges built-ins + custom (`key: "custom:<id>"`, `custom:
  true`) + free; `POST /notes` resolves a `custom:<id>` template server-side to a
  saved "free" sample (`template="free"` + stored body) — **no note_core change**;
  a missing custom id → 400.
- **Web** — `TemplateManager` dialog (list / create / edit / delete, name + Markdown
  body); a "Şablonları yönet" button in `NoteGenerator`; custom templates appear in
  the picker labelled "(özel)"; the picker reloads after a change.
- API client + `CustomTemplate` type + `NoteTemplate.custom` flag.

## Verified
- 7 new pytest cases (store CRUD + validation; endpoint CRUD + validation + 404;
  custom appears in /notes/templates with the right key; unknown custom:<id> → 400).
  `make test` → 60 passed.
- Web build + lint green.

## Note
A custom template is a saved "free" sample — resolved at the API boundary, so the
generation pipeline is unchanged. Deleting a template doesn't affect already-
generated notes (they own their text). Templates live in the git-ignored project DB.
