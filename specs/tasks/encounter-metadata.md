# Task: Encounter metadata up front (Tier 2)

**Status:** DONE on `feat/tier2-encounter-metadata`. REQ-153–155, ADR-0022.

## What shipped
- **store.py** — `notes.visit_type` + `notes.chief_complaint` columns (migration);
  carried on `get`/`list`/summary; **search** (`list(q=…)`) now also matches chief
  complaint + visit type.
- **notes.py / main.py** — `POST /notes` accepts `patient_id`, `visit_type`,
  `chief_complaint`; the worker persists them and assigns the patient up front;
  **auto-title** leads with the chief complaint when present ("Öksürük — SOAP
  notu") unless the client sent an explicit title. `GET /notes/{id}` + list carry
  the fields.
- **Web** — NoteGenerator "Muayene bilgisi" section (patient select or new-patient
  name, visit-type field with datalist presets, chief-complaint field); the client
  no longer sends a title so the server auto-titles. NoteViewer shows visit-type +
  chief-complaint chips.
- API client body fields + types.

## Verified
- pytest: metadata persist + list; search matches chief complaint + visit type.
  `make test` → 62 passed.
- Web build + lint green.

## Known limitation (documented, not fixed)
Turkish dotted-İ: a search term STARTING with "İ"/"I" won't match via SQLite's
ASCII `lower()` (e.g. searching "ilk" won't hit "İlk başvuru"), though substrings
after the İ do. This is a pre-existing ASCII-`lower()` limitation shared with
title/body search (ADR-0018); a Turkish-collation fix would be its own ADR.
