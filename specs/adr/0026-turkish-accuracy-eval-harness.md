# ADR-0026 — Turkish transcription accuracy eval harness (WER/CER + DER/cpWER)

**Status:** Accepted · **Relates to:** REQ-167–REQ-170, ADR-0002 (pins), ADR-0007 (import-not-subprocess), ADR-0017 (pytest suite), ADR-0003 (self-contained/PHI-local), `packages/eval/`, `Makefile` (`eval`, `eval-smoke`), `pyproject.toml`

## Context

The only success gate for transcription is the behavioral one (`make verify`):
a transcript with **≥ 2 distinct `Speaker N` labels**. This measures **no text
accuracy at all**, and it gives **false passes** on diarization:
`num_speakers = len(speaker_map)` (`pipeline.py`) counts the `None → "?"`
placeholder that `fuse.py` inserts, so a run that merged both speakers into one
(`out/HistoryTaking_YA.json`: 531 `SPEAKER_00` + 1 `None`) still reports
`num_speakers = 2` and passes.

Consequence: every proposed Turkish-accuracy improvement — force `language="tr"`,
a Turkish clinical `initial_prompt`, a different/finetuned model, guarded LLM
post-correction — produces a **small delta that can go either way** and was
therefore **unfalsifiable**. We could ship a regression that looks green. This is
the prerequisite that turns the rest of the Turkish-ASR roadmap (see the
`turkish-asr-improvement-research` findings) from guesses into measured decisions.

## Decision

Add a **dev-only measurement package `stt-eval`** (`packages/eval/`) that scores a
fixed reference set and reports an A/B delta between two transcription configs.

**Metrics.** WER + **CER** (Turkish is agglutinative — a wrong suffix is a whole
word under WER but ~1 char under CER, and the note LLM often recovers it, so CER is
the more diagnostic number), medical **term recall** (did the drug/diagnosis token
survive), **cpWER** (concatenated min-permutation, speaker-attributed WER — the
metric that **fails** a merged/​swapped-speaker run even when the text is perfect,
closing the false-pass hole), and **DER** when the reference carries timestamps.

**Turkish-correct normalization** (`normalize.py`, pure Python, unit-tested):
- casefold with the dotted/dotless-i rule — `İ→i`, `I→ı` **before** `.lower()`
  (Python's default `I→i` is wrong for Turkish and manufactures WER);
- **keep** diacritics `ç ğ ı ş ö ü` — never Whisper's
  `BasicTextNormalizer(remove_diacritics=True)`, which collapses distinct words;
- drop (join) suffix apostrophes so `İstanbul'da` == the ASR-omitted `istanbulda`.
Applied **identically** to reference and hypothesis, so only relative treatment
matters.

**Pin-safety (ADR-0002).** `jiwer` is an **optional extra** (`uv sync --extra
eval`), mirroring note-core's `claude` extra. Verified: it pulls only
`jiwer` + `rapidfuzz` and moves **none** of the load-bearing pins (the `uv.lock`
diff is purely additive). `pyannote.metrics` (DER/cpWER) is **already installed**
transitively via `stt-core`'s `pyannote-audio` pin, and importing it does **not**
load torch — so the scorers stay fast and safe for `make test`.

**Import, not subprocess (ADR-0007).** The `run` driver calls
`stt_core.transcribe(...)` directly with a config's `TranscribeOptions`, caching
each transcription on disk keyed by `(audio fingerprint, options hash)` so
re-runs and scoring-code iteration never re-run the ML pipeline.

**Two test layers (ADR-0017).** Pure scoring (`normalize`, `metrics`, `manifest`)
is unit-tested in the fast `make test` suite (no ML models) — including a
load-bearing cpWER test that a merged-speaker hypothesis is heavily penalized. The
heavy `run` driver runs under a **new `make eval` target**, never in `make test`.

**PHI (ADR-0003).** A committed, **PHI-free** synthetic smoke manifest
(`eval/manifests/smoke-en.json`, ground truth from `make_sample.sh`) makes the
harness work on a fresh clone. The **real Turkish clinical reference set is PHI**
and lives git-ignored under `eval/data/` with a git-ignored manifest
`eval/manifests/clinical-tr.json`; the transcription cache (`eval/cache/`) is
git-ignored too.

## Alternatives considered

- **Keep only the ≥2-speaker gate** — rejected: it can't measure text and lies on
  diarization (documented false pass).
- **Whisper's `BasicTextNormalizer`** — rejected for Turkish: strips diacritics.
- **`jiwer` as a hard dependency** — rejected: keep the base install minimal and
  make the pin-safety explicit via an extra.
- **A cloud/hosted eval** — rejected: PHI must stay on-device (ADR-0003).

## Consequences

- Every subsequent Turkish-ASR change (force-`tr`, prompt biasing, model swap,
  post-correction) is now A/B-verifiable with a real number and a clear verdict.
- The `num_speakers` `"?"`-inflation false pass is now **detectable** via cpWER
  (fixing the inflation itself in `pipeline.py`/`fuse.py` is tracked separately —
  REQ-170).
- Establishing the baseline `large-v3` numbers on the clinical set (which don't
  exist today) is gated on **human labeling** — the real critical-path cost.
- `make test` gains ~30 fast tests and stays < 3 s (no ML models loaded).
