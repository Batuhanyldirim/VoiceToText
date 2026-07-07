# stt-web — web frontend

A Vite + React + TypeScript + MUI single-page app for the STT + diarization tool:
**upload a file → watch live progress → read the transcript → download**, then
optionally **generate a Turkish clinical note draft** from that transcript. The
UI is **Turkish throughout**. No terminal needed. It talks to the local API
(`apps/api`) over HTTP — it contains no ML code and never sees `HF_TOKEN` or the
cloud note token.

The note flow can start from a **fresh upload** or **reuse** a transcript the CLI
already produced in `out/` (a dev-cycle speedup), and completed notes are saved to
a persistent **history** you can browse. → [ADR-0010](../../specs/adr/0010-persistent-notes-sqlite.md).

> This is a **separate npm project**, not part of the Python uv workspace and not
> pnpm. It does **not** need `env.sh`. See
> [`../../specs/adr/0006-monorepo-uv-workspace.md`](../../specs/adr/0006-monorepo-uv-workspace.md).

## Setup + run (dev)

```bash
cd apps/web
npm install
npm run dev            # Vite dev server on http://localhost:5173
```

Start the API first (in another terminal) so the UI has a backend:

```bash
source env.sh
.venv/bin/python -m uvicorn stt_api.main:app --host 127.0.0.1 --port 8000
```

The API base URL is set in [`src/config/api.ts`](src/config/api.ts)
(`http://127.0.0.1:8000`), and the API allows the Vite dev origin
(`http://localhost:5173`) via CORS.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server with HMR on `:5173` |
| `npm run build` | Type-check (`tsc -b`) + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | Oxlint |

## Screens

| Screen | What it does | API used |
|---|---|---|
| **Upload** | Pick / drag an audio or video file and (optionally) set options (model, language, speaker bounds, diarize on/off), then submit. | `POST /jobs` |
| **Progress** | Live stage + percent while the job runs (transcribe %, then align/diarize/fuse), with a poll fallback. | `GET /jobs/{id}/events` (SSE) · `GET /jobs/{id}` |
| **Transcript viewer** | Speaker-labeled turns (`Speaker 1/2/…`) with timestamps; detected language and speaker count; download buttons. | `GET /jobs/{id}` · `GET /jobs/{id}/download/{fmt}` |
| **Source picker** | *(before generating a note)* reuse an existing `out/` transcript (e.g. `HistoryTaking_YA`) instead of re-uploading — a dev-cycle speedup. | `GET /transcripts` · `GET /transcripts/{name}` |
| **Template picker + NoteGenerator** | *(after the transcript)* pick a note template — "SOAP notu", "Öykü ve Muayene (Ö&M)", or paste a serbest-metin sample format — then generate. | `GET /notes/templates` · `POST /notes` |
| **NoteViewer** | Live-streamed **Turkish** clinical note (sections A–E); highlights the **"Klinik İnceleme Gerekli"** section; copy + download `.md`. Shows a **cloud warning banner** when the cloud provider is enabled (the transcript is sent off-device). The note is a **draft for clinician review**, never a finalized record. | `GET /notes/{id}/events` (SSE) · `GET /notes/{id}` |
| **History** | Browse saved notes (newest first) — open one in full, delete it, or start a new one. Notes persist across server restarts (project-local SQLite `apps/api/notes.db`, git-ignored, holds PHI). | `GET /notes` · `GET /notes/{id}` · `DELETE /notes/{id}` |

## Stack

- **Vite** (dev server + build) · **React 19 + TypeScript** · **MUI (Material UI)**
  with Emotion.
- Typed API client + domain types live in [`src/config/api.ts`](src/config/api.ts)
  and [`src/types.ts`](src/types.ts); the backend contract is the endpoint table
  in [`../api/README.md`](../api/README.md).

## Notes

- Privacy: the API binds `127.0.0.1` and runs everything locally; nothing leaves
  the machine. The browser never handles `HF_TOKEN` or the cloud note token.
- Clinical notes are generated **locally by default** (Ollama) and in **Turkish**.
  The cloud provider (Claude) is an opt-in the operator enables in server env —
  when it's on, the NoteViewer shows a banner warning that the transcript is sent
  off-device. See [ADR-0009](../../specs/adr/0009-clinical-note-pluggable-provider.md).
- Note history is persisted server-side to a project-local SQLite DB
  (`apps/api/notes.db`) that holds PHI and is git-ignored; the browser only reads
  it via the `GET /notes` endpoints. See [ADR-0010](../../specs/adr/0010-persistent-notes-sqlite.md).
- Build artifacts (`dist/`, `.vite/`) and `node_modules/` are git-ignored.
