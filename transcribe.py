#!/usr/bin/env python3
"""
Speech-to-text with speaker diarization (WhisperX, CPU / Apple Silicon).

Pipeline:  audio -> faster-whisper ASR -> forced alignment (word timestamps)
-> pyannote diarization -> word->speaker fusion -> speaker-labeled transcript.

Language is auto-detected by default (override with --language). Works for any
language Whisper supports; word-level alignment is applied when an aligner is
available for the detected language, otherwise speakers are assigned at the
segment level.

Usage:
    source env.sh                       # sets HF_TOKEN + redirects caches into project
    python transcribe.py samples/conversation.wav
    python transcribe.py meeting.m4a --min-speakers 2 --max-speakers 4

Outputs (into out/, named after the input file):
    <name>.txt    human-readable labeled transcript
    <name>.srt    subtitles with speaker labels
    <name>.json   full structured result (segments + words + speakers)
"""
import argparse
import json
import os
import re
import sys
from contextlib import contextmanager
from pathlib import Path

SPEAKER_LABEL = "Speaker"


def log(msg: str) -> None:
    print(f"[transcribe] {msg}", flush=True)


def enhance_audio(src_path: Path, out_dir: Path) -> Path:
    """
    Level out a recording where one speaker is close/loud and another far/quiet.

    Runs an ffmpeg chain that (1) high-passes rumble, (2) speechnorm + dynaudnorm
    to pull quiet speech up toward loud speech, (3) loudnorm for a consistent
    final level. Verified to recover a ~30 dB-quieter speaker that the raw
    pipeline otherwise drops. Returns the path to the enhanced wav.
    """
    import shutil
    import subprocess

    if shutil.which("ffmpeg") is None:
        log("WARNING: ffmpeg not found; skipping --enhance.")
        return src_path

    enhanced = out_dir / f"{src_path.stem}.enhanced.wav"
    chain = (
        "highpass=f=80,"
        "speechnorm=e=25:r=0.0005:l=1,"
        "dynaudnorm=f=150:g=15:p=0.9,"
        "loudnorm=I=-16:TP=-1.5:LRA=11"
    )
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_path),
           "-af", chain, "-ar", "16000", "-ac", "1", str(enhanced)]
    log("Enhancing audio (leveling quiet vs loud speaker) ...")
    try:
        subprocess.run(cmd, check=True)
        return enhanced
    except Exception as e:
        log(f"WARNING: enhancement failed ({e}); using original audio.")
        return src_path


def fmt_ts(seconds: float) -> str:
    """Seconds -> MM:SS.s for the .txt transcript."""
    if seconds is None:
        seconds = 0.0
    m, s = divmod(float(seconds), 60)
    return f"{int(m):02d}:{s:04.1f}"


def fmt_srt_ts(seconds: float) -> str:
    """Seconds -> HH:MM:SS,mmm for SRT."""
    if seconds is None:
        seconds = 0.0
    ms = int(round(float(seconds) * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def speaker_name(raw: str, mapping: dict) -> str:
    """Map pyannote's SPEAKER_00/01/... to 'Speaker 1/2/...' (stable order)."""
    if raw is None:
        raw = "?"
    if raw not in mapping:
        mapping[raw] = f"{SPEAKER_LABEL} {len(mapping) + 1}"
    return mapping[raw]


_PROGRESS_RE = re.compile(r"Progress:\s*([\d.]+)%")


@contextmanager
def transcription_progress_bar(desc: str = "Transcribing"):
    """
    Render WhisperX's built-in 'Progress: X%' prints as a live tqdm bar.

    WhisperX prints 'Progress: NN.NN%...' per audio chunk when print_progress=True.
    We temporarily intercept stdout, parse those lines, and drive a tqdm bar on
    stderr. Any non-progress text is passed through unchanged. Falls back to plain
    passthrough if tqdm isn't installed.
    """
    try:
        from tqdm import tqdm
    except Exception:
        yield
        return

    bar = tqdm(
        total=100, desc=desc, unit="%",
        bar_format="{l_bar}{bar}| {n:.0f}% [{elapsed}<{remaining}]",
    )
    real_stdout = sys.stdout

    class _Interceptor:
        def write(self, s):
            m = _PROGRESS_RE.search(s)
            if m:
                bar.n = min(float(m.group(1)), 100.0)
                bar.refresh()
            elif s.strip():
                real_stdout.write(s)

        def flush(self):
            real_stdout.flush()

    sys.stdout = _Interceptor()
    try:
        yield
    finally:
        sys.stdout = real_stdout
        bar.n = 100
        bar.refresh()
        bar.close()


def diarize_dataframe(diarization):
    """Convert a pyannote Annotation into the DataFrame whisperx expects."""
    import pandas as pd
    df = pd.DataFrame(
        diarization.itertracks(yield_label=True), columns=["segment", "label", "speaker"]
    )
    df["start"] = df["segment"].apply(lambda x: x.start)
    df["end"] = df["segment"].apply(lambda x: x.end)
    return df


def load_diarizer(diar_model: str, hf_token: str, device):
    """
    Return a callable(audio, min_speakers, max_speakers) -> diarization DataFrame.

    Tries the turnkey meta-model first (e.g. speaker-diarization-3.1 / community-1).
    If that model's terms aren't accepted OR it needs a different pyannote major
    version, fall back to assembling the pipeline from its two component models
    (segmentation-3.0 + wespeaker embedding) with the standard 3.1 hyper-params.
    This reproduces the meta-model without needing its gated repo.
    """
    import torch
    from pyannote.audio import Pipeline

    tdev = torch.device(device) if isinstance(device, str) else device

    # --- Attempt 1: the turnkey meta-pipeline ---
    try:
        pipe = Pipeline.from_pretrained(diar_model, use_auth_token=hf_token)
        if pipe is None:
            raise RuntimeError(f"{diar_model} returned None (terms not accepted?)")
        pipe.to(tdev)
        log(f"Diarizer: using turnkey model '{diar_model}'.")
        return _wrap_pipeline(pipe)
    except Exception as e:
        log(f"Diarizer: '{diar_model}' unavailable ({type(e).__name__}: {str(e).splitlines()[0][:80]}).")
        log("Diarizer: falling back to component pipeline (segmentation-3.0 + wespeaker).")

    # --- Attempt 2: build from components (accessible without the meta-model) ---
    from pyannote.audio.pipelines import SpeakerDiarization
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
    SAMPLE_RATE = 16000

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


def assign_speakers_segment_level(diar_df, result):
    """Fallback fusion when word timestamps are unavailable: label each segment
    with the diarization speaker it overlaps most."""
    for seg in result.get("segments", []):
        s, e = seg.get("start"), seg.get("end")
        if s is None or e is None:
            continue
        best_spk, best_overlap = None, 0.0
        for _, row in diar_df.iterrows():
            overlap = max(0.0, min(e, row["end"]) - max(s, row["start"]))
            if overlap > best_overlap:
                best_overlap, best_spk = overlap, row["speaker"]
        if best_spk is not None:
            seg["speaker"] = best_spk
    return result


def build_turns(segments: list, mapping: dict) -> list:
    """Collapse consecutive same-speaker segments into readable turns."""
    turns = []
    for seg in segments:
        spk = speaker_name(seg.get("speaker"), mapping)
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = seg.get("start")
        end = seg.get("end")
        if turns and turns[-1]["speaker"] == spk:
            turns[-1]["text"] += " " + text
            turns[-1]["end"] = end
        else:
            turns.append({"speaker": spk, "text": text, "start": start, "end": end})
    return turns


def main() -> int:
    ap = argparse.ArgumentParser(description="Speech-to-text + speaker diarization (WhisperX)")
    ap.add_argument("audio", help="Path to an audio file (wav/mp3/m4a/...)")
    ap.add_argument("--model", default="large-v3", help="Whisper model (default: large-v3)")
    ap.add_argument("--language", default=None,
                    help="Language code (e.g. en, tr, de). Default: auto-detect.")
    ap.add_argument("--min-speakers", type=int, default=None, help="Minimum number of speakers")
    ap.add_argument("--max-speakers", type=int, default=None, help="Maximum number of speakers")
    ap.add_argument("--device", default="cpu", help="cpu (default on Mac; MPS unsupported by CTranslate2)")
    ap.add_argument("--compute-type", default="int8", help="int8 (CPU) / float16 / float32")
    ap.add_argument("--batch-size", type=int, default=8, help="Transcription batch size")
    ap.add_argument("--no-diarize", action="store_true", help="Skip diarization (transcript only)")
    # Robust behavior is ON by default (audio leveling + sensitive VAD) so a plain
    # `transcribe.py file` handles uneven mic distance out of the box. These flags
    # are opt-OUT / override for power users.
    ap.add_argument("--no-enhance", action="store_true",
                    help="Disable the default audio leveling (compression + loudness "
                         "normalization) that lifts a quiet/far speaker toward a loud one.")
    ap.add_argument("--vad-onset", type=float, default=0.35,
                    help="Voice-activity sensitivity (default 0.35; lower = catches quieter "
                         "speech, higher = fewer false detections).")
    ap.add_argument("--diar-model", default="pyannote/speaker-diarization-3.1",
                    help="pyannote meta-model to try first; falls back to a component "
                         "pipeline (segmentation-3.0 + wespeaker) if it's gated/incompatible")
    ap.add_argument("--out-dir", default=None, help="Output directory (default: ./out)")
    args = ap.parse_args()

    audio_path = Path(args.audio).expanduser()
    if not audio_path.is_file():
        log(f"ERROR: audio file not found: {audio_path}")
        return 2

    project_root = Path(__file__).resolve().parent
    out_dir = Path(args.out_dir) if args.out_dir else project_root / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = audio_path.stem

    hf_token = os.environ.get("HF_TOKEN")
    if not args.no_diarize and not hf_token:
        log("ERROR: HF_TOKEN not set but diarization requested.")
        log("       Run `source env.sh` first, or pass --no-diarize.")
        return 2

    # Import here so --help works without the heavy deps installed.
    import whisperx  # noqa: E402

    device = args.device
    lang_display = args.language or "auto-detect"
    log(f"Device={device}  model={args.model}  compute_type={args.compute_type}  lang={lang_display}")

    # 1) Enhance (default ON), then load audio
    load_from = audio_path
    if not args.no_enhance:
        load_from = enhance_audio(audio_path, out_dir)
    log("Loading audio ...")
    audio = whisperx.load_audio(str(load_from))

    # 2) Transcribe (faster-whisper) with a live progress bar
    log("Loading ASR model (first run downloads it into models/hf) ...")
    vad_options = {"vad_onset": args.vad_onset}
    asr = whisperx.load_model(
        args.model, device, compute_type=args.compute_type, language=args.language,
        vad_options=vad_options,
    )
    log("Transcribing ...")
    with transcription_progress_bar("Transcribing"):
        result = asr.transcribe(
            audio, batch_size=args.batch_size, language=args.language, print_progress=True
        )
    language = result.get("language", args.language)
    log(f"  -> {len(result.get('segments', []))} raw segments (language: {language})")

    # 3) Forced alignment for accurate word timestamps (best-effort per language)
    aligned = False
    try:
        log(f"Loading alignment model for '{language}' ...")
        align_model, align_meta = whisperx.load_align_model(language_code=language, device=device)
        log("Aligning words ...")
        result = whisperx.align(
            result["segments"], align_model, align_meta, audio, device,
            return_char_alignments=False,
        )
        aligned = True
    except Exception as e:
        log(f"Alignment skipped for '{language}' ({type(e).__name__}: {str(e).splitlines()[0][:80]}).")
        log("Proceeding without word-level timestamps; speakers assigned at segment level.")

    speaker_map: dict = {}

    # 4) Diarization (pyannote) + word->speaker fusion
    if not args.no_diarize:
        log("Loading diarization pipeline (pyannote; first run downloads it) ...")
        diarizer = load_diarizer(args.diar_model, hf_token, device)
        log(f"Diarizing (min={args.min_speakers} max={args.max_speakers}) ...")
        diar_segments = diarizer(
            audio, min_speakers=args.min_speakers, max_speakers=args.max_speakers
        )
        log("Assigning speakers ...")
        if aligned:
            result = whisperx.assign_word_speakers(diar_segments, result)
        else:
            result = assign_speakers_segment_level(diar_segments, result)

    segments = result.get("segments", [])
    turns = build_turns(segments, speaker_map)
    n_speakers = len(speaker_map)

    # ---- Emit the transcript: print each line to the terminal AND write it to
    # the .txt file in the same pass, so the file mirrors the terminal exactly
    # and fills in live as lines are produced. ----
    txt_path = out_dir / f"{stem}.txt"
    print()
    log(f"Done. {len(turns)} turns, {n_speakers} speaker(s), language: {language}.")
    with txt_path.open("w", encoding="utf-8") as f:
        def emit(line: str = "") -> None:
            print(line, flush=True)
            f.write(line + "\n")
            f.flush()

        emit(f"# Transcript: {audio_path.name}")
        emit(f"# Language: {language}")
        emit(f"# Speakers: {n_speakers}")
        emit("-" * 70)
        for t in turns:
            emit(f"[{fmt_ts(t['start'])} → {fmt_ts(t['end'])}] {t['speaker']}: {t['text']}")
        emit("-" * 70)

    # ---- Also write the machine-readable formats (subtitles + full JSON) ----
    srt_path = out_dir / f"{stem}.srt"
    with srt_path.open("w", encoding="utf-8") as f:
        for i, t in enumerate(turns, 1):
            f.write(f"{i}\n{fmt_srt_ts(t['start'])} --> {fmt_srt_ts(t['end'])}\n")
            f.write(f"{t['speaker']}: {t['text']}\n\n")

    json_path = out_dir / f"{stem}.json"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(
            {"audio": str(audio_path), "language": language, "num_speakers": n_speakers,
             "speaker_map": speaker_map, "turns": turns, "segments": segments},
            f, ensure_ascii=False, indent=2,
        )

    log(f"Transcript saved to: {txt_path}")
    log(f"Also wrote: {srt_path}")
    log(f"           {json_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
