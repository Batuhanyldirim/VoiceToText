# stt-eval — Turkish transcription accuracy harness

A **dev-only** measurement package. It answers the question the old success gate
couldn't: *did this change actually make Turkish transcription better?*

The shipped behavioral gate (`make verify`) only checks for **≥ 2 speaker labels**.
That measures no text accuracy **and gives false passes** — `out/HistoryTaking_YA.json`
has 531 segments labeled `SPEAKER_00` + 1 `None` (both speakers merged into one),
yet reports `num_speakers = 2`, because the `None → "?"` placeholder is counted.
So until now every accuracy idea (force `language=tr`, medical prompts, a different
model, LLM post-correction) was **unfalsifiable**. This harness fixes that.

## What it measures

| Metric | What | Why for Turkish / this product |
|---|---|---|
| **WER** | word error rate | headline accuracy |
| **CER** | character error rate | Turkish is agglutinative — one wrong suffix (`geliyordu`→`geliyor`) is a whole word under WER but ~1 char under CER; CER is the less-punishing, more diagnostic number |
| **term recall** | did the expected medical terms survive | drug/diagnosis names are the clinically important tokens |
| **cpWER** | concatenated min-permutation WER (speaker-attributed) | **catches the merged-speaker false pass** the old gate hides (0% when diarization is right, large when speakers are merged/swapped — even if the text is perfect) |
| **DER** | diarization error rate (needs timestamps) | time-domain speaker accuracy |

All scoring uses a **Turkish-correct normalizer** (`normalize.py`):
- Turkish casefold — `İ→i`, `I→ı` **before** `.lower()` (Python's default maps
  `I→i`, which is wrong for Turkish and manufactures WER).
- **Keeps** diacritics `ç ğ ı ş ö ü` (Whisper's `BasicTextNormalizer(remove_diacritics=True)`
  strips them and collapses distinct words — never use it here).
- Drops (joins) suffix apostrophes so `İstanbul'da` == the ASR-omitted `istanbulda`.

## Install

`jiwer` is an optional extra (pin-safe: it pulls only `jiwer` + `rapidfuzz`, and
does **not** move the load-bearing torch/pyannote/transformers/ctranslate2 pins —
ADR-0002). `pyannote.metrics` (DER/cpWER) is already present via `stt-core`.

```bash
uv sync --all-packages --extra eval
```

## Use

```bash
source env.sh            # HF_TOKEN (diarization) + in-project caches

# Score one already-produced transcript against a reference — NO ML, instant:
python -m stt_eval score --ref eval/data/foo.ref.json --hyp out/foo.json \
    --terms "parasetamol,ibuprofen"

# Transcribe a manifest under one or more configs and print an A/B delta
# (loads ML models; results cached in eval/cache/):
make eval m=eval/manifests/clinical-tr.json c="baseline tr-2spk"
#   -> the first config is the A/B baseline; lower WER/CER/DER/cpWER is better,
#      higher term recall is better; the delta line labels each improved/worse.

# End-to-end smoke on the committed, PHI-free synthetic set (fresh-clone safe):
make eval-smoke
```

Named configs live in `configs.py` (`baseline`, `tr`, `tr-2spk`, `turbo-tr`,
`small-tr`). Add one there to make it A/B-testable by name.

## Public benchmark: FLEURS Turkish (a baseline you can run today)

You don't need hand-labeled clinical data to get a **first WER number** and to A/B
the Turkish quick wins. `stt_eval.ingest_fleurs` pulls the **FLEURS** Turkish test
split (`google/fleurs`, CC-BY-4.0) into a local manifest:

```bash
# One-time ingest in an ISOLATED env (keeps .venv pin-clean — see below):
uv run --no-project --with "datasets>=3" --with soundfile \
    python -m stt_eval.ingest_fleurs --limit 50

# Then score with the pinned venv (no extra deps) — A/B the force-language win:
make eval m=eval/manifests/fleurs-tr.json c="fleurs-baseline fleurs-tr"       # small
make eval m=eval/manifests/fleurs-tr.json c="fleurs-baseline-lg fleurs-tr-lg" # large-v3
```

**Why an isolated ingest, not a dependency:** the HF `datasets` library would
downgrade `fsspec` in the shared `.venv`, and `datasets>=5` wants `torchcodec`
(torch-coupled) to decode audio. The ingest runs `uv run --no-project --with ...`
in a throwaway env, fetches **undecoded** audio bytes (`Audio(decode=False)`), and
writes WAVs with `soundfile` — so **no runtime dep touches our pins** (ADR-0002),
and downloads cache under the in-project `HF_HOME` (ADR-0003). Verified: `.venv`
stays free of `datasets`/`torchcodec` after ingest.

**What FLEURS is and isn't.** READ speech (Wikipedia-style sentences read aloud),
**single speaker per clip**. So it is a **public TEXT-accuracy sanity floor and
regression detector** — good for baseline WER/CER and for proving `language=tr`
etc. don't regress — but it is **NOT** conversational, **NOT** medical, and **NOT**
a diarization benchmark (cpWER/DER aren't meaningful on it). The real clinical
signal still needs the hand-labeled set below.

## Reference sets (manifests)

A manifest lists audio + ground-truth references. See
`eval/manifests/smoke-en.json` (committed, synthetic, PHI-free — the harness
self-test). A reference is a list of turns `[{speaker, text, start?, end?}]`,
inline (`"turns"`) or in an external file (`"reference": "eval/data/x.ref.json"`).

**The real Turkish clinical set is PHI** and lives git-ignored under `eval/data/`
with its own git-ignored manifest `eval/manifests/clinical-tr.json`. To build it:
bootstrap drafts via the API's transcript-reuse path (`GET /transcripts`), then
**human-correct** the words *and* the speaker labels. Human labeling (~5–10× audio
duration) is the real cost — start small (3–5 encounters, one quiet/far-patient
clip) and grow toward ~90 min for confidence on ~1–2% deltas.

`eval/data/`, `eval/cache/`, and `eval/manifests/clinical-tr.json` are git-ignored.

## Where it fits

- **Pure scoring** (`normalize`, `metrics`, `manifest`) is unit-tested in the fast
  `make test` suite (no ML models) — including the cpWER merged-speaker test.
- **The `run` driver** imports `stt_core.transcribe` directly (ADR-0007), loads ML
  models, and is **not** part of `make test`; it runs under `make eval`.
