"""Reference-set manifest: the fixed audio + ground-truth references we score
against.

A manifest is a JSON file describing one evaluation set:

    {
      "name": "smoke-en",
      "notes": "Committed, PHI-free smoke set (synthetic conversation.wav).",
      "items": [
        {
          "id": "conversation",
          "audio": "samples/conversation.wav",     # relative to repo root
          "reference": "eval/data/conversation.ref.json",  # or inline "turns"
          "terms": ["proje", "bütçe"]              # optional medical terms
        }
      ]
    }

A reference is a list of ground-truth turns: [{"speaker","text","start","end"}].
`speaker` uses stable labels ("Speaker 1"/"Speaker 2"); `start`/`end` are optional
but REQUIRED for DER/cpWER. References may be inline (`"turns": [...]`) or point to
a separate JSON file (`"reference": "path.json"`) so PHI references stay in the
git-ignored `eval/data/`.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class EvalItem:
    id: str
    audio: Path
    reference_turns: list[dict]
    terms: list[str] = field(default_factory=list)

    @property
    def has_timing(self) -> bool:
        return any(t.get("start") is not None and t.get("end") is not None
                   for t in self.reference_turns)


@dataclass
class Manifest:
    name: str
    items: list[EvalItem]
    notes: str = ""
    path: Optional[Path] = None


def _load_reference(entry: dict, root: Path) -> list[dict]:
    """Resolve an item's ground-truth turns from inline `turns` or a `reference`
    file path (relative to repo root)."""
    if "turns" in entry:
        turns = entry["turns"]
    elif "reference" in entry:
        ref_path = (root / entry["reference"]).resolve()
        if not ref_path.is_file():
            raise FileNotFoundError(
                f"reference file for item '{entry.get('id')}' not found: {ref_path}\n"
                f"(PHI references live git-ignored under eval/data/ — see eval/README.md)")
        data = json.loads(ref_path.read_text(encoding="utf-8"))
        # Accept either a bare list of turns or a TranscribeResult-shaped dict.
        turns = data["turns"] if isinstance(data, dict) and "turns" in data else data
    else:
        raise ValueError(f"item '{entry.get('id')}' has neither 'turns' nor 'reference'")
    if not isinstance(turns, list):
        raise ValueError(f"item '{entry.get('id')}' reference is not a list of turns")
    return turns


def load_manifest(manifest_path: Path, root: Optional[Path] = None) -> Manifest:
    """Parse a manifest JSON. `root` defaults to the repo root inferred from the
    manifest location (manifest lives at <root>/eval/manifests/<name>.json)."""
    manifest_path = Path(manifest_path).resolve()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    # Infer repo root: manifests live under eval/manifests/, so root is two up.
    root = Path(root).resolve() if root else manifest_path.parent.parent.parent

    items: list[EvalItem] = []
    for entry in data.get("items", []):
        audio = (root / entry["audio"]).resolve()
        items.append(EvalItem(
            id=entry["id"],
            audio=audio,
            reference_turns=_load_reference(entry, root),
            terms=list(entry.get("terms", [])),
        ))
    return Manifest(name=data.get("name", manifest_path.stem),
                    items=items, notes=data.get("notes", ""),
                    path=manifest_path)
