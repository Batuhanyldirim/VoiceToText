"""LLM-assisted speaker RE-LABELING for clinical dialogue (ADR-0030).

Acoustic diarization (pyannote) struggles when two speakers have SIMILAR voices and
take DOZENS of very short turns — it collapses ~90% of speech into one cluster
(measured on a real pediatric intake). But a Turkish clinical intake has a rigid,
text-visible structure: the DOCTOR asks short questions, the PARENT/patient answers.
That structure lets a local LLM re-assign a ROLE to each turn from conversational
logic — recovering the doctor/patient split the acoustics couldn't.

This is a POST-PROCESS over the transcript turns, reusing the same pluggable,
PHI-local provider seam as note generation (ADR-0009; Ollama default). It is:
  - REVIEWABLE, never silent: it returns a NEW labeling + a confidence, and the
    caller decides whether to apply it (the web review page shows it as a suggestion,
    like the STT-error flags of ADR-0029). It never overwrites the acoustic labels
    in place without the doctor seeing it.
  - FAIL-CLOSED: any parse problem, coverage gap, or low agreement -> keep the
    original acoustic labels. It maps roles BY TURN INDEX (never by re-quoting text),
    so the LLM cannot drop/insert/reorder turns.
  - Grounded: the LLM only assigns one of a fixed small role set to each existing
    turn; it does not rewrite text or invent turns.

Pure: no printing, no file writes. Heavy nothing — just the provider HTTP call.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .extract import _extract_json_object
from .models import NoteOptions, NoteResult
from .providers import get_provider

# Fixed role vocabulary. Two dominant roles + escape hatches. Turkish-facing labels
# are mapped to display speaker names by the caller.
ROLES = ("doktor", "hasta", "diger")
ROLE_DISPLAY = {"doktor": "Doktor", "hasta": "Hasta/Yakın", "diger": "Diğer"}

RELABEL_SYSTEM_PROMPT = """\
Sen bir klinik konuşma çözümleme aracısın. Sana NUMARALANMIŞ konuşma sıraları (turn)
verilecek: bir doktor-hasta muayene görüşmesinin deşifresi. Görevin, HER SIRAYI
konuşan role göre etiketlemek. Bu görüşme tipik bir muayene: DOKTOR kısa sorular
sorar ("Doğum tarihi ne zaman?", "Kaç aylıktı?", "Peki?"), HASTA/YAKINI cevap verir
("2017", "6 aylık", "Evet hocam", "hocam biz...").

KURALLAR:
- Her sıra için tam olarak şu etiketlerden BİRİNİ ver: "doktor", "hasta", "diger".
- Soru soran / muayeneyi yöneten / klinik dil kullanan = "doktor".
- Şikayet/öykü anlatan, soruları cevaplayan, "hocam" diye hitap eden = "hasta".
- Bir soru ile onun HEMEN ARDINDAN gelen cevap FARKLI rollerdir.
- Emin olamadığın nadir sıralar için "diger" kullan (örn. 3. bir kişi).
- Metni DEĞİŞTİRME, sıra EKLEME/ÇIKARMA. Sadece rol ata.

SADECE geçerli bir JSON nesnesi döndür (kod bloğu/açıklama yok). Anahtar her sıranın
NUMARASI (string), değeri rol:
{"roles": {"0": "doktor", "1": "hasta", "2": "doktor", ...}}
Her verilen sıra numarası için bir rol olmalı."""


@dataclass
class RelabelResult:
    provider: str
    model: str
    # New speaker label per input turn index (parallel to the input turns), or None
    # entries where the model gave no/invalid role. Display names, not roles.
    labels: list = field(default_factory=list)
    roles: list = field(default_factory=list)          # raw role per turn ("doktor"/...)
    coverage: float = 0.0                                # fraction of turns labeled
    n_roles: int = 0                                     # distinct roles assigned
    applied: bool = False                                # did caller-side guard accept it?

    def to_dict(self) -> dict:
        return {"provider": self.provider, "model": self.model, "labels": self.labels,
                "roles": self.roles, "coverage": self.coverage, "n_roles": self.n_roles,
                "applied": self.applied}


def _build_user_prompt(turns: list) -> str:
    lines = ["Sıralar (numara: metin):", ""]
    for i, t in enumerate(turns):
        txt = (t.get("text") or "").replace("\n", " ").strip()
        # Cap each line so a pathological turn can't blow the context.
        lines.append(f"{i}: {txt[:400]}")
    lines.append("")
    lines.append('Şimdi her sıra numarası için rol ver. SADECE JSON: {"roles": {...}}')
    return "\n".join(lines)


def parse_roles(raw: str, n_turns: int) -> list:
    """Parse the model's {"roles": {"0":"doktor",...}} into a role-per-index list of
    length n_turns (None where missing/invalid). Fail-closed: bad JSON -> all None."""
    out = [None] * n_turns
    obj = _extract_json_object(raw)
    if not isinstance(obj, dict):
        return out
    roles = obj.get("roles")
    if not isinstance(roles, dict):
        return out
    for k, v in roles.items():
        try:
            i = int(k)
        except (TypeError, ValueError):
            continue
        if 0 <= i < n_turns and isinstance(v, str) and v.strip().lower() in ROLES:
            out[i] = v.strip().lower()
    return out


def relabel_turns(turns: list, opts: NoteOptions | None = None) -> RelabelResult:
    """Ask the local LLM to assign a role (doktor/hasta/diger) to each transcript
    turn, and return a proposed re-labeling. Does NOT mutate `turns`. Raises
    ProviderError only for provider-level failures; content problems fail closed."""
    opts = opts or NoteOptions()
    n = len(turns or [])
    provider = get_provider(opts.provider)
    res = RelabelResult(provider=provider.name, model=opts.resolved_model())
    if n == 0:
        return res

    box = NoteResult(provider=provider.name, model=opts.resolved_model(),
                     template="rediar", note="")
    pieces: list[str] = []
    for delta in provider.stream(RELABEL_SYSTEM_PROMPT, _build_user_prompt(turns), opts, box):
        pieces.append(delta)
    roles = parse_roles("".join(pieces), n)

    labeled = [r for r in roles if r is not None]
    res.roles = roles
    res.coverage = len(labeled) / n if n else 0.0
    res.n_roles = len({r for r in labeled})
    # Map roles -> stable display speaker names (fall back to the original speaker
    # label where the model gave no role, so nothing is lost).
    res.labels = [
        ROLE_DISPLAY.get(roles[i]) if roles[i] is not None else (turns[i].get("speaker") or "Konuşmacı")
        for i in range(n)
    ]
    return res


def apply_relabel(turns: list, result: RelabelResult, *, min_coverage: float = 0.8,
                  min_roles: int = 2) -> list:
    """Return turns with speakers replaced by the LLM roles, but ONLY if the
    relabeling passes the acceptance guard (enough coverage AND >=2 distinct roles);
    otherwise return the ORIGINAL turns unchanged (fail-closed). Marks accepted turns
    with role_relabeled=True so the UI can show/undo it. Never mutates the input."""
    if result.coverage < min_coverage or result.n_roles < min_roles:
        return list(turns)
    out = []
    for i, t in enumerate(turns):
        nt = dict(t)
        nt["speaker"] = result.labels[i]
        nt["role_relabeled"] = True
        out.append(nt)
    result.applied = True
    return out


__all__ = ["relabel_turns", "apply_relabel", "parse_roles", "RelabelResult",
           "ROLES", "ROLE_DISPLAY", "RELABEL_SYSTEM_PROMPT"]
