# ADR-0019 — Audio-linked source transcript on the note page

**Status:** Accepted · **Relates to:** REQ-143–REQ-146, ADR-0010, ADR-0003, ADR-0008, ADR-0013, ADR-0014, `apps/api/src/stt_api/store.py`, `apps/api/src/stt_api/notes.py`, `apps/api/src/stt_api/main.py`, `apps/web/src/components/NoteViewer.tsx`

## Context

ASR isn't perfect — the model mishears drug names, mislabels speakers, or garbles
a passage (the note prompt already flags these under "Klinik İnceleme Gerekli").
When a clinician reviewing the note hits an ambiguous line, the fastest way to
resolve it is to **hear the original audio** at that spot. Today the note is
divorced from its source: the transcript text is flattened into the prompt and the
recording lives in transient job scratch (`apps/api/jobs/<id>/`) that gets cleaned.

We want: on the note page, show the **source transcript** (speaker turns with
timestamps) and, when we still have the recording, let each turn be **clicked to
play that moment**. It must degrade gracefully — reused `out/` transcripts and
notes made before this feature have no audio, and that's fine.

Two design questions:
1. **Where does the audio come from / live?** The source audio exists on disk at
   note-generation time (the upload at `jobs/<id>/input.<ext>`, or a stream's
   finalized wav). But job scratch is ephemeral. So we must **copy** it into a
   durable, note-keyed store when the note is persisted — otherwise the link
   breaks as soon as scratch is cleaned.
2. **How is the transcript carried?** The note is generated from flattened text,
   but the structured turns (speaker/start/end) exist in the `JobResult`. We
   persist those turns as JSON on the note so the panel can render + seek.

## Decision

Persist the **structured transcript** on the note and **copy the source audio**
into a durable, git-ignored, note-keyed store; expose both on the note APIs.

- **Transcript (`transcript_json`):** a new nullable TEXT column on `notes`
  holding the JSON array of turns `[{speaker, text, start, end}]`. `POST /notes`
  accepts `transcript_json` (the web sends `result.turns`); the worker persists
  it; `GET /notes/{id}` returns `turns`. Absent → the panel is hidden.
- **Audio store:** a project-local, **git-ignored** `note_audio/` dir
  (`STT_NOTE_AUDIO_DIR` override), keyed `note_audio/<note_id>.<ext>`. `POST /notes`
  accepts an optional **`audio_source_id`** (the originating job or stream id).
  At note-persist time the worker resolves that id to the on-disk source
  (`jobs/<id>/input.*` or `jobs/stream-<id>/*.wav`) and **copies** it into the
  store (best-effort — a missing/cleaned source just means no audio, never a
  failure). `GET /notes/{id}/audio` streams it with the right content-type and
  supports range requests (so the `<audio>` element can seek).
- **Streaming source audio (REQ-144 enabler):** `StreamingTranscriber.finish()` /
  the stream worker writes the accumulated PCM to a `.wav` in the session dir, so
  a note generated from a live stream also has a copyable source.
- **Cleanup (REQ-146):** `DELETE /notes/{id}` also deletes `note_audio/<id>.*`.
  The store is inside the project and git-ignored, so `rm -rf` still cleans up and
  audio (PHI) is never committed (ADR-0003/0010).
- **Web:** `NoteViewer` shows a **"Kaynak deşifre"** panel — the turns list
  (speaker chip + text + `mm:ss`), an `<audio>` player fed from
  `GET /notes/{id}/audio` **only if** the note reports audio; clicking a turn sets
  `audio.currentTime = turn.start` and plays. No audio → transcript-only panel.

Out of scope: re-transcribing/segment editing from the panel, word-level
highlighting synced to playback, and waveform visualization.

## Consequences

- ✅ A note becomes **verifiable against its recording** — the ambiguous-passage
  workflow the user asked for, without leaving the note page.
- ✅ Durable: audio is copied out of ephemeral scratch into a note-keyed store, so
  the link survives cleanup; deletion removes it; nothing PHI is committed.
- ✅ Graceful: reused/old notes (no audio, maybe no turns) just show less — the
  panel/player appear only when the data exists.
- ➖ Audio is **duplicated** (job scratch + note store) until scratch is cleaned —
  acceptable for a local single user; Opus/wav of a consult is modest, and it's
  the price of durability.
- ➖ `transcript_json` stores the turns a second time (they're also in the note's
  source), but denormalizing onto the note keeps `GET /notes/{id}` self-contained.
- ⚠️ Copy audio **best-effort** — never fail note generation because the source is
  gone. Serve `/audio` with **path safety** (note-id-keyed filename only, no
  traversal). Keep `note_audio/` **git-ignored** (PHI) and delete it with the note.
