"""Clinical note generation as an importable function.

`generate(transcript, opts, progress)` runs the chosen provider and returns a
NoteResult. Like stt_core.transcribe it is PURE: it does not print and does not
write files — callers (CLI/API) decide how to surface the stream and persist
output. Progress flows through a structured NoteEvent callback (CLI -> stdout,
API -> SSE), exactly mirroring the transcription pipeline.
"""
from __future__ import annotations

from .extract import EXTRACTION_MARKER, split_note_and_lists
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
    # The model appends `EXTRACTION_MARKER` + a JSON block after the note (ADR-0023)
    # so problems/medications come from THIS single call — no second request. We
    # must NOT stream that marker/JSON to the client (they'd see raw JSON appear),
    # so we hold back a tail buffer: emit text as deltas only up to the point where
    # a marker prefix could begin. Once the marker appears, we stop emitting and
    # just accumulate the rest for parsing.
    emitted = 0            # chars of `full` already sent as deltas
    marker_seen = False
    full = ""
    hold = len(EXTRACTION_MARKER)
    try:
        for delta in provider.stream(system, user, opts, result):
            pieces.append(delta)
            full += delta
            if not marker_seen and EXTRACTION_MARKER in full:
                marker_seen = True
                # Emit any note text before the marker that we hadn't sent yet.
                cut = full.index(EXTRACTION_MARKER)
                if cut > emitted:
                    progress(NoteEvent(stage="generating", delta=full[emitted:cut]))
                    emitted = cut
            if marker_seen:
                continue
            # Safe-to-emit boundary: keep back the last `hold` chars in case they
            # are the start of the marker split across chunks.
            safe = len(full) - hold
            if safe > emitted:
                progress(NoteEvent(stage="generating", delta=full[emitted:safe]))
                emitted = safe
    except ProviderError as e:
        progress(NoteEvent(stage="error", message=str(e)))
        raise

    # Flush any remaining note text (when no marker was ever emitted).
    if not marker_seen and len(full) > emitted:
        progress(NoteEvent(stage="generating", delta=full[emitted:]))

    # Split the note from the trailing JSON block (fail-closed: no marker → whole
    # text is the note, empty lists).
    note_text, problems, medications = split_note_and_lists(full)
    result.note = note_text
    result.problems = problems
    result.medications = medications
    progress(NoteEvent(stage="done", message="note complete"))
    return result
