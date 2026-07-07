"""Progress reporting: a structured callback + the stdout interceptor that
turns WhisperX's 'Progress: X%' prints into ProgressEvents.

The CLI wires this to a tqdm bar; the API wires it to an asyncio.Queue → SSE.
"""
from __future__ import annotations

import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Optional

# Pipeline stages, in order. Only "transcribe" reports fine-grained percent;
# the rest are indeterminate steps (transcribe dominates runtime).
STAGES = ["enhance", "transcribe", "align", "diarize", "fuse", "done"]


@dataclass
class ProgressEvent:
    stage: str                       # one of STAGES
    percent: Optional[float] = None  # 0..100 during "transcribe"; None otherwise
    message: Optional[str] = None


ProgressCallback = Callable[[ProgressEvent], None]

# No-op default so callers can omit progress entirely.
def noop(_event: ProgressEvent) -> None:  # pragma: no cover - trivial
    pass


_PROGRESS_RE = re.compile(r"Progress:\s*([\d.]+)%")


@contextmanager
def capture_transcribe_progress(progress: ProgressCallback):
    """While active, intercept stdout: lines matching 'Progress: X%' become
    ProgressEvent(stage='transcribe', percent=X); everything else passes through.

    WhisperX prints these lines when transcribe(print_progress=True). This keeps
    the parsing identical to the original CLI's tqdm shim, but routes it to a
    structured callback instead of a bar.
    """
    real_stdout = sys.stdout

    class _Interceptor:
        def write(self, s):
            m = _PROGRESS_RE.search(s)
            if m:
                progress(ProgressEvent(stage="transcribe", percent=min(float(m.group(1)), 100.0)))
            elif s.strip():
                real_stdout.write(s)

        def flush(self):
            real_stdout.flush()

    sys.stdout = _Interceptor()
    try:
        yield
    finally:
        sys.stdout = real_stdout
