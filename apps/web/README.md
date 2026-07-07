# stt-web — web frontend

A Vite + React + TypeScript + MUI single-page app for the STT + diarization tool:
**upload a file → watch live progress → read the transcript → download**. No
terminal needed. It talks to the local API (`apps/api`) over HTTP — it contains
no ML code and never sees `HF_TOKEN`.

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

## Stack

- **Vite** (dev server + build) · **React 19 + TypeScript** · **MUI (Material UI)**
  with Emotion.
- Typed API client + domain types live in [`src/config/api.ts`](src/config/api.ts)
  and [`src/types.ts`](src/types.ts); the backend contract is the endpoint table
  in [`../api/README.md`](../api/README.md).

## Notes

- Privacy: the API binds `127.0.0.1` and runs everything locally; nothing leaves
  the machine. The browser never handles `HF_TOKEN`.
- Build artifacts (`dist/`, `.vite/`) and `node_modules/` are git-ignored.
