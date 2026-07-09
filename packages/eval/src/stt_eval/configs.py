"""Named transcription configs for A/B evaluation.

A config is just a set of overrides on `TranscribeOptions` (from stt_core). The
runner builds a full options object by starting from the defaults and applying the
config's overrides, then hashes the effective options to key the transcription
cache. Add a config here to make it A/B-testable by name (`--config <name>`).

`stt_core` is imported lazily by the runner, so this module stays import-cheap
(the fast `make test` suite imports the eval package without loading torch).
"""
from __future__ import annotations


def _clinical_prompt_opts() -> dict:
    """The Turkish clinical initial_prompt asr_options (from stt_core's committed
    preset). Imported lazily-ish at module load — stt_core.biasing has no heavy
    (torch/whisperx) imports, so this stays cheap for the fast test suite."""
    from stt_core.biasing import clinical_asr_options
    return clinical_asr_options()


# Each config: name -> dict of TranscribeOptions field overrides (applied over
# the current TranscribeOptions defaults, which since ADR-0027 are language="tr"
# and max_speakers=2). Add a config to make it A/B-testable by name.
#
# `baseline` now means "the SHIPPED defaults" (tr + soft 2-speaker cap). To compare
# against the OLD pre-ADR-0027 behavior, use `legacy-auto` (auto-detect, unhinted).
CONFIGS: dict[str, dict] = {
    "baseline": {},                                     # shipped defaults (tr, max_speakers=2)
    "legacy-auto": {"language": "auto", "max_speakers": None},  # pre-ADR-0027 behavior

    # --- Phase 1 quick-win isolation (see turkish-asr-improvement-research) ---
    "tr": {"language": "tr", "max_speakers": None},     # QW-1 only: force tr, no spk cap
    "tr-2spk": {"language": "tr", "max_speakers": 2},   # QW-1 + QW-2 (== baseline now)

    # --- biasing seam (QW-6/ADR-0028): Turkish clinical initial_prompt, OFF by
    #     default. Uses stt_core's committed preset; A/B it and assert no leakage. ---
    "tr-clinical-prompt": {"language": "tr", "asr_options": _clinical_prompt_opts()},

    # --- speed tier (Phase 2, MW-1); never a silent default ---
    "turbo-tr": {"language": "tr", "model": "large-v3-turbo"},

    # --- fast iteration (small model) — for developing the harness itself ---
    "small-tr": {"language": "tr", "model": "small"},

    # --- FLEURS text-accuracy benchmark (single speaker -> diarize off): A/B the
    # force-language quick win on a public read-speech set. `*-lg` uses large-v3.
    # `fleurs-baseline` = auto-detect (the OLD behavior) so the A/B is meaningful. ---
    "fleurs-baseline": {"model": "small", "language": "auto", "diarize": False},
    "fleurs-tr": {"model": "small", "language": "tr", "diarize": False},
    "fleurs-baseline-lg": {"model": "large-v3", "language": "auto", "diarize": False},
    "fleurs-tr-lg": {"model": "large-v3", "language": "tr", "diarize": False},
    "fleurs-prompt": {"model": "small", "language": "tr", "diarize": False,
                      "asr_options": _clinical_prompt_opts()},

    # --- MW-2: community Turkish fine-tune, A/B'd and REJECTED (2026-07-08).
    # turkmedstt/whisper-large-v3-turkish-medical (LoRA on ~140h CommonVoice/read +
    # SYNTHETIC TTS medical) scored 11.7% WER / 3.6% CER on FLEURS-tr vs vanilla
    # large-v3's 6.3% / 1.4% — ~85% WORSE. Its strong self-reported 7.95% was on
    # its own distribution; it overfit and does not transfer. Kept as a documented
    # negative result: to reproduce, re-convert into models/ (git-ignored) via
    #   ct2-transformers-converter --model turkmedstt/whisper-large-v3-turkish-medical
    #     --output_dir models/whisper-tr-medical-ct2 --quantization int8
    #   + copy tokenizer.json/preprocessor_config.json from openai/whisper-large-v3.
    "fleurs-trmed-lg": {"model": "models/whisper-tr-medical-ct2",
                        "language": "tr", "diarize": False},
}


def resolve_overrides(name: str) -> dict:
    """Return the override dict for a named config, or raise with the valid list."""
    if name not in CONFIGS:
        raise KeyError(f"unknown config '{name}'. Known: {', '.join(sorted(CONFIGS))}")
    return CONFIGS[name]
