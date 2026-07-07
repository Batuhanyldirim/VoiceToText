"""Clinical note generation as an importable function.

`generate(transcript, opts, progress)` runs the chosen provider and returns a
NoteResult. Like stt_core.transcribe it is PURE: it does not print and does not
write files — callers (CLI/API) decide how to surface the stream and persist
output. Progress flows through a structured NoteEvent callback (CLI -> stdout,
API -> SSE), exactly mirroring the transcription pipeline.
"""
from __future__ import annotations

from .models import NoteOptions, NoteResult
from .progress import NoteCallback, NoteEvent, noop
from .prompt import CLINICAL_SYSTEM_PROMPT, build_user_prompt
from .providers import ProviderError, get_provider
from .templates import resolve_template_text


class EmptyTranscriptError(ValueError):
    """Raised when there is no transcript text to turn into a note."""


def generate(
    transcript: str,
    opts: NoteOptions | None = None,
    progress: NoteCallback = noop,
) -> NoteResult:
    """Generate a clinical note from a transcript. Streams token deltas through
    `progress` and returns the assembled NoteResult.

    Raises EmptyTranscriptError, ValueError (bad template), or ProviderError
    (unreachable/misconfigured provider) — all with user-safe messages that never
    contain a secret."""
    opts = opts or NoteOptions()

    if not transcript or not transcript.strip():
        raise EmptyTranscriptError("transcript is empty — nothing to summarize.")

    # Resolve the sample format (raises ValueError on bad/empty template).
    template_text = resolve_template_text(opts.template, opts.template_text)

    # Resolve the provider (raises ProviderError if cloud is requested but the
    # operator hasn't opted in — no data is sent in that case).
    provider = get_provider(opts.provider)

    system = CLINICAL_SYSTEM_PROMPT
    user = build_user_prompt(template_text, transcript)

    result = NoteResult(
        provider=provider.name,
        model=opts.resolved_model(),
        template=opts.template,
        note="",
    )

    progress(NoteEvent(stage="start", message=f"generating note via {provider.name}"))
    pieces: list[str] = []
    try:
        for delta in provider.stream(system, user, opts, result):
            pieces.append(delta)
            progress(NoteEvent(stage="generating", delta=delta))
    except ProviderError as e:
        progress(NoteEvent(stage="error", message=str(e)))
        raise

    result.note = "".join(pieces)
    progress(NoteEvent(stage="done", message="note complete"))
    return result
