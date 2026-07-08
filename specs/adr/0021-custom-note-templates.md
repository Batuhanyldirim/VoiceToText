# ADR-0021 — Custom note templates (saved formats over the "free" paste path)

**Status:** Accepted · **Relates to:** REQ-150–REQ-152, ADR-0009, ADR-0010, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web`, `packages/note-core`

## Context

Notes are generated from a **template**: a built-in key (`soap`, `hp`) whose
sample format is baked into `note_core`, or `free` — where the user pastes a
sample format (`template_text`) that drives the layout. A clinician with their own
preferred format has to **re-paste it every time**. They want to save named,
reusable templates (e.g. "Kardiyoloji kontrol", "Pediatri ilk başvuru").

Key realization: a custom template **is** just a saved `template_text`. The whole
generation path already accepts an arbitrary sample format via the `free` route
(`resolve_template_text` returns `template_text` verbatim). So custom templates
need **no change to `note_core`** — they're a persistence + resolution concern in
the API layer.

Where to store them? The same project-local SQLite DB (ADR-0010) — a small
`note_templates` table. They're not PHI, but keeping them in the one DB keeps a
single store + the `rm -rf` cleanup story intact, and they stay git-ignored with
the DB.

## Decision

Persist named custom templates in the store; merge them into the template picker;
resolve a custom template to its body at generation time (as a saved "free").

- **Schema:** `note_templates(id, name, body, created_at)` in the notes DB.
- **CRUD:** `GET /note-templates`, `POST /note-templates {name, body}`,
  `PUT /note-templates/{id} {name?, body?}`, `DELETE /note-templates/{id}`.
- **Listing (`GET /notes/templates`):** returns built-ins (`TEMPLATE_CHOICES`) +
  each custom template (`{key: "custom:<id>", label: name, description, custom:
  true}`) + the `free` option. The `custom:` key prefix distinguishes them without
  colliding with built-in keys.
- **Generation (`POST /notes`):** when the requested `template` is `custom:<id>`,
  the API looks up the template body and calls generation with **`template="free"`
  + `template_text=<body>`** — so `note_core` is unchanged (it already handles a
  free sample). Built-in keys and an explicit `free` paste work exactly as before.
- **Web:** a **"Şablonlar"** manager (list / create / edit / delete, name + body
  editor); custom templates appear in the `NoteGenerator` template picker labelled
  as custom. Deleting a template doesn't affect already-generated notes (they
  stored their resulting text, not a template reference).

Out of scope: sharing/exporting templates, per-template provider/model defaults,
template variables/placeholders, and versioning of templates.

## Consequences

- ✅ Clinicians save their own formats once and reuse them — no re-pasting.
- ✅ Zero change to `note_core`: a custom template is resolved to a "free" sample
  at the API boundary, reusing the proven generation path.
- ✅ One store, one cleanup story; the `custom:<id>` key namespacing keeps
  built-in and custom keys distinct.
- ➖ Templates live only on this machine (git-ignored, like all app data) — no
  sharing; acceptable for the single-user tool.
- ⚠️ Resolve `custom:<id>` **server-side** (never trust a body from the client for
  a saved template). A missing/deleted custom id at generation time must 4xx
  clearly, not silently fall back. Deleting a template must not alter existing
  notes (they own their generated text).
