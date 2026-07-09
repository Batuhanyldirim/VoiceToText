# ADR-0030 — Diarization for similar-voice / short-turn dialogue: LLM role-relabel + acoustic tuning + a raw-cluster diagnostic

**Status:** Accepted · **Relates to:** REQ-176–REQ-181, ADR-0005 (diarizer fallback), ADR-0009 (provider seam), ADR-0027 (speaker-count defaults), ADR-0029 (transcript review), `packages/core/src/stt_core/{models,pipeline,diarize}.py`, `packages/note-core/src/note_core/rediar.py`, `apps/api/src/stt_api/{store,main}.py`, `apps/web/src/components/TranscriptReviewPage.tsx`

## Context

On a real 16-min pediatric-genetics intake (`samples/HistoryTaking_YA.mp4`) —
a doctor rapid-firing short questions, a parent giving short answers, similar
voices — diarization collapsed **~92% of speech into one speaker** ("Speaker 1"),
with "Speaker 2" appearing once. Forcing the speaker count barely helped (measured:
`min_speakers=2` → 91.7% dominant share, vs 92.3% baseline).

**Measured root cause (via a diarization diagnostic + the DER/cpWER harness):**
pyannote *does* emit 2 clusters, but its embedding cannot separate two similar
voices across dozens of very short (2-5 word) turns, so it assigns almost
everything to the dominant cluster. This is an **embedding/clustering** limit, not
a fusion artifact (the re-run fuse-lever agent confirmed the fused word-labels were
`{None, SPEAKER_00}` — no second speaker for fusion to assign).

**Measured fix (Opus-4.8-as-judge coherence, 0-100, blind, no ground-truth needed
because the Q&A structure is checkable from text):**
- Acoustic baseline: **3/100 — FAILED** (23 Q-A merge errors).
- **LLM role-relabel** (local qwen2.5:32b over the 532 ASR segments): **88/100 —
  GOOD** (1 merge error). ~29× better.
- Acoustic tuning (component pipeline, RAW audio, clustering threshold 0.70→0.50,
  min_cluster_size 12→6) moved *balance* 92%→55% dominant share, but assignment
  *correctness* was not established — balance ≠ correct labels.

## Decision

Three complementary changes, scoped by how strong the evidence is.

**1. LLM speaker RE-LABEL (the primary fix) — `note_core.rediar`.** A post-transcription
pass that sends the transcript turns/segments to the local LLM and asks for a ROLE
(`doktor`/`hasta`/`diger`) per turn index, exploiting the rigid doctor-asks/
parent-answers structure. It is:
- **at the note/API layer, not in pure `stt_core`** (needs an LLM; `stt_core` stays
  pure and LLM-free). Reuses the ADR-0009 provider seam (Ollama default, PHI-local).
- **reviewable, never silent**: `POST /notes/{id}/rediar` returns a proposal +
  applies it **only if a guard passes** (`apply_relabel`: ≥80% coverage AND ≥2
  distinct roles), else keeps the acoustic labels (fail-closed). Maps roles BY TURN
  INDEX (never re-quoting text), so it cannot drop/insert/reorder turns. Touches only
  the transcript, never the note body (ADR-0015). Surfaced on the review page
  (ADR-0029) as a **"Konuşmacıları yeniden ata"** action.

**2. Acoustic tuning — OPT-IN, not default.** `TranscribeOptions` gains
`diar_on_enhanced` (default **False** → diarize on RAW audio; enhancement flattens
speaker loudness and hurts separation — ASR still uses the enhanced audio) and
`diar_clustering_threshold` / `diar_min_cluster_size` (None = pyannote-3.1 defaults).
When either clustering knob is set, `load_diarizer` **forces the tunable component
pipeline** (the turnkey meta-model doesn't honor `instantiate()` overrides).
Diarizing on raw audio is the one default change (well-evidenced, low risk); the
clustering knobs stay opt-in because their *correctness* is unproven and could
over-split other recordings.

**3. Raw-cluster diagnostic — `TranscribeResult.raw_diar_speakers`.** The pipeline
now records how many distinct speakers clustering emitted BEFORE fusion (previously
the diar dataframe was discarded). `==1` proves a clustering-merge (not fusion), lets
the eval harness assert `≥2`, and lets the UI warn on a merge. Guarded so a
diagnostic never crashes a run.

## Alternatives considered

- **Force `num_speakers`/`min_speakers=2` as the fix** — rejected as sufficient:
  measured to barely move the merge (91.7% vs 92.3%). Kept as a soft cap (ADR-0027).
- **Swap the embedding model (ECAPA-TDNN/CAM++)** — deferred: the LLM relabel already
  hit 88/100, so a local pin-safe embedding swap wasn't needed this round (kept as a
  documented future option; allowed if it stays local + pin-safe).
- **Make the clustering tuning the default** — rejected without cross-recording
  regression data; shipped opt-in.
- **NeMo/cloud diarizers, pyannote 4.x** — rejected (abandon WhisperX fuse / break
  the pins / PHI off-device).
- **Silent LLM relabel** — rejected: it's a suggestion the doctor reviews, guarded
  and fail-closed, consistent with ADR-0029.

## Consequences

- The dominant real-world failure (similar-voice short-turn intake) now has a
  measured 3→88 fix, available as a one-click reviewable action; the acoustic
  raw-audio default helps all recordings with low risk.
- Corrected/relabeled turns become human-verified speaker labels — the same data a
  future embedding fine-tune or eval reference would need.
- Fully additive + fail-closed: no transcript, no LLM, guard-rejected, or older
  schema all degrade to the prior behavior. 15 fast tests added (rediar parse/guard,
  the `/rediar` endpoint, `set_transcript_turns`); pure `stt_core` diagnostic/knobs
  covered by the pipeline-helper tests. `raw_diar_speakers` empirically confirmed
  `==1` on the failing clip.
- **Still needs verification:** the 88/100 is one clip on one judge; the clinical
  reference set (ADR-0026) should confirm across encounters before the acoustic
  knobs or an LLM-relabel-by-default are promoted.
