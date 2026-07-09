# ADR-0028 — ASR biasing seam (`asr_options`) + Turkish clinical `initial_prompt`

**Status:** Accepted · **Relates to:** REQ-138, REQ-139, ADR-0026, ADR-0027, `packages/core/src/stt_core/{models,pipeline,streaming,biasing}.py`

## Context

Whisper can be biased toward correct orthography and domain register **without
retraining** via `initial_prompt` (and `hotwords`). Our pipeline never exposed
these — `pipeline.py` passed only `vad_options` to `whisperx.load_model`. Verified
against the installed `whisperx==3.4.2` source (`asr.py`):

- `load_model(..., asr_options: Optional[dict])` exists and merges into
  `default_asr_options`.
- `initial_prompt` and `hotwords` **do** reach decoding — `generate_segment_batched`
  builds the prompt from them and applies it to **every** 30 s window (because
  `condition_on_previous_text` is hardwired off).
- The anti-hallucination knobs (`temperature`, `no_speech_threshold`,
  `compression_ratio_threshold`, `condition_on_previous_text`, `repetition_penalty`)
  are **NO-OPS** in this batched path — `model.generate` receives only
  `beam_size/patience/length_penalty/max_length/suppress_blank/suppress_tokens`.

So a biasing seam is a ~few-line, pin-safe change; decode-knob tuning is a dead end.

## Decision

- **Add `TranscribeOptions.asr_options: Optional[dict] = None`**, forwarded verbatim
  to `whisperx.load_model(asr_options=...)` in both `pipeline.py` and `streaming.py`.
  **Off by default** — the accuracy effect on conversational Turkish is unproven and
  a prompt can LEAK into output, so it must be opted into and A/B-verified.
- **Ship a committed preset** `stt_core.biasing.TR_CLINICAL_PROMPT` (+
  `clinical_asr_options()`): a short Turkish clinical framing that names common
  clinical *terms* but **no specific drugs/doses** (naming drugs biases the model
  toward inventing them — `hotwords` is a separate, later, precision-measured lever).
- **Verification contract (REQ-139):** before enabling by default, A/B it on the
  eval harness (`fleurs-prompt` / a clinical set) and assert the prompt text never
  appears verbatim in the transcript (leakage is the known failure mode, and
  ADR-0026 verified there is no hallucination filter downstream to catch it).

## Alternatives considered

- **Tune decode knobs (temperature, thresholds) for hallucinations** — rejected:
  verified no-ops in the batched path; wasted effort.
- **Enable the clinical prompt by default now** — rejected: unproven on conversational
  Turkish, leakage risk; ship the seam + preset off, prove it, then flip.
- **`hotwords` with a drug list first** — deferred: weakest biasing lever (223-token
  cap, agglutinative subword dilution, phantom-insertion safety risk). Do it last,
  measuring false-insertion, only after `initial_prompt` proves out.
- **`suppress_numerals=True`** — rejected: would corrupt doses/BP/labs; keep it
  `False` (digit fidelity matters more here than in general ASR).

## Consequences

- We can now bias Turkish medical decoding through a clean, documented seam with
  zero pin risk (verified: `asr_options` is a real `load_model` kwarg).
- The default path is byte-identical to before (seam off), so no regression.
- `configs.py` gains `tr-clinical-prompt` / `fleurs-prompt` configs to A/B the
  preset; the preset + seam are unit-tested (shape, Turkish content, off-by-default)
  in the fast suite. Enabling by default is a future, harness-gated decision.
