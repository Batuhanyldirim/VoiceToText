# ADR-0025 — Home dashboard + visible primary navigation

**Status:** Accepted · **Relates to:** REQ-164–REQ-166, ADR-0024, `apps/web/src/App.tsx`, `apps/web/src/components/HomePage.tsx`, `apps/web/src/components/AppShell.tsx`

## Context

After adding patient pages (ADR-0024) two gaps showed:
1. **No landing page.** `/` was the capture screen — the app opened straight into
   "upload a file", with no overview of today's work, in-progress runs, or
   unsigned drafts.
2. **Hastalar was hard to find** — it was a bare, unlabeled top-bar icon. The user
   flagged it as not discoverable.

Both are navigation/shell concerns, done together.

## Decision

Add a **home dashboard at `/`**, move the capture flow to **`/yeni`**, and add
**clearly-labeled primary navigation** in the shell.

- **Routing (extends ADR-0024's hand-rolled router).**
  - `/` → `HomePage` (the dashboard).
  - `/yeni` → the capture/note `WorkspaceView` (unchanged; the sidebar's "new"/
    open-note intents and the logo now target `/yeni`).
  - `/patients`, `/patients/:id` → unchanged.
- **HomePage — composed from EXISTING endpoints (no new backend, REQ-166):**
  - primary **"Yeni muayene"** CTA → `/yeni`.
  - **Bugünkü muayeneler** — `GET /notes` filtered to `created_at` = today.
  - **Devam eden** — `GET /jobs` + `GET /notes/active` (resume in-progress).
  - **İncelenmesi gerekenler** — draft (unsigned) notes from `GET /notes`
    (`status !== "final"`), newest first, capped.
  - **quick stats** — patient count (`GET /patients`), notes this week (`GET /notes`).
  Each item links to where it lives (a note → `/yeni?note=…`, a patient → its page).
- **Navigation (AppShell).** Replace the bare icon with labeled entries — **Ana
  Sayfa**, **Hastalar**, and a prominent **Yeni muayene** — shown in the sidebar
  header (and/or the top bar) with active-route highlighting via `usePath()`. The
  sidebar's note history stays below.

Out of scope: real analytics/charts, "review flags" that require parsing note
bodies (drafts are a good-enough attention signal), and per-user customization.

## Consequences

- ✅ Opening the app gives an at-a-glance "what's today / what needs finishing"
  view, not a cold upload box; a natural hub to reach patients/new-visit.
- ✅ Hastalar + Ana Sayfa are labeled, persistent, and highlight the active route —
  the discoverability fix the user asked for.
- ✅ Zero backend: the dashboard reuses endpoints we already have, grouping
  client-side — fast to ship, nothing new to maintain.
- ➖ The capture flow's URL changed (`/` → `/yeni`); the workspace's session-restore
  + open-intent handling move with it (must keep working). A bookmark of the old
  `/` now lands on Home, which is a reasonable default.
- ⚠️ Keep the dashboard read-only/aggregating; don't add note-body parsing for
  "attention" (drafts suffice). Preserve the workspace behavior when it moves to
  `/yeni`.
