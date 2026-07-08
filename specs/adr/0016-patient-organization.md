# ADR-0016 — Patient organization (lightweight patient entity + note→patient link)

**Status:** Accepted · **Relates to:** REQ-137–REQ-140, ADR-0010, ADR-0015, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteViewer.tsx`, `apps/web/src/components/NotesSidebar.tsx`

## Context

The tool has thought in **flat, timestamped notes**. A doctor thinks in
**patients**: "show me Mr. Yılmaz's visits." Without a patient dimension, notes
pile up in one undifferentiated list and become unfindable as history grows. This
is the agreed structural centerpiece of the product reframing toward
patient/encounter-centric documentation (Tier 1).

The design tension is **how much to take on now**. A full "encounter" model
(a patient has many encounters; an encounter has a transcript + a note + metadata)
plus a page/nav rebuild is the eventual shape — but that's a large, risky jump.
The notes already ARE the per-visit records (each carries its transcript + note +
timing). So the minimal, high-value step is: add a **patient** the note can be
filed under, and let the UI **browse/filter by patient** — layering onto the
existing note list rather than rebuilding it. The richer encounter model + a
dedicated patient page can come later without throwing this away.

## Decision

Add a **lightweight patient entity** and a **note→patient foreign key**, plus
minimal endpoints and UI to file and browse by patient.

- **Schema (SQLite, ADR-0010; migrated via `CREATE TABLE IF NOT EXISTS` + a
  guarded `ALTER TABLE` on `notes`):**
  - New `patients` table: `id TEXT PK`, `name TEXT NOT NULL`, `mrn TEXT NULL`
    (medical record no. / hasta no), `created_at TEXT NOT NULL`.
  - `notes.patient_id TEXT NULL` — a note is filed under at most one patient;
    NULL = unassigned (all pre-existing notes stay unassigned — no data loss).
- **Name reuse.** Creating a patient by a name that already exists **reuses** the
  existing row (`get_or_create_by_name`, case-insensitive trim) so the same
  patient isn't duplicated across visits. `mrn` is optional and free-form (this is
  a local single-doctor tool, not an EHR identity system).
- **Endpoints:**
  - `GET /patients` → `[{id, name, mrn, created_at, note_count}]` (name order).
  - `POST /patients {name, mrn?}` → the patient (created or reused).
  - `GET /patients/{id}` → the patient + its notes (summary rows, newest-first).
  - `PUT /notes/{id}/patient {patient_id|null}` → (re)file or clear a note's
    patient. **Allowed even when the note is `final`** (REQ-139): filing is
    metadata about *where the note lives*, not the clinical content the finalize
    lock protects. `GET /notes` and `GET /notes/{id}` carry `patient_id` +
    `patient_name`.
- **Web UI:** a **"Hasta"** control on the note (an autocomplete that picks an
  existing patient or creates one by typing a new name) → assigns it; the assigned
  patient shows as a chip on the note and on its sidebar row; the sidebar gains a
  **patient filter** ("Tüm hastalar" / a specific patient). The flat "Notlarım"
  list still works — patient is an added dimension, not a replacement.

Deliberately **out of scope here** (kept for later, per the roadmap): a full
encounter object, a dedicated patient-detail page/route, and the home/nav rebuild.
Also out: any cross-patient identity resolution, de-duplication by MRN, or
demographics beyond name + optional MRN.

## Consequences

- ✅ Notes become findable by patient — the core organizational gap; a doctor can
  pull up one patient's visit history.
- ✅ Incremental: the existing note list/flow is untouched; patient is additive,
  so this ships without a risky page/nav rebuild.
- ✅ Migration is additive and lossless — old notes simply have `patient_id = NULL`
  (shown as "Atanmamış / unassigned").
- ➖ It's a **link, not a full encounter model** — a note is still the unit; if we
  later want multiple notes/artifacts per encounter, that's a further ADR (this
  link is forward-compatible with it).
- ➖ `name`-based reuse can merge two genuinely different same-named patients; MRN
  is available to disambiguate but not enforced (acceptable for one local doctor;
  an EHR-grade identity model is explicitly out of scope).
- ⚠️ **Do not** block patient (re)assignment on the finalize lock — filing is
  metadata (REQ-139). Patient data is PHI: it lives in the same git-ignored,
  project-local DB (ADR-0010/0003) and is never logged or committed.
