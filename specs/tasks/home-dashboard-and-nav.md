# Task: Home dashboard + visible navigation

**Status:** DONE on `feat/home-and-nav`. REQ-164–166, ADR-0025. Covers the home
page AND the "Hastalar not findable" fix (both are shell/nav concerns).

## What shipped
- **Routing.** `/` → Home dashboard; `/yeni` → the capture/note workspace (moved
  from `/`, behavior unchanged — WorkspaceView's open-intent + session restore now
  key off `/yeni`); `/patients`, `/patients/:id` unchanged.
- **HomePage** ("Bugün") — composed from EXISTING endpoints (no new backend):
  primary "Yeni muayene" CTA; quick stats (bugünkü muayene, bu hafta not, hasta
  sayısı, devam eden); a "Devam eden" resume card (jobs + active notes); "Bugünkü
  muayeneler"; "İncelenmesi gerekenler" (unsigned drafts). Rows link into the
  workspace/patient pages.
- **Navigation discoverability (the fix).** AppShell now shows **labeled** primary
  nav with active-route highlight: a prominent "Yeni muayene" button + "Ana Sayfa"
  + "Hastalar" in the sidebar header, mirrored as labeled buttons in the top bar
  (replaces the bare unlabeled icon). Logo → Home.

## Verified
- make test → 74 passed (no backend change). All 4 endpoints HomePage uses exist.
  Web build + lint green (only the 2 pre-existing TranscriptViewer warnings).

## Unverified without a browser (flag)
Routing moved capture from `/` to `/yeni`; the workspace state machine + session
restore + sidebar open-intent were updated to match but need a live spot-check:
Home renders + stats, "Yeni muayene"/nav navigate, opening a note from Home or the
sidebar lands in the workspace, back/forward, and the capture→note flow still works.
Restart `make api` (no new endpoints, but ensure a current server).

## Scope note
"Needs attention" = unsigned drafts (didn't parse note bodies for review flags —
deferred, drafts are a good-enough signal). Home is read-only aggregation.
