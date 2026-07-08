# Task: Audio-linked source transcript on the note page

**Status:** IMPLEMENTED on `feat/audio-linked-transcript`. REQ-143–146, ADR-0019.
The new feature the user requested: verify an ambiguous note passage against the
original recording without leaving the note.

## What shipped
- **store.py** — `notes.transcript_json` column (turns as JSON; `SavedNote.turns`
  parses it) + `NoteAudioStore` (durable, note-keyed, git-ignored source-audio
  store; `save_from`/`path`/`delete`; note-id path-safety — alphanumeric only).
- **notes.py** — the note worker persists `transcript_json` and copies the source
  audio (best-effort, via an injected `audio_resolver` + `NoteAudioStore`).
- **jobs.py / stream.py** — `source_audio_path()` on both managers; the stream
  worker writes `recording.wav` (via new `StreamingTranscriber.write_wav`) so a
  note from a live stream also has copyable audio.
- **main.py** — `POST /notes` accepts `transcript_json` + `audio_source_id`;
  `GET /notes/{id}` carries `turns` + `has_audio`; `GET /notes/{id}/audio` streams
  (range-enabled → seek); `DELETE /notes/{id}` removes the audio too. `note_audio/`
  git-ignored.
- **Web** — `NoteGenerator`/`App` pass turns + audio_source_id; `SourceTranscript`
  ("Kaynak deşifre") panel: turns list (speaker chip + timestamp + text), an
  `<audio>` player when audio exists, click-a-turn → seek/play, active-turn
  highlight synced to playback. Degrades to transcript-only when no audio.

## Verified
- 10 new pytest cases (transcript_json/turns parse, NoteAudioStore save/path/
  delete/one-file/bad-id/missing-source, endpoint turns+has_audio, audio served +
  deleted-with-note, no-turns). `make test` → 43 passed.
- Full HTTP flow on a live server: turns + has_audio, audio streams (200,
  audio/wav), range → 206 (seek), delete → 404, path traversal → 404.
- Web build + lint green.
- Adversarial multi-agent review: the 4 review agents STALLED out (each burned
  ~500–700K tokens reading the large diff, hit the retry limit) — an
  infrastructure failure, NOT a clean bill. Compensated with a focused MANUAL pass
  over all 4 dimensions, found no defects:
  · path-safety: `_safe_id` `.isascii()` guard verified to reject unicode digits/
    letters that `.isalnum()` alone would allow (Arabic-indic, superscript, roman);
    traversal/space/dot rejected. Endpoint traversal → 404 (HTTP-verified).
  · lifecycle: `_persist_audio` + `save_from` are fully try/except-guarded — a bad
    source only logs, never fails the note; media map has an octet-stream fallback.
  · data-integrity: migration idempotent (3× re-run), turns round-trip + re-save
    OK; live-job (still-generating) get_note branch references no saved-only field.
  · frontend: audio_source_id resolves for BOTH upload jobs and streams (streamId
    → stream_manager.source_audio_path); panel hides w/o turns, transcript-only
    w/o audio.

## Graceful degradation
Reused `out/` transcripts and pre-feature notes have no turns/audio → the panel
is hidden or shows transcript-only. Audio copy is best-effort — a cleaned scratch
source just means no audio, never a failed note.
