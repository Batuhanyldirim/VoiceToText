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
from .review import REVIEW_MARKER, parse_review_flags
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
    # The model appends TWO trailing machine-readable blocks after the note, each
    # behind a sentinel: EXTRACTION_MARKER (problems/meds, ADR-0023) then
    # REVIEW_MARKER (STT-review flags, ADR-0029). Both come from THIS single call —
    # no extra request. We must NOT stream either marker/JSON to the client, so we
    # stop emitting at whichever marker appears FIRST (the note is everything before
    # it) and just accumulate the rest for parsing. Until then we hold back a tail
    # buffer in case a marker is split across streamed chunks.
    emitted = 0            # chars of `full` already sent as deltas
    marker_seen = False
    full = ""
    hold = max(len(EXTRACTION_MARKER), len(REVIEW_MARKER))

    def _first_marker_index(text: str) -> int:
        idxs = [text.find(m) for m in (EXTRACTION_MARKER, REVIEW_MARKER)]
        idxs = [i for i in idxs if i != -1]
        return min(idxs) if idxs else -1

    try:
        for delta in provider.stream(system, user, opts, result):
            pieces.append(delta)
            full += delta
            if not marker_seen:
                cut = _first_marker_index(full)
                if cut != -1:
                    marker_seen = True
                    # Emit any note text before the first marker not yet sent.
                    if cut > emitted:
                        progress(NoteEvent(stage="generating", delta=full[emitted:cut]))
                        emitted = cut
            if marker_seen:
                continue
            # Safe-to-emit boundary: keep back the last `hold` chars in case they
            # are the start of a marker split across chunks.
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

    # Split the note from the trailing JSON blocks (fail-closed: no marker → whole
    # text is the note, empty lists). split_note_and_lists splits on the FIRST
    # marker, so the note never includes either JSON block.
    note_text, problems, medications = split_note_and_lists(full)
    result.note = note_text
    result.problems = problems
    result.medications = medications
    result.review_flags = parse_review_flags(full)
    progress(NoteEvent(stage="done", message="note complete"))
    return result
