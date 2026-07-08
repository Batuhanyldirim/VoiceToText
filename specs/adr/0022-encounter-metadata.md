# ADR-0022 — Encounter metadata captured up front (visit type + chief complaint)

**Status:** Accepted · **Relates to:** REQ-153–REQ-155, ADR-0016, ADR-0018, ADR-0010, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteGenerator.tsx`

## Context

Notes are found by patient (ADR-0016) and free-text search (ADR-0018), but they
still lack the light structured context a clinician thinks in: *which patient,
what kind of visit, what was the complaint*. Today the note title is just
"<source> — <template>" (e.g. "kayit-2026… — SOAP notu"), which is meaningless in
a list. Capturing a few fields **at creation** makes notes self-describing and
searchable without a heavyweight "encounter" object.

This is the incremental step toward the roadmap's encounter model — deliberately
**not** a separate `encounters` table yet (a note is still the encounter unit,
ADR-0016). We just add a few columns to the note and a small form up front.

## Decision

Add optional **visit type** + **chief complaint** to a note (patient assignment
already exists, ADR-0016), captured in the note generator, persisted, titled from,
and searchable.

- **Schema:** `notes.visit_type TEXT NULL`, `notes.chief_complaint TEXT NULL`
  (migration, lossless). Patient is the existing `patient_id`.
- **Creation (`POST /notes`):** accept `patient_id`, `visit_type`,
  `chief_complaint`. Assign the patient at persist time (reuse
  `set_note_patient`), store the two fields.
- **Auto-title (REQ-154):** if the client didn't pass an explicit `title`, build
  one that leads with the chief complaint when present:
  `"<chief_complaint> — <template label>"`, else the current
  `"<source> — <template>"`. The client can still override.
- **Search (REQ-155):** `store.list(q=…)` also matches `chief_complaint` and
  `visit_type` (added to the existing OR over title/patient/body).
- **Surface:** `GET /notes/{id}` + the list carry `visit_type` +
  `chief_complaint`; the web note generator has a compact "Muayene bilgisi"
  section (patient selector + a visit-type field with common presets + a chief
  complaint field), and the note header shows visit-type / chief-complaint chips.
- **Visit type** is a free string with suggested presets (İlk başvuru, Kontrol,
  Konsültasyon, Acil, Telefon) — not an enum, so it stays flexible.

Out of scope: a real `encounters` table, multiple notes per encounter,
scheduling/appointment linkage, and structured complaint coding.

## Consequences

- ✅ Notes are self-describing (meaningful titles) and findable by complaint/visit
  type — the everyday "where's Ayşe's cough follow-up" lookup.
- ✅ Tiny, additive change — a couple of nullable columns + a form section;
  forward-compatible with a later `encounters` table (these fields move onto it).
- ➖ Still note-as-encounter; a visit that produces several artifacts isn't modeled
  yet (a future ADR).
- ⚠️ All fields optional — never block note generation on them (the fast path is
  still one click). Keep visit type a free string (with presets), not a rigid enum.
  Metadata is PHI-adjacent — same git-ignored project DB (ADR-0010).
