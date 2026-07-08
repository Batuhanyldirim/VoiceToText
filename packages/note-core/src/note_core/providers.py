"""Pluggable AI providers for note generation.

Both providers use the SAME call shape — a `system` prompt + a `user` prompt —
and stream text deltas. They differ only in transport:

  - OllamaProvider (default, local, offline): POST /api/chat on localhost.
    PHI never leaves the machine (ADR-0009). This is the default path.
  - ClaudeProvider (opt-in, cloud): the Anthropic SDK. Only reachable when the
    OPERATOR sets STT_NOTE_PROVIDER=claude and a token in the server env; the
    transcript is sent to Anthropic, so callers must warn the user.

Heavy imports (anthropic) are lazy — importing this module must not require the
optional SDK, so the local-only install stays minimal (mirrors stt_core's lazy
whisperx/torch imports).
"""
from __future__ import annotations

import json
import os
from typing import Iterator, Protocol

from .models import NoteOptions, NoteResult

# Local Ollama endpoint. Honors OLLAMA_HOST (set by env.sh) so a non-default
# host/port is respected; falls back to the documented default.
_OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434")
if not _OLLAMA_HOST.startswith(("http://", "https://")):
    _OLLAMA_HOST = f"http://{_OLLAMA_HOST}"
OLLAMA_URL = _OLLAMA_HOST.rstrip("/") + "/api/chat"


class ProviderError(RuntimeError):
    """Raised for provider-level failures (unreachable server, missing token,
    HTTP errors). The message is safe to surface to the user — it never contains
    a secret."""


class Provider(Protocol):
    """A note-generation backend. `stream()` yields text deltas and, when the
    stream ends, the implementation records usage on the passed-in result box."""

    name: str

    def stream(self, system: str, user: str, opts: NoteOptions,
               result: NoteResult) -> Iterator[str]:
        ...


class OllamaProvider:
    """Default, fully-local provider. Talks plain HTTP to a localhost Ollama
    server (VERIFIED shape: POST /api/chat, streamed NDJSON chunks each with
    {"message": {"content": "..."}, "done": bool})."""

    name = "ollama"

    def stream(self, system: str, user: str, opts: NoteOptions,
               result: NoteResult) -> Iterator[str]:
        import httpx  # (light, but keep the import local to the call for symmetry)

        model = opts.resolved_model()
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": True,
            # num_ctx matters: transcripts + prompt are long and Ollama's default
            # context is small, silently truncating input. Set it generously.
            "options": {"num_ctx": opts.num_ctx, "temperature": opts.temperature},
        }
        try:
            # No overall timeout: local CPU/Metal generation of a full note can
            # take minutes. connect timeout stays short so an unreachable server
            # fails fast with a clear message.
            with httpx.Client(timeout=httpx.Timeout(None, connect=5.0)) as client:
                with client.stream("POST", OLLAMA_URL, json=payload) as resp:
                    if resp.status_code == 404:
                        raise ProviderError(
                            f"Ollama has no model '{model}'. Pull it first: "
                            f"`ollama pull {model}` (with OLLAMA_MODELS set by env.sh)."
                        )
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        chunk = json.loads(line)
                        if chunk.get("error"):
                            raise ProviderError(f"Ollama error: {chunk['error']}")
                        piece = chunk.get("message", {}).get("content", "")
                        if piece:
                            yield piece
                        if chunk.get("done"):
                            result.usage = {
                                k: chunk[k]
                                for k in (
                                    "total_duration", "load_duration",
                                    "prompt_eval_count", "eval_count",
                                    "eval_duration", "done_reason",
                                )
                                if k in chunk
                            }
                            # Ollama reports "length" when it hit num_predict.
                            result.stopped_early = chunk.get("done_reason") == "length"
                            break
        except ProviderError:
            raise
        except httpx.ConnectError as e:
            raise ProviderError(
                "Could not reach the local Ollama server at "
                f"{OLLAMA_URL}. Start it with `ollama serve` (env.sh sets "
                "OLLAMA_MODELS so downloads stay in the project)."
            ) from e
        except httpx.HTTPStatusError as e:
            raise ProviderError(f"Ollama returned HTTP {e.response.status_code}.") from e
        except httpx.HTTPError as e:
            raise ProviderError(f"Ollama request failed: {type(e).__name__}.") from e


class ClaudeProvider:
    """Opt-in cloud provider (Anthropic Claude). Reachable ONLY when the operator
    sets STT_NOTE_PROVIDER=claude and provides a token in the server env
    (ANTHROPIC_API_KEY or STT_CLAUDE_API_KEY). The transcript IS sent to
    Anthropic — callers must have shown the user the PHI warning (ADR-0009).

    The token is read from the server environment only; it is never logged, never
    returned, and never accepted from the browser."""

    name = "claude"

    def _api_key(self) -> str:
        key = (os.environ.get("STT_CLAUDE_API_KEY")
               or os.environ.get("ANTHROPIC_API_KEY"))
        if not key:
            raise ProviderError(
                "Claude provider selected but no API key is set on the server. "
                "Set STT_CLAUDE_API_KEY (or ANTHROPIC_API_KEY) in the environment "
                "that started the API, or use the default local provider."
            )
        return key

    def stream(self, system: str, user: str, opts: NoteOptions,
               result: NoteResult) -> Iterator[str]:
        try:
            import anthropic  # lazy: optional dependency (uv sync --extra claude)
        except ImportError as e:
            raise ProviderError(
                "The Claude provider needs the Anthropic SDK, which is not "
                "installed. Install it with `uv sync --extra claude`, or use the "
                "default local provider."
            ) from e

        key = self._api_key()
        client = anthropic.Anthropic(api_key=key)
        model = opts.resolved_model()
        try:
            # Stream so a long note doesn't hit request timeouts. Adaptive
            # thinking off keeps this a straight extraction task; the note is the
            # visible answer.
            with client.messages.stream(
                model=model,
                max_tokens=opts.max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            ) as stream:
                for piece in stream.text_stream:
                    if piece:
                        yield piece
                final = stream.get_final_message()
            result.stopped_early = final.stop_reason == "max_tokens"
            result.usage = {
                "input_tokens": final.usage.input_tokens,
                "output_tokens": final.usage.output_tokens,
                "stop_reason": final.stop_reason,
            }
        except ProviderError:
            raise
        except anthropic.APIError as e:  # never leak the token; report the class
            raise ProviderError(f"Claude API error: {type(e).__name__}.") from e


# --- Optional local provider plugin seam -----------------------------------
# Deployments can drop in extra, environment-specific providers (e.g. one that
# shells out to a locally-authenticated CLI) without touching committed code, by
# adding a `_local_providers` module next to this one. It is entirely optional:
# if absent, only the built-in providers exist. Each entry is filtered by an
# `available()` predicate so a provider that can't run on this machine never
# appears. This keeps machine-specific integrations out of version control.
def _local_registry() -> tuple[dict, list[dict]]:
    """Return (factories, descriptors) from the optional _local_providers module.
    factories: {key: callable() -> Provider}. descriptors: list of dicts with at
    least {key, label, models, default_model, off_device, available}."""
    try:
        from . import _local_providers as lp  # type: ignore  # optional, may be absent
        return dict(getattr(lp, "PROVIDERS", {})), list(getattr(lp, "DESCRIPTORS", []))
    except Exception:  # noqa: BLE001 - a broken/absent plugin must never break the app
        return {}, []


def _provider_allowlist() -> set[str]:
    """Providers the operator has enabled, from STT_NOTE_PROVIDERS (comma list).
    Default 'ollama' — so committed/default config exposes only the local model
    and any off-device or plugin provider must be turned on deliberately."""
    raw = os.environ.get("STT_NOTE_PROVIDERS", "ollama")
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def get_provider(name: str) -> Provider:
    """Resolve a provider by name. The cloud provider is gated: it is only
    returned when the OPERATOR has explicitly selected it via STT_NOTE_PROVIDER
    (REQ-102). A request that asks for 'claude' without that server-side opt-in
    is refused here, before any data is sent. Local-plugin providers are consulted
    last (and only if enabled/available)."""
    name = (name or "").strip().lower()
    if name in ("ollama", ""):
        return OllamaProvider()
    if name == "claude":
        if os.environ.get("STT_NOTE_PROVIDER", "ollama").strip().lower() != "claude":
            raise ProviderError(
                "The cloud (Claude) provider is not enabled on this server. It "
                "sends the transcript off-device, so it must be turned on "
                "explicitly by the operator (set STT_NOTE_PROVIDER=claude in the "
                "server environment). No data was sent."
            )
        return ClaudeProvider()
    factories, _ = _local_registry()
    if name in factories:
        return factories[name]()
    raise ProviderError(f"unknown provider '{name}'.")


def list_providers() -> list[dict]:
    """Descriptors for every provider the UI may offer, filtered by the operator
    allowlist (STT_NOTE_PROVIDERS) and each provider's own availability. Shape per
    entry: {key, label, models: [{id, label}], default_model, off_device: bool}.
    The built-in local model is always described; the first-party cloud provider
    only when its env opt-in is set; plugin providers only when available()."""
    from .models import DEFAULT_OLLAMA_MODEL, DEFAULT_CLAUDE_MODEL

    allow = _provider_allowlist()
    out: list[dict] = []

    if "ollama" in allow:
        out.append({
            "key": "ollama",
            "label": "Ollama (yerel)",
            "models": [{"id": DEFAULT_OLLAMA_MODEL, "label": DEFAULT_OLLAMA_MODEL}],
            "default_model": DEFAULT_OLLAMA_MODEL,
            "off_device": False,
        })
    if "claude" in allow and os.environ.get("STT_NOTE_PROVIDER", "").strip().lower() == "claude":
        out.append({
            "key": "claude",
            "label": "Claude (bulut)",
            "models": [{"id": DEFAULT_CLAUDE_MODEL, "label": DEFAULT_CLAUDE_MODEL}],
            "default_model": DEFAULT_CLAUDE_MODEL,
            "off_device": True,
        })

    _, descriptors = _local_registry()
    for d in descriptors:
        if d.get("key") not in allow:
            continue
        avail = d.get("available")
        try:
            if callable(avail) and not avail():
                continue
        except Exception:  # noqa: BLE001 - a flaky predicate shouldn't hide everything else
            continue
        out.append({
            "key": d["key"],
            "label": d.get("label", d["key"]),
            "models": d.get("models", []),
            "default_model": d.get("default_model"),
            "off_device": bool(d.get("off_device", False)),
        })

    return out
