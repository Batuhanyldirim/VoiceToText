# Task: Patient List + Patient Page (with routing)

**Status:** DONE on `feat/patient-pages`. REQ-160–163, ADR-0024. First of the
patient-page slice (Home dashboard is the next task).

## What shipped
- **Routing (hand-rolled, no dep).** `utils/router.ts` (usePath/navigate/
  matchRoute) + `utils/Link.tsx`. Real URLs, back/forward, deep links. react-router
  was intended but the npm registry (CodeArtifact) was unauthenticated here, so
  routing is ~40 lines over the History API (ADR-0024 note). Routes: `/` (workspace),
  `/patients` (list), `/patients/:id` (patient page).
- **App refactor (risk-managed).** The working capture/note state machine moved
  verbatim into `WorkspaceView.tsx` (unchanged behavior — view machine, SSE
  sessions, refresh-safe persistence, retry); `App.tsx` is now a thin router.
  Shared chrome (sidebar + top bar + a Hastalar button) extracted to `AppShell`.
  The sidebar (on any route) opens a note/job by navigating to `/?note=…`/`?job=…`,
  which the workspace consumes via a URL open-intent (on mount AND while mounted).
- **PatientListPage** — all patients w/ MRN, encounter count, last visit; search by
  name/MRN; "Yeni hasta" dialog → opens the new patient.
- **PatientPage** — header (name/MRN/#muayene/son ziyaret), a **union rollup**
  (Aktif sorunlar / Güncel ilaçlar deduped across the patient's notes), an
  **encounter timeline** (each note → opens in the workspace), and "Bu hasta için
  yeni muayene".
- **Backend:** `GET /patients` adds `last_visit_at`; `GET /patients/{id}` adds
  `problems_summary`/`medications_summary` (store `patient_rollup`, union deduped by
  case-folded name, newest-first — pure aggregation, no AI call).
- API client `getPatient` + `PatientDetail`/rollup types.

## Verified
- 4 new pytest cases (rollup union/dedup, no cross-patient leak, list count +
  last_visit). `make test` → 74 passed. Full HTTP drive of /patients + /patients/{id}
  (rollup + timeline correct). Web build + lint green (only the 2 pre-existing warns).

## Unverified without a browser (flag)
The routing refactor moved a complex working state machine — I couldn't click-test.
Please spot-check: `/` capture→note flow still works, session survives refresh,
sidebar "open note" from `/patients` navigates + opens it, back/forward, and the
patient pages render. Restart `make api` first (new /patients rollup fields).

## Deferred
"Bu hasta için yeni muayene" routes to `/?new=1&patient=<id>` but doesn't yet
PRE-SELECT the patient in the generator (would need threading the id through the
capture→note flow) — the patient is selectable in the generator for now.
Home dashboard = next task.
