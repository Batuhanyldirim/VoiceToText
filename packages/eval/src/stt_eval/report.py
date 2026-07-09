"""Human-readable rendering of eval results: a per-config summary table and, for
two configs, an A-vs-B delta with a clear better/worse verdict per metric.

Lower is better for WER/CER/DER/cpWER; HIGHER is better for term recall. The delta
line spells this out so a green number always means "improvement".
"""
from __future__ import annotations

from .run import ConfigAggregate


def _fmt(v, pct=True):
    if v is None:
        return "  n/a"
    return f"{v * 100:5.1f}%" if pct else f"{v:6.2f}"


def summary_table(aggs: dict[str, ConfigAggregate]) -> str:
    lines = []
    header = f"{'config':<12} {'n':>3} {'WER':>7} {'CER':>7} {'termR':>7} {'DER':>7} {'cpWER':>7} {'secs':>7}"
    lines.append(header)
    lines.append("-" * len(header))
    for name, a in aggs.items():
        lines.append(
            f"{name:<12} {a.n:>3} {_fmt(a.wer)} {_fmt(a.cer)} "
            f"{_fmt(a.term_recall)} {_fmt(a.der)} {_fmt(a.cpwer)} {a.total_seconds:6.1f}s")
    return "\n".join(lines)


def _delta_line(label, base, cand, higher_better=False):
    if base is None or cand is None:
        return f"  {label:<8} {_fmt(base)} -> {_fmt(cand)}   (n/a)"
    d = cand - base
    improved = (d > 0) if higher_better else (d < 0)
    arrow = "improved" if improved else ("worse" if d != 0 else "same")
    sign = "+" if d >= 0 else ""
    return f"  {label:<8} {_fmt(base)} -> {_fmt(cand)}   {sign}{d * 100:5.1f}pp  {arrow}"


def ab_delta(aggs: dict[str, ConfigAggregate], a: str, b: str) -> str:
    """Render A (baseline) vs B (candidate) with per-metric verdicts."""
    ca, cb = aggs[a], aggs[b]
    lines = [f"\nA/B: {a} (baseline) vs {b} (candidate)"]
    lines.append(_delta_line("WER", ca.wer, cb.wer))
    lines.append(_delta_line("CER", ca.cer, cb.cer))
    lines.append(_delta_line("termR", ca.term_recall, cb.term_recall, higher_better=True))
    lines.append(_delta_line("DER", ca.der, cb.der))
    lines.append(_delta_line("cpWER", ca.cpwer, cb.cpwer))
    return "\n".join(lines)


def per_item_table(agg: ConfigAggregate) -> str:
    lines = [f"\nper-item [{agg.config}]:"]
    lines.append(f"  {'id':<20} {'WER':>7} {'CER':>7} {'cpWER':>7} {'spk(rep/true)':>14}")
    for r in agg.items:
        lines.append(
            f"  {r.id:<20} {_fmt(r.wer)} {_fmt(r.cer)} {_fmt(r.cpwer)} "
            f"{str(r.num_speakers_reported) + '/' + str(r.num_speakers_true):>14}")
    return "\n".join(lines)
