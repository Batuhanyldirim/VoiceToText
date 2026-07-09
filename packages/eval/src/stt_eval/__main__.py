"""CLI for the eval harness.

    # Score two configs on a manifest and print the A/B delta (loads ML models):
    python -m stt_eval run --manifest eval/manifests/smoke-en.json \
        --config baseline --config tr-2spk

    # Score a single already-produced transcript JSON against a reference (NO ML):
    python -m stt_eval score --ref eval/data/foo.ref.json --hyp out/foo.json

Run under `make eval` (see the Makefile). The `score` subcommand is pure-Python and
fast; `run` transcribes and is slow (large-v3 ~= 0.8x realtime).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _repo_root() -> Path:
    # packages/eval/src/stt_eval/__main__.py -> repo root is 4 parents up.
    return Path(__file__).resolve().parents[4]


def _load_turns(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "turns" in data:
        return data["turns"]
    if isinstance(data, list):
        return data
    raise ValueError(f"{path}: expected a list of turns or a dict with 'turns'")


def _cmd_score(args) -> int:
    """Score one hypothesis transcript against one reference — no ML load."""
    from .metrics import cpwer, diarization_error_rate, score_text, term_recall

    ref_turns = _load_turns(Path(args.ref))
    hyp_turns = _load_turns(Path(args.hyp))
    ref_text = " ".join((t.get("text") or "") for t in ref_turns).strip()
    hyp_text = " ".join((t.get("text") or "") for t in hyp_turns).strip()

    txt = score_text(ref_text, hyp_text)
    print(f"WER: {txt.wer * 100:.1f}%  CER: {txt.cer * 100:.1f}%  "
          f"(ins {txt.insertions} del {txt.deletions} sub {txt.substitutions}, "
          f"ref {txt.ref_words} words)")

    # cpWER needs only speaker labels; DER additionally needs timestamps.
    cp = cpwer(ref_turns, hyp_turns)
    if cp is not None:
        print(f"cpWER: {cp.cpwer * 100:.1f}% (ref {cp.ref_speakers} spk, hyp {cp.hyp_speakers} spk)")
    has_timing = any(t.get("start") is not None and t.get("end") is not None for t in ref_turns)
    if has_timing:
        der = diarization_error_rate(ref_turns, hyp_turns)
        print(f"DER: {der * 100:.1f}%" if der is not None else "DER: n/a")
    if args.terms:
        terms = [t.strip() for t in args.terms.split(",") if t.strip()]
        tr = term_recall(hyp_text, terms)
        rec = f"{tr.recall * 100:.1f}%" if tr.recall is not None else "n/a"
        print(f"term recall: {rec} ({tr.found}/{tr.total}); missing: {tr.missing}")
    return 0


def _cmd_run(args) -> int:
    """Transcribe + score a manifest under configs — loads ML models (slow)."""
    from .report import ab_delta, per_item_table, summary_table
    from .run import run_eval

    root = _repo_root()
    manifest_path = Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path = (root / manifest_path).resolve()
    cache_dir = Path(args.cache_dir) if args.cache_dir else (root / "eval" / "cache")

    configs = args.config or ["baseline"]
    aggs = run_eval(manifest_path, configs, cache_dir, log=print)

    print("\n" + summary_table(aggs))
    if args.per_item:
        for c in configs:
            print(per_item_table(aggs[c]))
    if len(configs) == 2:
        print(ab_delta(aggs, configs[0], configs[1]))

    if args.json_out:
        out = {c: {"aggregate": {k: v for k, v in vars(a).items() if k != "items"},
                   "items": [vars(i) for i in a.items]}
               for c, a in aggs.items()}
        Path(args.json_out).write_text(json.dumps(out, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
        print(f"\nwrote {args.json_out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="stt_eval", description="Turkish transcription accuracy harness")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="transcribe a manifest under configs and score (slow, loads ML)")
    r.add_argument("--manifest", required=True, help="path to a manifest JSON (rel to repo root ok)")
    r.add_argument("--config", action="append", help="named config (repeatable; 1st=baseline for A/B)")
    r.add_argument("--cache-dir", default=None, help="transcription cache dir (default: eval/cache)")
    r.add_argument("--per-item", action="store_true", help="print per-item breakdown")
    r.add_argument("--json-out", default=None, help="write full results to this JSON path")
    r.set_defaults(func=_cmd_run)

    s = sub.add_parser("score", help="score one hypothesis vs one reference (fast, no ML)")
    s.add_argument("--ref", required=True, help="reference turns JSON (list or {turns:[...]})")
    s.add_argument("--hyp", required=True, help="hypothesis transcript JSON (out/<stem>.json)")
    s.add_argument("--terms", default=None, help="comma-separated medical terms for recall")
    s.set_defaults(func=_cmd_score)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
