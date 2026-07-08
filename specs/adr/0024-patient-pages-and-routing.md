# ADR-0024 — Patient pages + client-side routing (react-router)

**Status:** Accepted · **Relates to:** REQ-160–REQ-163, ADR-0016, ADR-0022, ADR-0023, `apps/web/src/App.tsx`, `apps/web/src/pages/*`, `apps/api/src/stt_api/main.py`

## Context

We have the patient/encounter *data* (patients table, notes linked with metadata,
per-note extracted problem/med lists) but no pages built around it — everything is
one sidebar list + the capture/note workspace. A doctor needs to **browse patients**
and see **one patient's whole picture** (their visits + a current problem/med view).
This is the "encounter reframe" step of the roadmap.

Decisions taken (with the user):
- **Build the patient list + patient page first** (home dashboard later).
- **Rollup = union**: the patient page's current-problems/current-meds view is the
  de-duplicated **union** of the per-note extractions (ADR-0023) — no extra AI call
  (an AI-reconciled summary was considered and deferred as costlier).
- **Real routing with URLs** — bookmarkable `/patients/:id`, working back/forward —
  chosen over ad-hoc view state for a proper multi-page feel.
  **Implementation note:** react-router was the intended library, but the npm
  registry (private CodeArtifact) was un-authenticated in this environment, so it
  couldn't be installed. Rather than block, routing is a **tiny hand-rolled hook**
  over the browser History API (~40 lines, `router.tsx`): `useRoute()` +
  `navigate()` + a `<Link>`, giving real URLs, back/forward, and deep links with
  **no dependency** — consistent with the repo's minimal-deps ethos (cf. the
  hand-rolled Markdown renderer, ADR-... , and print-to-PDF). If react-router is
  wanted later it can replace this hook without changing the page components.

The risk: `App.tsx` holds a complex, working capture→note state machine (SSE
sessions, refresh-safe persistence, retry, all the note screens). A routing refactor
must **not** rebuild or destabilize it.

## Decision

Add react-router and three routes, keeping the existing workspace intact and adding
patient pages beside it. Compute the rollup server-side.

- **Routing/layout.** A `BrowserRouter` with a shared layout: the persistent
  `NotesSidebar` stays as chrome; the main pane is routed:
  - `/` → the **existing** capture/note experience, extracted verbatim into a
    `WorkspaceView` component (the current `App` body, unchanged behavior — its
    `view` state machine, session persistence, retry all move as-is).
  - `/patients` → `PatientListPage`.
  - `/patients/:id` → `PatientPage`.
  The sidebar's "open note/patient" and "new note" actions become route
  navigations. Deep links + back/forward work.
- **Backend rollup (REQ-163).** `GET /patients/{id}` gains `problems_summary` and
  `medications_summary`: iterate the patient's notes, collect each note's stored
  `problems`/`medications` (ADR-0023), **de-duplicate by normalized name** (first
  occurrence wins, keeping its detail), and return the merged lists. Pure store
  aggregation — no model call; empty when no note has extractions.
- **Patient list.** `GET /patients` already returns name/mrn/note_count; add
  `last_visit_at` (max note created_at per patient) so the list can show recency.
- **Patient page content.** Header (name, MRN, #encounters, last visit); rollup
  panel (Aktif sorunlar / Güncel ilaçlar from the union); encounter timeline (each
  note card → opens `/` note view); "Bu hasta için yeni muayene" (routes to capture
  with the patient pre-selected).

Out of scope here: the Home dashboard (next slice), patient demographics beyond
name+MRN, editing/merging patients, and AI-reconciled (vs union) rollup.

## Consequences

- ✅ The tool becomes patient-centric and longitudinal: browse patients, see one
  patient's visits + current problems/meds in one place — the standout being the
  cross-note rollup, built from data we already store (no new AI cost).
- ✅ Bookmarkable URLs + back/forward; a real app shell.
- ✅ The working capture/note machine is **moved, not rewritten** (mounted at `/`),
  minimizing regression risk.
- ➖ Adds react-router (one dependency) + a navigation refactor of `App.tsx`.
- ➖ Union rollup can show a med the patient later stopped (no reconciliation);
  acceptable as a "everything mentioned across visits" view, and re-extraction keeps
  per-note lists current. AI reconciliation can be a later ADR.
- ⚠️ Preserve the workspace's session-persistence/refresh behavior when moving it
  under a route. Rollup is pure aggregation — never call the model for it. Patient
  data is PHI (git-ignored DB, ADR-0010).
