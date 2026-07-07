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
provider (pluggable):
   ├─ OllamaProvider (DEFAULT, local)  → POST http://localhost:11434/api/chat  {stream:true, num_ctx:16384}
   └─ ClaudeProvider (OPT-IN cloud)    → Anthropic SDK messages.stream(claude-opus-4-8)
        (gated: raises ProviderError unless STT_NOTE_PROVIDER=claude; no data sent when refused)
   ▼
streamed token deltas → NoteEvent(stage="generating", delta="…") callback
   │  API: worker thread → loop.call_soon_threadsafe → per-note asyncio.Queue → SSE (GET /notes/{id}/events)
   ▼
UI renders the note live (sections A–E), highlights "Clinician Review Needed",
copy / download .md ; NoteResult{note, provider, model, stopped_early, usage} also
available via GET /notes/{id} (poll fallback)
```

Providers differ only in transport; the system/user prompt split is identical.
The note is a **review draft**, never a finalized record — the UI keeps that
framing and shows a cloud warning banner whenever the cloud provider is enabled.

## Design decisions (why it's built this way)

Each deliberate choice has an ADR — read it before changing that area:

- **CPU-only** — CTranslate2 has no Metal/MPS. → [`adr/0001`](adr/0001-cpu-only.md) · satisfies REQ-020
- **Load-bearing version pins** — WhisperX 3.4.2 breaks on newer deps. → [`adr/0002`](adr/0002-load-bearing-version-pins.md)
- **Self-contained caches** — one-command cleanup. → [`adr/0003`](adr/0003-self-contained-caches.md) · satisfies REQ-080
- **Enhance + sensitive VAD by default** — recover quiet speakers, no flags. → [`adr/0004`](adr/0004-enhance-and-sensitive-vad-by-default.md) · satisfies REQ-030
- **Diarizer component fallback** — work without the gated meta-model. → [`adr/0005`](adr/0005-diarizer-component-fallback.md) · satisfies REQ-061
- **Clinical note pluggable provider** — local Ollama default (PHI on-device), cloud opt-in. → [`adr/0009`](adr/0009-clinical-note-pluggable-provider.md) · satisfies REQ-100–105

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
