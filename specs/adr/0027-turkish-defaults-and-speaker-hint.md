# ADR-0027 — Turkish-forced default, soft 2-speaker cap, and the num_speakers false-pass fix

**Status:** Accepted · **Relates to:** REQ-011–013, REQ-135–137, ADR-0001, ADR-0004, ADR-0005, ADR-0026, `packages/core/src/stt_core/{models,pipeline,streaming}.py`, `apps/cli/src/stt_cli/main.py`, `apps/api/src/stt_api/main.py`

## Context

The `turkish-asr-improvement-research` sweep + the FLEURS baseline (ADR-0026)
identified three **categorical** quick wins — right/wrong, not measured-delta —
that need no hand-labeled clinical data to justify:

1. **Auto-detect language is a latent risk.** Whisper's language detection reads
   only the first ~30 s. A quiet or loanword-heavy opener ("check-up", drug brands)
   can mis-detect, which decodes the ENTIRE file in the wrong language AND skips the
   Turkish wav2vec2 aligner (degrading to coarse segment-level fusion, which also
   worsens speaker assignment). The product's audio is always Turkish clinical.
2. **Unbounded diarization over-splits a quiet/far patient.** pyannote's
   agglomerative clustering can split one patient whose embedding drifts into
   phantom "Speaker 3/4", or (rarely) merge both people — corrupting the readable
   transcript AND the note's who-said-what. The near-universal shape is 2 speakers.
3. **`num_speakers` gave FALSE PASSES.** `len(speaker_map)` counted the `None → "?"`
   placeholder that `fuse.speaker_name()` inserts for unattributed segments, so a
   run that merged both speakers into one still reported `num_speakers = 2` (proven
   on `out/HistoryTaking_YA.json`: 531 `SPEAKER_00` + 1 `None` → reported 2).

## Decision

- **Default `TranscribeOptions.language = "tr"`** (was `None`/auto). A new
  `_resolve_language()` maps the sentinels `"auto"`/`""` → `None` (auto-detect) and
  forwards any explicit code, so the escape hatch is preserved. Wired through the
  CLI (`--language`, default `tr`), and both API endpoints (`language` Form default
  `"tr"`, passed verbatim — the pipeline resolves the sentinel). **Benchmarked
  (FLEURS tr, ADR-0026): accuracy-identical to auto-detect on clean audio, and
  ~30 % faster on large-v3** (548 s vs 796 s) because it skips the detect pass.
- **Default `max_speakers = 2`** (was `None`), a SOFT cap surfaced through the CLI
  (`--max-speakers`, default 2) and both API endpoints. NOT a hardcoded exact count
  (`num_speakers=2` would mislabel a genuine monologue) — a soft cap that still
  yields one speaker for a monologue and allows a caller to raise it for a
  caregiver/interpreter. Reaches BOTH diarizer attempts (ADR-0005) via the existing
  `min/max_speakers` plumbing.
- **`num_speakers` counts only real speakers** via `_count_real_speakers()`, which
  excludes the `"?"` placeholder. Applied in both `pipeline.py` and `streaming.py`.
  (This supersedes the separately-tracked REQ-170; the eval harness's cpWER,
  ADR-0026, remains the durable regression guard for merged/​swapped speakers.)

The change is in `stt_core` (the pure library) so CLI/API/streaming inherit it;
CLI/API defaults were updated to match so callers that omit the params get the new
behavior, while explicit values (incl. `auto`) still override.

## Alternatives considered

- **Keep auto-detect** — rejected: the mis-detect failure is catastrophic and the
  forced default is accuracy-neutral + faster; detection is still available via
  `auto`.
- **Hardcode exactly 2 speakers** — rejected: mislabels monologues and could tension
  the ≥2-speaker gate; a soft cap is safer.
- **Tune the clustering threshold instead** — rejected as the *first* move: a
  speaker-count hint is far safer and more predictable than blind threshold tuning
  (which can regress other clips). Threshold tuning stays a later, harness-gated
  option.

## Consequences

- Real-audio reliability improves (no wrong-language decode; fewer phantom speakers)
  and large-v3 gets a free ~30 % speedup — with **no clean-audio WER/CER regression**
  (verified on FLEURS: baseline auto vs forced-tr identical).
- The success gate no longer false-passes a merged-speaker run.
- Pure functions (`_resolve_language`, `_count_real_speakers`) are unit-tested in
  the fast `make test` suite (no ML models). Explicit `auto`/higher `max_speakers`
  remain first-class overrides.
