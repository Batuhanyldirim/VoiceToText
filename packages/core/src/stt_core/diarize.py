"""Speaker diarization loader with a component-pipeline fallback.

Ported verbatim from transcribe.py load_diarizer()/_wrap_pipeline()/
diarize_dataframe(). The two-attempt fallback is deliberate — see ADR-0005.
Heavy imports (torch, pyannote) stay lazy inside functions.
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from typing import Callable

SAMPLE_RATE = 16000


@contextmanager
def _mute_version_warnings():
    """Drop pyannote's benign version-mismatch lines, which it emits via raw
    print() (so warnings filters don't catch them) on every diarizer load:
      "Model was trained with pyannote.audio 0.0.1, yours is 3.3.2. Bad things…"
      "Model was trained with torch 1.10.0+cu102, yours is 2.5.1. Bad things…"
    Everything else — including the load-bearing 'Could not download …' fallback
    message (ADR-0005) — passes through unchanged."""
    real = sys.stdout

    class _Filter:
        def write(self, s):
            if "Bad things" in s and "trained with" in s:
                return
            real.write(s)

        def flush(self):
            real.flush()

    sys.stdout = _Filter()
    try:
        yield
    finally:
        sys.stdout = real


def diarize_dataframe(diarization):
    """Convert a pyannote Annotation into the DataFrame whisperx expects."""
    import pandas as pd
    df = pd.DataFrame(
        diarization.itertracks(yield_label=True), columns=["segment", "label", "speaker"]
    )
    df["start"] = df["segment"].apply(lambda x: x.start)
    df["end"] = df["segment"].apply(lambda x: x.end)
    return df


def load_diarizer(diar_model: str, hf_token: str, device, log: Callable[[str], None] = lambda m: None):
    """Return a callable(audio, min_speakers, max_speakers) -> diarization DataFrame.

    Attempt 1: the turnkey meta-model (e.g. speaker-diarization-3.1). Attempt 2
    (on any failure): assemble the pipeline from component models
    (segmentation-3.0 + wespeaker) with the standard 3.1 hyper-params. DO NOT
    remove attempt 2 — see ADR-0005.
    """
    import torch
    from pyannote.audio import Pipeline

    tdev = torch.device(device) if isinstance(device, str) else device

    # pyannote emits version-mismatch spam via raw print() at several points
    # during model load — the Pipeline AND each underlying Model (segmentation,
    # embedding) re-check on from_pretrained and .to(). Mute across the whole
    # setup (construct + instantiate + .to) so we catch every call site while
    # keeping the load-bearing "Could not download …" fallback message visible.
    # --- Attempt 1: the turnkey meta-pipeline ---
    try:
        with _mute_version_warnings():
            pipe = Pipeline.from_pretrained(diar_model, use_auth_token=hf_token)
            if pipe is None:
                raise RuntimeError(f"{diar_model} returned None (terms not accepted?)")
            pipe.to(tdev)
        log(f"Diarizer: using turnkey model '{diar_model}'.")
        return _wrap_pipeline(pipe)
    except Exception as e:  # noqa: BLE001
        log(f"Diarizer: '{diar_model}' unavailable ({type(e).__name__}: {str(e).splitlines()[0][:80]}).")
        log("Diarizer: falling back to component pipeline (segmentation-3.0 + wespeaker).")

    # --- Attempt 2: build from components (accessible without the meta-model) ---
    from pyannote.audio.pipelines import SpeakerDiarization
    with _mute_version_warnings():
        pipe = SpeakerDiarization(
            segmentation="pyannote/segmentation-3.0",
            embedding="pyannote/wespeaker-voxceleb-resnet34-LM",
            clustering="AgglomerativeClustering",
            use_auth_token=hf_token,
        )
        # Standard hyper-parameters from the speaker-diarization-3.1 recipe.
        pipe.instantiate({
            "clustering": {"method": "centroid", "min_cluster_size": 12, "threshold": 0.7045654963945799},
            "segmentation": {"min_duration_off": 0.0},
        })
        pipe.to(tdev)
    log("Diarizer: using component pipeline.")
    return _wrap_pipeline(pipe)


def _wrap_pipeline(pipe):
    """Adapt a raw pyannote Pipeline to (audio_np, min_speakers, max_speakers) -> DataFrame."""
    import torch

    def _run(audio, min_speakers=None, max_speakers=None):
        audio_data = {"waveform": torch.from_numpy(audio[None, :]), "sample_rate": SAMPLE_RATE}
        kwargs = {}
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers
        diarization = pipe(audio_data, **kwargs)
        return diarize_dataframe(diarization)

    return _run
