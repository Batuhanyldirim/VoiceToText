"""Structured problem/medication extraction from a note (ADR-0023).

`extract(text, opts)` reuses the SAME pluggable provider seam as note generation
(local Ollama by default; cloud gated) — so PHI stays on-device on the default
path and no new AI transport is introduced. It asks the model for STRICT JSON,
grounded ONLY in the given text, in Turkish, and parses it defensively: it
tolerates code fences / surrounding prose, coerces to the schema, drops malformed
entries, and — critically — **fails closed to empty lists** rather than
fabricating or raising. Pure: no printing, no file writes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .models import NoteOptions, NoteResult
from .providers import ProviderError, get_provider


@dataclass
class ExtractionResult:
    provider: str
    model: str
    problems: list = field(default_factory=list)      # [{name, status?, detail?}]
    medications: list = field(default_factory=list)    # [{name, dose?, route?, frequency?}]

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "problems": self.problems,
            "medications": self.medications,
        }


EXTRACTION_SYSTEM_PROMPT = """\
Sen bir klinik bilgi çıkarım aracısın. Sana verilen klinik NOT metninden yapılandırılmış \
iki liste çıkar: (1) sorun/tanı listesi, (2) ilaç listesi.

KESİN KURALLAR:
- YALNIZCA verilen notta açıkça geçen bilgileri kullan. Hiçbir şey UYDURMA, tahmin \
  yürütme, örnek ekleme. Notta yoksa listeye koyma.
- Çıktı DİLİ Türkçe olsun (isimler notta nasıl geçiyorsa öyle bırakılabilir).
- SADECE ve SADECE geçerli bir JSON nesnesi döndür. Kod bloğu, açıklama, önsöz ekleme.

JSON şeması (alanlar yoksa atla, uydurma):
{
  "problems": [ { "name": "...", "status": "aktif|geçmiş|... (opsiyonel)", "detail": "kısa ayrıntı (opsiyonel)" } ],
  "medications": [ { "name": "...", "dose": "(ops.)", "route": "(ops.)", "frequency": "(ops.)" } ]
}

Not boşsa veya ilgili bilgi yoksa ilgili listeyi boş dizi olarak döndür: {"problems": [], "medications": []}."""


def _build_user_prompt(text: str) -> str:
    return (
        "Aşağıdaki klinik nottan sorun ve ilaç listelerini çıkar. "
        "Yalnızca JSON döndür.\n\n"
        "=== NOT ===\n"
        f"{text.strip()}\n"
        "=== NOT SONU ===\n"
    )


def _extract_json_object(raw: str) -> dict | None:
    """Best-effort: pull the first balanced {...} JSON object out of model output
    that may be wrapped in ```json fences or surrounded by prose. Returns None if
    nothing parses."""
    if not raw:
        return None
    s = raw.strip()
    # Fast path: the whole thing is JSON.
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else None
    except ValueError:
        pass
    # Strip common code-fence wrappers.
    if "```" in s:
        # take the content of the first fenced block if present
        parts = s.split("```")
        for part in parts:
            p = part.strip()
            if p.startswith("json"):
                p = p[4:].strip()
            if p.startswith("{"):
                s = p
                break
    # Scan for the first balanced object.
    start = s.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                candidate = s[start:i + 1]
                try:
                    obj = json.loads(candidate)
                    return obj if isinstance(obj, dict) else None
                except ValueError:
                    return None
    return None


def _clean_problems(items) -> list:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if isinstance(it, str) and it.strip():
            out.append({"name": it.strip()})
        elif isinstance(it, dict):
            name = str(it.get("name") or "").strip()
            if not name:
                continue
            entry = {"name": name}
            for k in ("status", "detail"):
                v = it.get(k)
                if isinstance(v, str) and v.strip():
                    entry[k] = v.strip()
            out.append(entry)
    return out


def _clean_medications(items) -> list:
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if isinstance(it, str) and it.strip():
            out.append({"name": it.strip()})
        elif isinstance(it, dict):
            name = str(it.get("name") or "").strip()
            if not name:
                continue
            entry = {"name": name}
            for k in ("dose", "route", "frequency"):
                v = it.get(k)
                if isinstance(v, str) and v.strip():
                    entry[k] = v.strip()
            out.append(entry)
    return out


def parse_extraction(raw: str) -> tuple[list, list]:
    """Parse model output into (problems, medications). Fail-closed to ([],[])."""
    obj = _extract_json_object(raw)
    if not isinstance(obj, dict):
        return [], []
    return _clean_problems(obj.get("problems")), _clean_medications(obj.get("medications"))


def extract(text: str, opts: NoteOptions | None = None) -> ExtractionResult:
    """Extract a problem list + medication list from note `text` via the configured
    provider. Grounded, Turkish, strict-JSON; fails closed to empty lists on
    unparseable output. Raises ProviderError only for provider-level failures
    (unreachable/misconfigured/off-device-not-opted-in) — never for bad content."""
    opts = opts or NoteOptions()
    if not text or not text.strip():
        provider_name = (opts.provider or "ollama")
        return ExtractionResult(provider=provider_name, model=opts.resolved_model())

    provider = get_provider(opts.provider)  # reuses the gated seam (ADR-0009)
    result_box = NoteResult(
        provider=provider.name, model=opts.resolved_model(), template="extract", note=""
    )
    pieces: list[str] = []
    # ProviderError propagates (caller surfaces it); content problems do not.
    for delta in provider.stream(EXTRACTION_SYSTEM_PROMPT, _build_user_prompt(text), opts, result_box):
        pieces.append(delta)
    problems, medications = parse_extraction("".join(pieces))
    return ExtractionResult(
        provider=provider.name,
        model=opts.resolved_model(),
        problems=problems,
        medications=medications,
    )


__all__ = ["extract", "parse_extraction", "ExtractionResult"]
