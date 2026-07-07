"""The transcription pipeline as an importable function.

`transcribe(input_path, opts, progress)` runs enhance -> ASR -> align -> diarize
-> fuse and returns a TranscribeResult. It does NOT print and does NOT write
files — callers (CLI, API) decide how to surface progress and persist output.

Heavy ML imports (whisperx/torch/pyannote) stay lazy inside this function so
`--help` and API startup don't pay for them (specs REQ-042).
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

from .audio import enhance_audio
from .diarize import _mute_version_warnings, load_diarizer
from .fuse import assign_speakers_segment_level, build_turns
from .models import TranscribeOptions, TranscribeResult
from .progress import ProgressCallback, ProgressEvent, capture_transcribe_progress, noop


class MissingTokenError(RuntimeError):
    """Raised when diarization is requested but no HF token is available."""


def transcribe(
    input_path: Path,
    opts: Optional[TranscribeOptions] = None,
    progress: ProgressCallback = noop,
    out_dir: Optional[Path] = None,
    log: Callable[[str], None] = lambda m: None,
) -> TranscribeResult:
    """Run the full pipeline. `out_dir` is only used as a scratch location for the
    enhanced wav (kept inside the project per ADR-0003); no transcript files are
    written here."""
    opts = opts or TranscribeOptions()
    input_path = Path(input_path).expanduser()
    if not input_path.is_file():
        raise FileNotFoundError(f"audio file not found: {input_path}")

    if opts.diarize and not opts.hf_token:
        raise MissingTokenError(
            "HF token required for diarization. Set HF_TOKEN (or pass --no-diarize)."
        )

    out_dir = Path(out_dir) if out_dir else input_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    import whisperx  # lazy

    device = opts.device

    # --- Stage 1: enhance (default on) ---
    load_from = input_path
    if opts.enhance:
        progress(ProgressEvent(stage="enhance", message="leveling audio"))
        load_from = enhance_audio(input_path, out_dir, log=log)

    log("Loading audio ...")
    audio = whisperx.load_audio(str(load_from))

    # --- Stage 2: transcribe (with fine-grained % via stdout interception) ---
    log("Loading ASR model ...")
    # load_model pulls in the pyannote VAD, which prints benign version-mismatch
    # spam via raw print(); mute it (same filter as the diarizer load).
    with _mute_version_warnings():
        asr = whisperx.load_model(
            opts.model, device, compute_type=opts.compute_type, language=opts.language,
            vad_options={"vad_onset": opts.vad_onset},
        )
    progress(ProgressEvent(stage="transcribe", percent=0.0))
    with capture_transcribe_progress(progress):
        result = asr.transcribe(
            audio, batch_size=opts.batch_size, language=opts.language, print_progress=True
        )
    language = result.get("language", opts.language)
    log(f"  -> {len(result.get('segments', []))} raw segments (language: {language})")

    # --- Stage 3: align (best-effort per language) ---
    aligned = False
    progress(ProgressEvent(stage="align", message=f"aligning ({language})"))
    try:
        align_model, align_meta = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(
            result["segments"], align_model, align_meta, audio, device,
            return_char_alignments=False,
        )
        aligned = True
    except Exception as e:  # noqa: BLE001 - degrade to segment-level
        log(f"Alignment skipped for '{language}' ({type(e).__name__}: {str(e).splitlines()[0][:80]}).")

    speaker_map: dict = {}

    # --- Stage 4 + 5: diarize + fuse ---
    if opts.diarize:
        progress(ProgressEvent(stage="diarize", message="identifying speakers"))
        diarizer = load_diarizer(opts.diar_model, opts.hf_token, device, log=log)
        diar_segments = diarizer(
            audio, min_speakers=opts.min_speakers, max_speakers=opts.max_speakers
        )
        progress(ProgressEvent(stage="fuse", message="assigning speakers"))
        if aligned:
            result = whisperx.assign_word_speakers(diar_segments, result)
        else:
            result = assign_speakers_segment_level(diar_segments, result)

    segments = result.get("segments", [])
    turns = build_turns(segments, speaker_map)

    progress(ProgressEvent(stage="done", percent=100.0))
    return TranscribeResult(
        audio=str(input_path),
        language=language,
        num_speakers=len(speaker_map),
        speaker_map=speaker_map,
        turns=turns,
        segments=segments,
    )
