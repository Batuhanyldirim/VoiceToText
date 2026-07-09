"""A/B evaluation runner: transcribe a manifest under one or more named configs,
score each item (WER/CER + term recall + DER/cpWER), and report per-item and
aggregate numbers plus the A-vs-B delta.

Transcriptions are CACHED on disk keyed by (audio bytes fingerprint, effective
options hash) so re-running a config is instant and iterating on the SCORING code
never re-runs the ML pipeline. The cache lives under `eval/cache/` (git-ignored).

Imports `stt_core.transcribe` directly (ADR-0007: import, not subprocess). Heavy —
loads the ML models — so this is NEVER part of the fast `make test` suite; it runs
under the separate `make eval` target.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from .configs import resolve_overrides
from .manifest import EvalItem, Manifest, load_manifest
from .metrics import cpwer, diarization_error_rate, score_text, term_recall


@dataclass
class ItemResult:
    id: str
    config: str
    wer: float
    cer: float
    term_recall: Optional[float]
    der: Optional[float]
    cpwer: Optional[float]
    num_speakers_reported: int
    num_speakers_true: int
    ref_words: int
    transcribe_seconds: Optional[float] = None
    detail: dict = field(default_factory=dict)


def _options_hash(overrides: dict) -> str:
    """Stable short hash of the effective options overrides (config identity)."""
    blob = json.dumps(overrides, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def _audio_fingerprint(path: Path) -> str:
    """Cheap content fingerprint: size + mtime + head bytes. Avoids hashing GBs of
    audio while still busting the cache if the file changes."""
    st = path.stat()
    with path.open("rb") as f:
        head = f.read(65536)
    h = hashlib.sha1()
    h.update(str(st.st_size).encode())
    h.update(str(int(st.st_mtime)).encode())
    h.update(head)
    return h.hexdigest()[:12]


def _cache_path(cache_dir: Path, item: EvalItem, overrides: dict) -> Path:
    key = f"{item.id}.{_audio_fingerprint(item.audio)}.{_options_hash(overrides)}.json"
    return cache_dir / key


def _true_speaker_count(turns: list[dict]) -> int:
    return len({t.get("speaker") for t in turns if t.get("speaker")})


def transcribe_item(item: EvalItem, config: str, cache_dir: Path,
                    log=lambda m: None) -> dict:
    """Return a TranscribeResult-shaped dict for `item` under `config`, using the
    on-disk cache when possible. Loads stt_core lazily."""
    overrides = resolve_overrides(config)
    cache_file = _cache_path(cache_dir, item, overrides)
    if cache_file.is_file():
        log(f"  [{config}] cache hit: {item.id}")
        return json.loads(cache_file.read_text(encoding="utf-8"))

    from stt_core import TranscribeOptions, transcribe  # lazy: pulls torch/whisperx

    opts = TranscribeOptions(**overrides)
    opts.hf_token = os.environ.get("HF_TOKEN")
    if opts.diarize and not opts.hf_token:
        # Diarization needs the token; degrade to transcript-only rather than crash
        # so text WER is still measurable (DER/cpWER will be skipped).
        log(f"  [{config}] no HF_TOKEN -> running --no-diarize for {item.id}")
        opts.diarize = False

    log(f"  [{config}] transcribing {item.id} ({item.audio.name}) ...")
    t0 = time.time()
    result = transcribe(item.audio, opts, out_dir=cache_dir / "_scratch",
                        log=lambda m: None)
    elapsed = time.time() - t0
    d = result.to_dict()
    d["transcribe_seconds"] = elapsed
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return d


def _flatten_text(turns: list[dict]) -> str:
    return " ".join((t.get("text") or "").strip() for t in turns).strip()


def score_item(item: EvalItem, result: dict, config: str) -> ItemResult:
    """Score one transcription result against the item's reference."""
    ref_turns = item.reference_turns
    hyp_turns = result.get("turns", [])

    ref_text = _flatten_text(ref_turns)
    hyp_text = _flatten_text(hyp_turns)
    txt = score_text(ref_text, hyp_text)

    tr = term_recall(hyp_text, item.terms) if item.terms else None
    # cpWER needs only speaker LABELS (it concatenates text per speaker), so it
    # runs whenever the reference has speakers — this is the merged-speaker
    # false-pass catcher. DER additionally needs timestamps.
    cpobj = cpwer(ref_turns, hyp_turns)
    cp = cpobj.cpwer if cpobj else None
    der = diarization_error_rate(ref_turns, hyp_turns) if item.has_timing else None

    return ItemResult(
        id=item.id, config=config,
        wer=txt.wer, cer=txt.cer,
        term_recall=(tr.recall if tr else None),
        der=der, cpwer=cp,
        num_speakers_reported=int(result.get("num_speakers", 0)),
        num_speakers_true=_true_speaker_count(hyp_turns),
        ref_words=txt.ref_words,
        transcribe_seconds=result.get("transcribe_seconds"),
        detail={"text": txt.to_dict(), "term_recall": (tr.to_dict() if tr else None)},
    )


@dataclass
class ConfigAggregate:
    config: str
    n: int
    # WER and CER are BOTH micro-averaged (total errors / total ref units), so a
    # long clip isn't under-weighted vs a naive mean of per-item rates. WER is
    # word-weighted; CER is character-weighted.
    wer: float
    cer: float
    term_recall: Optional[float]   # mean per-item recall (macro); None if no terms
    der: Optional[float]
    cpwer: Optional[float]
    total_seconds: float
    items: list[ItemResult] = field(default_factory=list)


def _aggregate(config: str, results: list[ItemResult]) -> ConfigAggregate:
    # Micro-average WER: total word errors / total ref words.
    tot_ref_words = sum(r.ref_words for r in results) or 1
    tot_word_errs = sum(r.detail["text"]["insertions"] + r.detail["text"]["deletions"]
                        + r.detail["text"]["substitutions"] for r in results)
    wer = tot_word_errs / tot_ref_words

    # Micro-average CER: total char errors / total ref chars (properly weights long
    # clips, unlike a plain mean of per-item CER — verified as a real discrepancy).
    tot_ref_chars = sum(r.detail["text"].get("ref_chars", 0) for r in results) or 1
    tot_char_errs = sum(r.detail["text"].get("char_errors", 0) for r in results)
    cer = tot_char_errs / tot_ref_chars

    recs = [r.term_recall for r in results if r.term_recall is not None]
    ders = [r.der for r in results if r.der is not None]
    cps = [r.cpwer for r in results if r.cpwer is not None]
    return ConfigAggregate(
        config=config, n=len(results),
        wer=wer, cer=cer,
        term_recall=(sum(recs) / len(recs) if recs else None),
        der=(sum(ders) / len(ders) if ders else None),
        cpwer=(sum(cps) / len(cps) if cps else None),
        total_seconds=sum(r.transcribe_seconds or 0.0 for r in results),
        items=results,
    )


def run_eval(manifest_path: Path, configs: list[str], cache_dir: Path,
             log=print) -> dict[str, ConfigAggregate]:
    """Transcribe + score every manifest item under every config. Returns
    {config -> ConfigAggregate}."""
    manifest: Manifest = load_manifest(manifest_path)
    log(f"Manifest '{manifest.name}': {len(manifest.items)} item(s); configs: {', '.join(configs)}")
    out: dict[str, ConfigAggregate] = {}
    for config in configs:
        results: list[ItemResult] = []
        for item in manifest.items:
            if not item.audio.is_file():
                log(f"  [{config}] SKIP {item.id}: audio missing ({item.audio})")
                continue
            result = transcribe_item(item, config, cache_dir, log=log)
            results.append(score_item(item, result, config))
        out[config] = _aggregate(config, results)
    return out
