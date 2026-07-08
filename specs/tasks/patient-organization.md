# Task: Patient organization (Tier 1)

**Status:** IMPLEMENTED on `feat/tier1-patients`, pending user functional check.
Second Tier-1 item (after editable notes). REQ-137–140, ADR-0016.

## Goal
Make notes findable by **patient**: a lightweight patient entity, notes filed
under a patient, and browse/filter by patient — layered onto the existing flat
note list (not a nav rebuild).

## What shipped
- **store.py** — `patients` table + `notes.patient_id` (migration, verified safe
  on old DBs, no data loss); `create_patient` (reuses by name, case/space-
  insensitive), `list_patients` (w/ note_count), `get_patient`,
  `set_note_patient`, `list(patient_id=…)` filter + `patient_name` join.
- **main.py** — `GET/POST /patients`, `GET /patients/{id}` (patient + its notes),
  `PUT /notes/{id}/patient` (allowed even when final — REQ-139); notes list/get
  carry `patient_id` + `patient_name`; `GET /notes?patient_id=…` filter.
- **PatientSelector.tsx** — autocomplete to pick an existing patient or create one
  by typing a name; wired into NoteViewer (assign + patient chip).
- **NotesSidebar** — patient filter dropdown ("Tüm hastalar" / a patient with
  count) + patient name on note rows.
- API client + types.

## Verified
- Headless store lifecycle + old-schema migration (no data loss).
- Full HTTP flow: create → name-reuse → assign → counts → filter → patient's
  notes → refile-when-final (200) → unknown patient (400). All pass.
- Web build + lint green (only the 2 pre-existing TranscriptViewer warnings).

## User functional check (do this)
1. Restart the API so the migration + new endpoints load: `make api`.
2. Open a saved note → "Hasta" selector → type a new name → "+ … oluştur" →
   it's assigned (chip appears). Open another note → pick the same patient from
   the list.
3. Sidebar shows a patient filter; select the patient → list narrows to their
   notes; rows show the patient name.
4. Finalize a note, then reassign its patient — still allowed (filing is metadata).

## Next Tier-1 items (do NOT lose): search/filter across notes, real export
(PDF + EHR copy). See the product-roadmap memory.
