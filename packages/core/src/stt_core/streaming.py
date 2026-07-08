"""Streaming transcription: chunk ASR while audio arrives, diarize once at finish.

`StreamingTranscriber` is the streaming counterpart of `transcribe()` (pipeline.py).
The caller (the API's stream worker) feeds it raw 16 kHz mono float32 PCM as it
arrives from the browser; whenever enough audio has accumulated it cuts a chunk
**on a silence gap** (never mid-word — see ADR-0014, proven by the spike: 99.4%
word-parity for silence cuts vs 59.4% for naive fixed cuts), runs ASR + alignment
on that chunk, offsets the chunk's timestamps by its absolute start, and appends
the segments — streaming the new text out via the progress callback. `finish()`
flushes the tail, runs a SINGLE global diarization pass over ALL accumulated audio
(pyannote clusters speakers globally — never per-chunk), fuses, and returns a
normal `TranscribeResult` so downloads / note generation / the transcript viewer
are reused unchanged.

Like the rest of stt_core this is PURE: no printing, no file writes. Heavy ML
imports (whisperx/torch) stay lazy inside methods so importing the module is cheap.
Enhancement is intentionally skipped in streaming mode (REQ-131) — the whole-file
leveling pass needs the complete file; the batch record/upload path keeps it.
"""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np

from .diarize import _mute_version_warnings, load_diarizer
from .fuse import assign_speakers_segment_level, build_turns
from .models import TranscribeOptions, TranscribeResult
from .pipeline import MissingTokenError
from .progress import ProgressCallback, ProgressEvent, noop

SAMPLE_RATE = 16000

# Chunking knobs (seconds). CHUNK_TARGET stays well under Whisper's ~30 s window;
# we look for the quietest frame within +/- SILENCE_WINDOW of the target so the
# cut lands in a pause. We use NO overlap: cutting on silence means the boundary
# falls where nobody is speaking, so disjoint chunks concatenate cleanly with no
# duplicated words to dedupe (whisperx carries no cross-window context anyway —
# condition_on_previous_text=False — so overlap buys nothing and a drop-the-
# overlap filter risks losing boundary-spanning words). Verified: this reproduces
# one-shot accuracy; an earlier overlap+drop scheme lost ~11% of words. (ADR-0014)
CHUNK_TARGET_S = 20.0
SILENCE_WINDOW_S = 5.0
_FRAME = 320  # 20 ms @ 16 kHz — granularity of the silence search
# Minimum audio (s) that must remain UNCONSUMED, so the final tail flushed at
# finish() is never a tiny fragment Whisper (padded to 30 s) would hallucinate over.
MIN_CHUNK_S = 6.0


def _find_silence_cut(audio: np.ndarray, target_s: float,
                      window_s: float = SILENCE_WINDOW_S) -> int:
    """Return a sample index near target_s at the quietest 20 ms frame within
    +/- window_s — i.e. cut inside a silence gap, not mid-word."""
    n = len(audio) // _FRAME
    if n == 0:
        return int(target_s * SAMPLE_RATE)
    frames = audio[: n * _FRAME].reshape(n, _FRAME)
    energy = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    target_f = int(target_s * SAMPLE_RATE / _FRAME)
    w = int(window_s * SAMPLE_RATE / _FRAME)
    lo, hi = max(0, target_f - w), min(len(energy), target_f + w)
    if hi <= lo:
        return int(target_s * SAMPLE_RATE)
    quietest = lo + int(np.argmin(energy[lo:hi]))
    return quietest * _FRAME


class StreamingTranscriber:
    """Stateful streaming transcription. Usage:

        st = StreamingTranscriber(opts, progress)
        st.feed(pcm_float32)        # repeatedly, as audio arrives
        ...
        result = st.finish()        # flush tail + global diarize + fuse -> result

    `progress` receives ProgressEvent(stage="transcribe", message=<new text>) as
    each chunk lands, then the usual diarize/fuse/done stages at finish.
    """

    def __init__(
        self,
        opts: Optional[TranscribeOptions] = None,
        progress: ProgressCallback = noop,
        audio_name: str = "recording",
        log: Callable[[str], None] = lambda m: None,
    ) -> None:
        self.opts = opts or TranscribeOptions()
        if self.opts.diarize and not self.opts.hf_token:
            raise MissingTokenError(
                "HF token required for diarization. Set HF_TOKEN (or pass diarize=False)."
            )
        self.progress = progress
        self.audio_name = audio_name
        self.log = log

        # Full audio accumulates here (for the global diarize pass at finish).
        self._audio = np.zeros(0, dtype=np.float32)
        # Samples already handed to a chunk (chunks start OVERLAP_S before this).
        self._consumed = 0
        # Aligned/segment-level ASR segments so far, with ABSOLUTE timestamps.
        self._segments: list[dict] = []
        # Accumulated transcript words (overlap-deduped) — drives the live text.
        self._words: list[str] = []
        self._language: Optional[str] = self.opts.language
        self._finished = False

        # Lazily-loaded ASR model, kept warm across chunks.
        self._asr = None
        self._align_model = None
        self._align_meta = None
        self._align_lang: Optional[str] = None

    # --- model loading (lazy) ------------------------------------------------
    def _ensure_asr(self):
        if self._asr is not None:
            return
        import whisperx  # lazy
        self.log("Loading ASR model (streaming) ...")
        with _mute_version_warnings():
            self._asr = whisperx.load_model(
                self.opts.model, self.opts.device,
                compute_type=self.opts.compute_type, language=self.opts.language,
                vad_options={"vad_onset": self.opts.vad_onset},
            )

    # --- ingest --------------------------------------------------------------
    def feed(self, pcm: np.ndarray) -> None:
        """Append mono float32 PCM (16 kHz). Transcribes any complete chunks that
        the new audio makes available (cutting on silence)."""
        if self._finished:
            raise RuntimeError("feed() after finish()")
        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32)
        self._audio = np.concatenate([self._audio, pcm.reshape(-1)])
        # Emit as many silence-cut chunks as the buffered tail allows, always
        # leaving MIN_CHUNK_S unconsumed so the final tail isn't a tiny fragment.
        while True:
            avail = (len(self._audio) - self._consumed) / SAMPLE_RATE
            if avail < CHUNK_TARGET_S + MIN_CHUNK_S:
                break
            cut = _find_silence_cut(self._audio, self._consumed / SAMPLE_RATE + CHUNK_TARGET_S)
            if cut <= self._consumed:  # safety: force progress past the boundary
                cut = self._consumed + int(CHUNK_TARGET_S * SAMPLE_RATE)
            self._transcribe_chunk(cut)

    def _transcribe_chunk(self, end_sample: int) -> None:
        """ASR+align the DISJOINT chunk audio[consumed : end_sample], append with
        absolute timestamps, advance `consumed`. No overlap: the cut is in silence,
        so chunks join cleanly with no duplicated words to remove."""
        self._ensure_asr()

        start_sample = self._consumed
        chunk = self._audio[start_sample:end_sample]
        offset = start_sample / SAMPLE_RATE

        result = self._asr.transcribe(
            chunk, batch_size=self.opts.batch_size, language=self._language,
            print_progress=False,
        )
        self._language = self._language or result.get("language")

        segs = result.get("segments", []) or []
        segs = self._maybe_align(segs, chunk, offset)

        # Shift chunk-relative timestamps to absolute (whisperx returns times
        # relative to the chunk we fed) so the finish-time global diarization
        # fusion aligns. Append every segment — nothing to drop without overlap.
        chunk_text: list[str] = []
        for seg in segs:
            if seg.get("start") is not None:
                seg["start"] += offset
            if seg.get("end") is not None:
                seg["end"] += offset
            for w in seg.get("words", []) or []:
                if isinstance(w, dict):
                    if w.get("start") is not None:
                        w["start"] += offset
                    if w.get("end") is not None:
                        w["end"] += offset
            self._segments.append(seg)
            t = (seg.get("text") or "").strip()
            if t:
                chunk_text.append(t)

        self._consumed = end_sample
        if chunk_text:
            delta = " ".join(chunk_text).strip()
            self._words.extend(delta.split())
            self.progress(ProgressEvent(stage="transcribe", message=delta))

    def _maybe_align(self, segs: list[dict], chunk: np.ndarray, offset: float) -> list[dict]:
        """Best-effort word alignment for a chunk (per detected language). On any
        failure, degrade to the raw (segment-level) segments — same policy as the
        batch pipeline (REQ-051)."""
        import whisperx  # lazy
        if not segs or not self._language:
            return segs
        try:
            if self._align_model is None or self._align_lang != self._language:
                self._align_model, self._align_meta = whisperx.load_align_model(
                    language_code=self._language, device=self.opts.device
                )
                self._align_lang = self._language
            aligned = whisperx.align(
                segs, self._align_model, self._align_meta, chunk, self.opts.device,
                return_char_alignments=False,
            )
            return aligned.get("segments", segs) or segs
        except Exception as e:  # noqa: BLE001 - degrade to segment level
            self.log(f"Streaming align skipped ({type(e).__name__}).")
            return segs

    # --- finalize ------------------------------------------------------------
    def finish(self) -> TranscribeResult:
        """Flush the tail, diarize globally, fuse, and return the result."""
        if self._finished:
            raise RuntimeError("finish() called twice")
        # Flush any remaining audio as a final chunk.
        if len(self._audio) - self._consumed > int(0.2 * SAMPLE_RATE):
            self._transcribe_chunk(len(self._audio))
        self._finished = True

        speaker_map: dict = {}
        segments = list(self._segments)
        aligned = any(seg.get("words") for seg in segments)

        if self.opts.diarize and len(self._audio) > 0:
            self.progress(ProgressEvent(stage="diarize", message="identifying speakers"))
            diarizer = load_diarizer(
                self.opts.diar_model, self.opts.hf_token, self.opts.device, log=self.log
            )
            diar_df = diarizer(
                self._audio, min_speakers=self.opts.min_speakers,
                max_speakers=self.opts.max_speakers,
            )
            self.progress(ProgressEvent(stage="fuse", message="assigning speakers"))
            if aligned:
                import whisperx  # lazy
                fused = whisperx.assign_word_speakers(diar_df, {"segments": segments})
                segments = fused.get("segments", segments)
            else:
                segments = assign_speakers_segment_level(
                    diar_df, {"segments": segments}
                ).get("segments", segments)

        turns = build_turns(segments, speaker_map)
        self.progress(ProgressEvent(stage="done", percent=100.0))
        return TranscribeResult(
            audio=self.audio_name,
            language=self._language,
            num_speakers=len(speaker_map),
            speaker_map=speaker_map,
            turns=turns,
            segments=segments,
        )

    @property
    def live_text(self) -> str:
        """The transcript accumulated so far (for a late-joining client)."""
        return " ".join(self._words).strip()

    @property
    def duration_s(self) -> float:
        return len(self._audio) / SAMPLE_RATE
