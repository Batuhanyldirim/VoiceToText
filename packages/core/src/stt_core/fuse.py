"""Fuse diarization speakers with transcript segments, and collapse into turns.

Ported verbatim from transcribe.py speaker_name()/assign_speakers_segment_level()
/build_turns().
"""
from __future__ import annotations

SPEAKER_LABEL = "Speaker"


def speaker_name(raw, mapping: dict) -> str:
    """Map pyannote's SPEAKER_00/01/... to 'Speaker 1/2/...' (stable order)."""
    if raw is None:
        raw = "?"
    if raw not in mapping:
        mapping[raw] = f"{SPEAKER_LABEL} {len(mapping) + 1}"
    return mapping[raw]


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
    """Collapse consecutive same-speaker segments into readable turns (list of dicts)."""
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
