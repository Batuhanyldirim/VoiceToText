"""Turkish clinical decoding-bias presets for the asr_options seam (ADR-0028).

A short Turkish clinical `initial_prompt` biases Whisper's orthography (diacritics,
casing) and register toward doctor-patient language. It is applied to EVERY 30 s
window (verified in whisperx/asr.py: initial_prompt reaches generate_segment_batched
with condition_on_previous_text hardwired off), so keep it SHORT (≈≤ a few dozen
tokens) and neutral — a long prompt risks the model echoing/hallucinating it.

OFF BY DEFAULT. `TranscribeOptions.asr_options` is None unless a caller opts in,
because the accuracy effect on conversational Turkish is unproven and a prompt can
LEAK into the output. Enable it deliberately and A/B it with the eval harness,
asserting the prompt text never appears verbatim in the transcript.

Usage:
    from stt_core.biasing import TR_CLINICAL_PROMPT
    opts = TranscribeOptions(asr_options={"initial_prompt": TR_CLINICAL_PROMPT})
"""
from __future__ import annotations

# Neutral Turkish clinical framing + a spread of common clinical terms so the
# tokenizer's context favors correct medical orthography. Deliberately does NOT
# name specific drugs/doses (that biases toward inventing them — hotwords are a
# separate, later, carefully-measured lever).
TR_CLINICAL_PROMPT = (
    "Bu bir doktor ile hasta arasındaki muayene görüşmesidir. "
    "Şikayet, öykü, muayene bulguları, tanı, tedavi ve reçete konuşulur. "
    "Ağrı, ateş, tansiyon, nabız, mg, doz gibi terimler geçebilir."
)


def clinical_asr_options() -> dict:
    """Convenience: the asr_options dict enabling the Turkish clinical prompt."""
    return {"initial_prompt": TR_CLINICAL_PROMPT}
