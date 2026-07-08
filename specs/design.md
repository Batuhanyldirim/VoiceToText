# Design — `stt-diarization-prototype`

*How the tool works: architecture, data flow, error strategy, and how to verify
changes. Pairs with [`requirements.md`](requirements.md) (the "what") and
[`structure.md`](structure.md) (the file/stage map).*

## Architecture in one line

A cascade: **enhance → transcribe (ASR) → align → diarize → fuse → emit**, all in
`transcribe.py`, orchestrated by `main()`. WhisperX provides ASR, alignment, and
the word↔speaker fusion; pyannote provides diarization; ffmpeg provides audio I/O
and enhancement.

## Data flow

```
input file (audio or video)
   │  enhance_audio()  [default on] — ffmpeg leveling → out/<stem>.enhanced.wav
   ▼
whisperx.load_audio()  → float32 mono @16 kHz  (ffmpeg extracts audio track of video)
   │  load_model(large-v3, cpu, int8, vad_onset=0.35).transcribe(print_progress=True)
   ▼
result = { "segments": [ {start,end,text} ], "language": <detected> }
   │  load_align_model(language) + align()      [best-effort per language]
   ▼
result.segments now carry word-level timestamps   (aligned = True)  ── or skipped (aligned = False)
   │  load_diarizer(diar-model, HF_TOKEN, cpu)(audio, min, max)
   ▼
diar_df = DataFrame[segment,label,speaker,start,end]
   │  fuse:  assign_word_speakers(diar_df, result)      if aligned
   │         assign_speakers_segment_level(diar_df, result)  otherwise
   ▼
segments tagged with `speaker`
   │  build_turns() → turns[{speaker,text,start,end}] ; speaker_name() maps SPEAKER_00→"Speaker 1"
   ▼
emit(): print + write out/<stem>.txt (same pass) ; then out/<stem>.srt, out/<stem>.json
```

Key shapes are documented in [`structure.md`](structure.md#key-in-memory-shapes).

## Clinical note generation (data flow)

An optional step *after* transcription, owned by `note_core` (parallels
`stt_core`). It **mirrors the transcription job pattern exactly**: a pure core
function streams structured events through a callback; the API runs it on the
same `ThreadPoolExecutor(1)` + in-memory registry and re-emits events over SSE;
the poll endpoint is the fallback. → [`adr/0009`](adr/0009-clinical-note-pluggable-provider.md)

```
transcript text (from a completed job) + chosen template (soap | hp | free-paste)
   │  note_core.generate(transcript, NoteOptions(provider, model, template, …), progress)
   │     system = clinical-documentation prompt ; user = template + transcript
   ▼
provider (pluggable — resolved by get_provider(name)):
   ├─ OllamaProvider (DEFAULT, local)  → POST http://localhost:11434/api/chat  {stream:true, num_ctx:16384}
   ├─ ClaudeProvider (OPT-IN cloud)    → Anthropic SDK messages.stream(claude-opus-4-8)
   │      (gated: raises ProviderError unless STT_NOTE_PROVIDER=claude; no data sent when refused)
   └─ optional git-ignored plugin(s)   → _local_providers module (see "Provider plugin seam")
   ▼
streamed token deltas → NoteEvent(stage="generating", delta="…") callback
   │  API: worker thread → loop.call_soon_threadsafe → per-note asyncio.Queue → SSE (GET /notes/{id}/events)
   ▼
UI renders the note live, highlights "Klinik İnceleme Gerekli",
copy / download .md ; NoteResult{note, provider, model, stopped_early, usage} also
available via GET /notes/{id} (poll fallback)
```

Providers differ only in transport; the system/user prompt split is identical.
The note output is **Turkish** (Turkish system prompt + Turkish templates +
Turkish headings), and the whole web UI is Turkish (REQ-106). The note is a
**review draft**, never a finalized record — the UI keeps that framing and shows
an off-device (PHI) warning banner whenever the selected provider is off-device.

**Note-output reshape (REQ-114).** The prompt/templates were reshaped so **the
chosen template IS the whole note**: the note carries every clinical fact once,
under its own heading, followed by exactly **one** appended `Klinik İnceleme
Gerekli` section (uncertain/conflicting/likely-mis-transcribed items for the
clinician to confirm). This replaces the earlier mandatory A–E scaffold, whose
fixed sections duplicated content (a note *and* a separate patient summary *and* a
repeated plan). The system prompt now also carries **anti-preamble/banner rules**
(start directly with the note — no cover, blockquote, or "here's the note:"
preamble, since the draft warning already lives in the UI) and emits a
**pedigree/soyağacı block only when the family history is rich** (multiple named
relatives); a single relative stays on the family-history line. These rules apply
identically to every provider — they live in the shared system prompt, not in any
one backend. → [`adr/0009`](adr/0009-clinical-note-pluggable-provider.md) (refined)

## Provider plugin seam + selection flow

Note generation resolves its backend through `note_core.providers`, which is now a
**generic plugin seam** (REQ-111–113) rather than a hardwired pair:

- **`list_providers()`** returns the descriptors the UI may offer — `{key, label,
  models, default_model, off_device}` — filtered by an operator **allowlist**
  (`_provider_allowlist()` reads `STT_NOTE_PROVIDERS`, default `"ollama"`) *and*
  each provider's own availability. So the committed/default config exposes
  **only the local Ollama model**; anything off-device or machine-specific must be
  turned on deliberately.
- **`get_provider(name)`** maps a key to a live provider. Built-ins first
  (`ollama`; `claude` still gated behind `STT_NOTE_PROVIDER=claude`), then an
  **optional local registry consulted last**.
- **`_local_registry()`** best-effort-imports a sibling **`_local_providers`**
  module (a broken/absent plugin can never break the app) and returns its
  `{factories, descriptors}`. This is the escape hatch for **machine-specific,
  git-ignored integrations**: e.g. a provider that shells out to a locally
  authenticated CLI. None of that code is committed — the committed repo ships
  only Ollama (+ the gated first-party cloud path). `env.sh` sources an optional,
  git-ignored `env.local.sh` where such a machine sets `STT_NOTE_PROVIDERS` to
  enable its plugin.

Selection flow: the web `NoteGenerator` calls **`GET /notes/providers`** →
`{providers, default_provider}`, shows a **"Sağlayıcı"** (+ **"Model"**) selector
that is **hidden when only one provider exists** (so the default single-provider UI
is unchanged), and uses each descriptor's **`off_device`** flag to drive the PHI
warning banner. **`POST /notes`** validates the requested provider against
`list_providers()` (rejecting a disabled/bogus key up front) and fills in the
model from the chosen descriptor's `default_model` when the client omits it. The
provider is still never trusted from the browser for the *gating* decision — the
allowlist + env opt-in on the server decide what's offerable at all.

## Timing metrics (data flow)

Both durations are **measured in the worker thread** (wall clock around the actual
work), then carried outward so the UI can show them and a live counter:

```
transcription worker (jobs._run):  t0=monotonic() at start
   │  result.transcribe_seconds = round(elapsed,1)   ← set BEFORE emit.write_json
   ▼  persisted into out/<stem>.json (recoverable when the transcript is reused)
GET /jobs/{id} / GET /transcripts[/{name}]  → transcribe_seconds
   ▼  POST /notes accepts transcribe_seconds (carried from the chosen transcript)
note worker (notes._run):  job.note_seconds = round(monotonic()-t0,1)
   ▼  SavedNote{transcribe_seconds, note_seconds}  → store (SQLite, migrated columns)
GET /jobs|notes/{id}, /notes list  → both timings
   ▼
Web: "Deşifre: Xs" / "Not: Ys" chips + a model chip
```

Beyond the *final* durations, both `Job` and `NoteJob` also record **`started_at`
(epoch seconds, set at `_run` start)** alongside `created_at`. The API returns
`started_at`, and the web **`useElapsed(running, startedAtMs)`** hook anchors its
live counter to that server timestamp — so a page refresh mid-run shows the true
elapsed time instead of resetting to zero. The `note_seconds` column (and
`transcribe_seconds`) were added to a possibly-older `notes` table via a
**lightweight `ALTER TABLE` migration** in `NoteStore._init_schema` (reused
transcripts predating the feature simply carry `null`).

## Sessions sidebar, persistence + retry (data flow)

The sidebar (`NotesSidebar`, titled **"Oturumlar"** while work is active,
otherwise **"Notlarım"**) unifies **in-progress work** and **saved history** in one
list. Its data comes from three sources, active items on top, then a divider, then
the durable notes:

```
GET /jobs         → JobManager.list_active()      (queued/running/error transcriptions)
GET /notes/active → NoteJobManager.list_active()  (queued/running/error notes)
GET /notes        → NoteStore.list()              (completed, durable)
```

`list_active()` (on both managers) returns everything **not** finished
successfully — i.e. still queued/running or **failed (retryable)**; `done` items
are excluded because their result lives elsewhere (transcript screen / durable
store). The sidebar polls the two active endpoints every ~3 s so rows advance
(spinner + Turkish stage label) and drop off when done, or flip to a ⚠ +
**"Tekrar dene"** on failure.

**Retry** re-runs work without re-entering data:
`POST /jobs/{id}/retry` re-runs the transcription against the **same uploaded file
still on disk** (`JobManager.retry` returns `None` if that file is gone);
`POST /notes/{id}/retry` re-runs the note with the **same transcript + options**.
Both reset job state and re-`submit()` to the single worker.

**Refresh-safe session.** `utils/session.ts` persists a *minimal, serializable*
pointer to the current screen in `localStorage` (`vtt.session.v1`) — never heavy
or unserializable data (File objects, full results). On load, `App.tsx`
rehydrates: it re-attaches to a job's **SSE stream** (`ProgressScreen`), re-opens a
note's stream (`NoteViewer`), or **re-fetches** a finished transcript via
`getJob(jobId)`. Combined with the sidebar, an in-progress job started before a
refresh is both **restored on reload** and **returnable from the sidebar**.

**Scope (deliberately in-memory).** Both `JobManager` and `NoteJobManager` hold
active work **in memory, in the server process** — there is no active-job DB. A
`make api` restart therefore **drops in-flight jobs** (the durable *saved notes*
survive in SQLite; unfinished transcriptions/notes do not). This is acceptable for
one local single-worker user and keeps the design brokerless (ADR-0007/0008).

**Shipped robustness fixes** (architecturally relevant here):

- **Reload no longer orphans jobs.** `make api` runs uvicorn **without
  `--reload`** and **sources `env.sh`** inside the recipe (so `HF_TOKEN`,
  in-project caches, and `STT_NOTE_PROVIDERS`/the provider dropdown are always
  set). `--reload` previously watched the whole repo (incl. `.venv`) and a stray
  `.py` touch would restart the process mid-run, killing the in-memory job and its
  SSE stream. `make api-dev` keeps reload but **scopes it to source dirs only**
  (`apps/api/src`, `packages`), and a restart there is understood to drop
  in-flight work.
- **"Stuck at done" race fixed.** The pipeline (and `note_core.generate`) emit
  their own `"done"` progress event *before* `transcribe()`/`generate()` returns —
  i.e. before the result is set and output files are written. The workers
  **swallow the pipeline's `"done"`** (`_emit`) and emit the **single
  authoritative terminal `"done"`** (`_emit_terminal`) only **after `job.result`
  and `job.status` are set** — so a client reacting to `done` always finds a ready
  result instead of hanging (was visible as a large-file "stuck at done").
- **Dependency-warning noise muted.** `stt_core` mutes benign pyannote/torch
  version-mismatch warnings; the API logging config (`STT_QUIET_DEPS`, default on)
  filters the known-benign `weights_only` / `TRANSFORMERS_CACHE` /
  "was trained with" warnings so the job/note lifecycle INFO lines stay readable.

## Transcript reuse + persistent note history (data flow)

Two conveniences layer on top of note generation without touching the pipeline or
`note_core`. → [`adr/0010`](adr/0010-persistent-notes-sqlite.md)

**Reuse** — instead of uploading a file just to re-transcribe it, the note flow
can start from a transcript the CLI already produced under `out/`:

```
GET /transcripts            → list out/*.json (e.g. HistoryTaking_YA, conversation)
GET /transcripts/{name}     → that transcript's text
   ▼
POST /notes { transcript, template, … }   (same as an uploaded-file transcript)
```

This is a dev-cycle speedup: iterate on prompts/templates against a known
transcript without paying for transcription each time.

**Persistence** — the in-memory `NoteJobManager` (notes.py) owns only the
**live** lifecycle (queued → generating → done, SSE deltas). When a note
*completes*, the API writes a `SavedNote` to a project-local **SQLite** store
(`store.py`, `apps/api/notes.db`, git-ignored, `STT_DB_PATH` override):

```
note done → NoteStore.save(SavedNote{id, created_at, title, source_name,
                                     provider, model, template, transcript, note})
   ▼
GET /notes           → history list (summaries, newest first, no bodies)
GET /notes/{id}      → full saved note (falls back to the store, not just live jobs)
DELETE /notes/{id}   → remove a saved note
```

The store uses only the stdlib `sqlite3` (no new dependency) with a short-lived
connection per call; SQLite's own locking serializes the rare writes — enough for
one local single-worker user. The DB holds PHI (transcript + note), so it stays
inside the project and git-ignored: `rm -rf` still removes everything (ADR-0003)
and nothing is ever committed.

## Design decisions (why it's built this way)

Each deliberate choice has an ADR — read it before changing that area:

- **CPU-only** — CTranslate2 has no Metal/MPS. → [`adr/0001`](adr/0001-cpu-only.md) · satisfies REQ-020
- **Load-bearing version pins** — WhisperX 3.4.2 breaks on newer deps. → [`adr/0002`](adr/0002-load-bearing-version-pins.md)
- **Self-contained caches** — one-command cleanup. → [`adr/0003`](adr/0003-self-contained-caches.md) · satisfies REQ-080
- **Enhance + sensitive VAD by default** — recover quiet speakers, no flags. → [`adr/0004`](adr/0004-enhance-and-sensitive-vad-by-default.md) · satisfies REQ-030
- **Diarizer component fallback** — work without the gated meta-model. → [`adr/0005`](adr/0005-diarizer-component-fallback.md) · satisfies REQ-061
- **Clinical note pluggable provider** — local Ollama default (PHI on-device), cloud opt-in; Turkish output. → [`adr/0009`](adr/0009-clinical-note-pluggable-provider.md) · satisfies REQ-100–106
- **Persistent note history** — project-local, git-ignored SQLite (stdlib, single-user, PHI never committed). → [`adr/0010`](adr/0010-persistent-notes-sqlite.md) · satisfies REQ-107–110
- **Selectable note provider + plugin seam** — operator allowlist over a generic provider registry; machine-specific/off-device integrations stay git-ignored (`_local_providers`, `env.local.sh`); the committed repo ships only Ollama. Also covers timing metrics, the sessions sidebar, refresh-safe persistence, and retry. → [`adr/0011`](adr/0011-selectable-note-provider-plugin-seam.md) · satisfies REQ-111–113, REQ-116–119
- **Note-output reshape** — the chosen template *is* the note (+ one appended review section), anti-preamble, pedigree only when family history is rich; applies to every provider. → [`adr/0009`](adr/0009-clinical-note-pluggable-provider.md) · satisfies REQ-114–115

## Error-handling & fallback strategy

The pipeline is designed to **degrade, not crash**, on the common failure modes:

| Failure | Handling | Requirement |
|---|---|---|
| Input file missing | Error + non-zero exit before any model loads | REQ-003 |
| `HF_TOKEN` unset + diarization requested | Error + non-zero exit with guidance | REQ-062 |
| `ffmpeg` missing during enhance | Warn, fall back to original audio | REQ-032 |
| No aligner for detected language | Warn, assign speakers at segment level | REQ-051 |
| Gated diarization meta-model unavailable | Fall back to component pipeline | REQ-061 |
| `tqdm` missing | Transcribe without a progress bar | REQ-041 |

Guard checks (missing file, missing token) happen **before** heavy imports/model
loads so failures are fast and cheap.

## Diarization: two-attempt loader

`load_diarizer()` deliberately tries two paths:
1. **Meta-model** (`--diar-model`, default `pyannote/speaker-diarization-3.1`) via
   `Pipeline.from_pretrained`. Best turnkey path *if* its terms are accepted.
2. **Component pipeline** — assembles `segmentation-3.0` + `wespeaker` with the
   standard 3.1 hyper-parameters. Reproduces the meta-model without needing its
   gated repo, so diarization works with only the (already-accepted) component
   models. **Do not remove attempt 2** — see [`adr/0005`](adr/0005-diarizer-component-fallback.md).

Both paths return the same `DataFrame` shape via `_wrap_pipeline()` +
`diarize_dataframe()`, so downstream fusion is identical.

## Fusion: word-level vs segment-level

- **Word-level** (`whisperx.assign_word_speakers`) — used when alignment
  succeeded; assigns each word the speaker whose diarization segment overlaps it
  most. Highest quality.
- **Segment-level** (`assign_speakers_segment_level`) — fallback when alignment
  was skipped; assigns each whole ASR segment the speaker with the greatest time
  overlap. Coarser but keeps labels for unaligned languages.

## Output contract

`emit()` is a single closure that both `print()`s and `f.write()`s each line, so
the terminal and `out/<stem>.txt` are byte-for-byte the same and the file fills
in live (REQ-071). `.srt` and `.json` are written afterward from the same
`turns`/`segments` data. Never let the terminal and `.txt` diverge — route both
through `emit()`.

## Conventions (enforced, not incidental)

- Status → `log()` (`[transcribe] ` prefix). Transcript → `emit()`.
- Heavy imports are lazy (inside functions) so `--help` is dependency-free (REQ-042).
- Outputs named after the input stem, into `out/` (or `--out-dir`).
- Single-file module; add helpers rather than new files unless a change is large.

## Testing strategy

There is **no unit-test suite**; this is a prototype and the models are the hard
part. Verification is behavioral and lives in the **verification gate** in
[`requirements.md`](requirements.md#verification-gate):

```bash
source env.sh && bash make_sample.sh && python transcribe.py samples/conversation.wav
```

PASS = `out/conversation.txt` has the header and ≥ 2 distinct `Speaker N` turns.
Any change (feature or refactor) must still pass this gate; run with
`--model small` for a faster loop. When adding behavior, add the matching
`REQ-###` first, then extend the gate if the new behavior is observable.
