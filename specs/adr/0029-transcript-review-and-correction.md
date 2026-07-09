# ADR-0029 — STT-error review: structured flags + audio-linked transcript correction

**Status:** Accepted · **Relates to:** REQ-171–REQ-175, ADR-0009, ADR-0015, ADR-0019, ADR-0023, `packages/note-core/src/note_core/{prompt,generate,review,normalize_tr}.py`, `apps/api/src/stt_api/{store,notes,main}.py`, `apps/web/src/components/{TranscriptReviewPage,NoteViewer}.tsx`

## Context

The note prompt already asks the model to flag likely transcription errors and
ambiguities in the prose **"Klinik İnceleme Gerekli"** section (misheard drug
names, wrong doses, dropped negations, wrong names/dates). That guidance is
generated on every note but buried in text — a doctor can't act on it efficiently,
and there was **no way to correct the transcript itself** (only the note body is
editable — ADR-0015). We want: surface those flags as structured, clickable items;
let the doctor **jump the audio to the flagged moment** to hear what was actually
said; and **correct the transcript turn** in place — turning the model's suspicion
into a verified fix (and a real, human-labeled correction).

## Decision

**Structured flags in the SAME generation call (no extra AI cost — mirrors
ADR-0023).** The prompt appends a second sentinel + JSON block after the
problems/meds block: `<<<INCELEME_JSON>>>` → `{"review_flags":[{quote, reason,
category}]}`, where `quote` is copied **verbatim from the transcript** so it can be
located. `generate()` stops streaming at whichever sentinel appears first (the note
is everything before it) and parses both blocks; `split_note_and_lists` cuts the
note at the earliest marker so neither JSON leaks. Parsing **fails closed** to `[]`
(a model that ignores the instruction still yields a perfect note).

**Locate flags to turns (pure, in the worker).** `note_core.review.locate_flags`
fuzzy-matches each flag's `quote` to a transcript turn (Turkish-folded substring,
then token-overlap ≥ 0.5) to attach `{turn_index, start, end, matched}` for audio
seek. It never fabricates a match — an unlocated flag is still shown, just without a
jump target. Matching uses a local `normalize_tr.fold` (İ→i/I→ı casefold, diacritics
kept) — no cross-package dependency on `stt_eval`.

**Persist + correct (store/API).** A `review_flags_json` column stores the located
flags (backward-compatible `ALTER TABLE` migration). `NoteStore.update_transcript_turn`
corrects one turn's text, marks it `corrected`, and **resolves any flag on that
turn** (kept, not deleted, so the review trail is visible). It touches ONLY the
transcript turn — never the note body (the AI original + the ADR-0015 edit overlay
are independent). `PATCH /notes/{id}/turns {turn_index, text}` exposes it;
`GET /notes/{id}` returns `review_flags`. Audio reuses the range-enabled
`GET /notes/{id}/audio` (ADR-0019) — no new audio path.

**Dedicated review page (web).** A new route `/notes/:id/review`
(`TranscriptReviewPage`) shows: an audio player, a flag summary (grouped by
category, open/resolved counts), and the **raw transcript** with flagged turns
highlighted. Each turn/flag has ▶ (seek+play that moment, reusing the
`SourceTranscript` seek pattern) and ✎ (inline correct). The note viewer shows an
entry banner when open flags exist. PHI stays local throughout.

## Alternatives considered

- **A second AI call to extract flags** — rejected: doubles cost/latency; the
  single-call sentinel pattern (ADR-0023) already works.
- **Auto-correct the transcript from the model's guess** — rejected: silently
  rewriting a clinical transcript is exactly the risk the whole review layer guards
  against. The model only *suggests*; the human verifies against audio and applies.
- **Edit the note body instead of the transcript** — rejected: the transcript is
  the source of truth for the audio link and future training labels; the note edit
  overlay (ADR-0015) is a separate concern.
- **Highlight sub-spans within a turn** — deferred: turn-level highlight + the
  quoted flag chip is enough to act on; character-span mapping adds complexity for
  little gain (the doctor edits the whole turn text anyway).

## Consequences

- The model's existing (free) STT-error awareness becomes an actionable workflow:
  hear the moment, fix the text, flag auto-resolves.
- Corrected turns (`corrected: true`) are the beginning of a **human-verified
  label set** — the exact in-domain data a future fine-tune would need (the data
  flywheel discussed in the Turkish-ASR research), now captured as a byproduct.
- Fully additive + fail-closed: notes with no flags, no audio, or from older
  schemas all still render; a parse/locate failure degrades to unlocated flags.
- 24 fast tests cover flag parsing/location + store/endpoint round-trips (no ML).
