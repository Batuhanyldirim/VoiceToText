# Task: Search & filter across notes (Tier 1)

**Status:** DONE on `feat/tier1-search`. REQ-141, ADR-0018.

## What shipped
- **store.list(patient_id, q)** — case-insensitive LIKE across title, patient
  name, and the EFFECTIVE note body (`COALESCE(edited_note, note)`); composes
  with the patient filter via AND.
- **GET /notes?q=…&patient_id=…** — both optional, both applied.
- **NotesSidebar** — a debounced (300ms) "Notlarda ara…" search box that combines
  with the patient dropdown; a distinct "Eşleşen not bulunamadı." empty state.
- API client `listNotes(signal, patientId, q)`.

## Verified
- 6 new pytest cases (title/patient/body match, effective-body, composes-with-
  patient, blank-returns-all) + 2 API cases. `make test` → 33 passed.
- Web build + lint green.
