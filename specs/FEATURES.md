# FEATURES — VoiceToText (stt-diarization-prototype)

> **The authoritative, living list of what this product does.** Keep this current
> as features land or change — it is the single place a new contributor (human or
> agent) reads to understand the whole feature set. Deep rationale is in the ADRs
> (`specs/adr/`); exact behavior contracts are in `specs/requirements.md` (REQ-###);
> per-feature build notes are in `specs/tasks/`.

## What this is (one paragraph)

A **local, private, single-doctor** clinical tool that turns an audio/video
recording of a patient encounter into a **speaker-labeled transcript** and then a
**structured, editable clinical note** — organized by **patient**. Everything runs
**on this machine** (CPU transcription; local LLM by default) so PHI never leaves
the device unless the operator explicitly opts into a cloud model. UI + notes are
**Turkish**. It ships as shared pipeline libraries (`stt_core`, `note_core`) plus
thin CLI/API/web wrappers.

## The core flow (voice → text → note → record)

```
audio/video  ──►  TRANSCRIBE (stt_core)  ──►  transcript (speaker-labeled turns)
   (upload /        enhance → ASR (whisperx/                │
    record /         faster-whisper) → align →              │
    live stream)     diarize (pyannote) → fuse              ▼
                                                    GENERATE NOTE (note_core)
                                                    local LLM (Ollama) by default,
                                                    Turkish, chosen template IS the
                                                    note + "Klinik İnceleme Gerekli"
                                                    review section; problems+meds
                                                    extracted in the SAME call
                                                              │
                                                              ▼
                                                    REVIEW & FILE: edit, finalize,
                                                    assign patient, export, listen
                                                    to source audio, versions
```

**How the transcription itself works** (the pipeline, all CPU, all local):
1. **Enhance** — ffmpeg leveling (high-pass + speechnorm + dynaudnorm + loudnorm)
   so a quiet/far speaker isn't dropped (default on; skipped in live-stream mode).
2. **ASR** — whisperx / faster-whisper (`large-v3`, `int8`, CPU), language auto-detected.
3. **Align** — wav2vec2 forced alignment for word-level timestamps (best-effort per language).
4. **Diarize** — pyannote (meta-model, with a component-pipeline fallback) labels speakers.
5. **Fuse** — assign speakers to words/segments → `Speaker 1/2/…` turns in stable order.
The success gate: a transcript with **≥ 2 distinct speakers**. CPU-only by design
(CTranslate2 has no Metal/MPS). Version pins are load-bearing.

## Three ways to get a transcript
- **Upload** an audio/video file (`.wav/.mp3/.m4a/.flac/.ogg/.aac/.mp4/.mov/.mkv/.webm/.avi`).
- **Record** in the browser (MediaRecorder → File → the SAME upload path). *(ADR-0013)*
- **Live (streaming) transcription** — transcribe *while* recording: the browser
  streams raw PCM (AudioWorklet), the server transcribes silence-cut chunks
  incrementally and diarizes once at finish, so the wait after "stop" is short.
  Local-only (no cloud speech API); ~99% accuracy parity with one-shot; enhancement
  skipped as a tradeoff. *(ADR-0014)*
- Or **reuse** an existing CLI transcript from `out/*.json` (no re-transcription).

## Feature list (shipped)

### Transcription
- **Speaker-diarized transcription** — the core pipeline above (CLI + API + web).
  **Turkish-forced by default** (override with `auto`/another code), **soft 2-speaker
  cap** (doctor+patient, raisable); downloads as **txt / srt / json**.
  *(REQ-001–097, REQ-135–137; ADR-0001–0008, ADR-0027)*
- **In-app voice recording** and **live streaming transcription** (above).
  *(ADR-0013, ADR-0014)*
- **Live progress** over SSE (stage + %); refresh-safe elapsed timer.
- **Accuracy measurement + tuning** — a local Turkish WER/CER/cpWER/DER eval harness
  (`make eval`, FLEURS public benchmark + hand-labeled clinical set) drives
  quick-win tuning: forced-`tr` default (accuracy-neutral, ~30% faster on large-v3),
  speaker-count hints, and an opt-in Turkish clinical `initial_prompt` biasing seam.
  *(REQ-135–139, REQ-167–170; ADR-0026, ADR-0027, ADR-0028)*

### Clinical notes
- **Note generation** — transcript → structured **Turkish** clinical note via a
  **pluggable AI provider** (local Ollama default; Claude opt-in, gated). The
  chosen template (SOAP / Öykü&Muayene / a pasted "free" format) **is** the note,
  plus one appended **"Klinik İnceleme Gerekli"** review section that flags
  ambiguities / likely mis-transcriptions instead of silently fixing them. PHI
  stays local on the default path. *(REQ-100–106,114; ADR-0009, ADR-0011)*
- **Selectable provider/model** — picker shown when >1 provider enabled
  (`STT_NOTE_PROVIDERS` allowlist); off-device choice drives a PHI warning banner.
  *(REQ-111–113; ADR-0011)*
- **Formatted rendering** — notes render as real Markdown (headings/bold/lists),
  not raw source.
- **Editable + finalizable** — edit the note (edits are an **overlay**; the AI
  original is never overwritten), **Tamamla/İmzala** to lock it as a final record,
  **Yeniden aç** to edit again, **revert to AI draft**. *(REQ-132–136; ADR-0015)*
- **Autosave + version history** — debounced autosave while editing; every prior
  saved body is snapshotted; **"Sürüm geçmişi"** to view/restore. *(REQ-147–149;
  ADR-0020)*
- **Custom templates** — save/edit/delete your own reusable note formats
  ("Şablonlar"); they appear in the picker and resolve to a saved "free" sample.
  *(REQ-150–152; ADR-0021)*
- **Problem & medication extraction** — a structured problem list + medication
  list (name/dose/route/frequency), Turkish, grounded-only-in-the-note, extracted
  in the **same generation call** (no extra AI cost; re-runnable after edits with
  "Yeniden çıkar"). *(REQ-156–159; ADR-0023)*
- **Audio-linked source transcript** — the note page has a **"Kaynak deşifre"**
  panel: the source turns with timestamps, and (when the recording is kept) a
  player where **clicking a turn plays that moment** — verify an ambiguous passage
  against the original audio. *(REQ-143–146; ADR-0019)*
- **Speaker re-assignment for merged diarization** — when acoustic diarization
  collapses two similar voices (rapid doctor↔patient Q&A) into one speaker, a
  **"Konuşmacıları yeniden ata"** action on the review page uses the **local LLM's
  conversational logic** (doctor-asks/parent-answers) to re-label each turn's
  speaker — measured 3→88/100 coherence (Opus-judge) on a real intake. Reviewable +
  fail-closed; touches only the transcript. Also: diarization now runs on **raw
  (un-enhanced) audio** by default (better separation), records a
  `raw_diar_speakers` merge diagnostic, and exposes clustering knobs.
  *(REQ-176–181; ADR-0030)*
- **STT-error review & correction** — the note flags likely mistranscriptions
  (misheard drug/dose/negation/name) as **structured, located** review flags (same
  single generation call, no extra AI cost). A dedicated **review page**
  (`/notes/:id/review`) highlights the flagged turns over the raw transcript,
  **plays the flagged audio moment** on click, and lets the doctor **correct the
  transcript turn** against what was actually said — resolving the flag and
  capturing a human-verified correction (a future training label). Corrections
  touch only the transcript, never the note body. *(REQ-171–175; ADR-0029)*
- **Export** — **PDF** (browser print), **EHR için kopyala** (clean plain text),
  Markdown copy, `.md` download. *(REQ-142)*

### Organization & navigation
- **Patients** — a lightweight patient entity; file a note under a patient (name
  reuse, optional MRN); (re)file allowed even on a finalized note. *(REQ-137–140;
  ADR-0016)*
- **Encounter metadata** — capture patient + **visit type** + **chief complaint**
  up front; notes auto-title from the complaint; searchable. *(REQ-153–155;
  ADR-0022)*
- **Search & filter** — search notes by title / patient / body / complaint / visit
  type; filter by patient. *(REQ-141; ADR-0018)*
- **Persistent history** — completed notes saved to a project-local, git-ignored
  SQLite DB; browsable/deletable. *(REQ-107–110; ADR-0010)*
- **Sessions sidebar** — in-progress + failed work (returnable, **retryable**,
  refresh-safe) above saved notes; timing chips (Deşifre/Not seconds). *(REQ-115–119;
  ADR-0011, ADR-0012)*
- **Home / "Bugün" dashboard** (`/`) — today's encounters, resume in-progress,
  unsigned drafts, quick stats. *(REQ-164–166; ADR-0025)*
- **Patient list** (`/patients`) + **patient page** (`/patients/:id`) — the
  patient page shows a header, an **encounter timeline**, and a **union rollup** of
  the patient's problems/medications across all their notes (no extra AI call).
  *(REQ-160–163; ADR-0024)*
- **URL routing** — bookmarkable `/`, `/yeni` (capture/note workspace),
  `/patients`, `/patients/:id`; labeled Ana Sayfa / Hastalar / Yeni muayene nav.
  *(ADR-0024, ADR-0025)*

## Cross-cutting properties (always true)
- **Local-first / PHI on-device.** CPU transcription; local LLM by default; the
  notes DB + source audio are project-local and **git-ignored**; off-device
  providers are opt-in only. *(ADR-0003, ADR-0009)*
- **Turkish** UI + note output throughout. *(REQ-106)*
- **In-memory jobs.** Active transcriptions/notes/streams live in the server
  process — a restart drops in-flight work; only *completed* notes persist. *(ADR-0008, ADR-0012)*
- **Tests.** A fast pytest suite (`make test`, no ML models, temp DB) covers the
  store + API/note-core logic; the ML pipeline stays under the behavioral gate
  (`make verify`, the ≥2-speaker sample). *(ADR-0017)*

## Where things live
- Pipeline: `packages/core` (`stt_core`), `packages/note-core` (`note_core`).
- API: `apps/api` (FastAPI; `main.py` endpoints, `store.py` SQLite, `jobs.py`/
  `notes.py`/`stream.py` workers). Web: `apps/web` (Vite+React+TS+MUI).
- Run: `make api` + `make web`; tests: `make test`; pipeline gate: `make verify`.
  Always `source env.sh` first for Python (venv + HF_TOKEN + in-project caches).
