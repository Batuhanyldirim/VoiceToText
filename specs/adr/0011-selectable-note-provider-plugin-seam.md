# ADR-0011 — Selectable note provider via a generic plugin seam (local-only integrations kept out of git)

**Status:** Accepted · **Relates to:** REQ-111–REQ-115, ADR-0009, ADR-0008, ADR-0003, ADR-0012, `packages/note-core/src/note_core/providers.py`, `apps/api`, `apps/web`, `env.sh`

## Context

ADR-0009 shipped clinical-note generation with **two hardwired providers** —
local Ollama (default) and a gated first-party cloud path (Claude via the
Anthropic SDK). Two pressures pushed past that:

1. **This machine can run a stronger model, but not via the SDK.** The dev box
   runs Claude Code on Amazon Bedrock and has **no `ANTHROPIC_API_KEY`**, so the
   first-party `ClaudeProvider` (which authenticates the SDK with a key) can't
   authenticate. The practical way to reach Opus here is to **shell out to the
   already-authenticated `claude` CLI**. That integration is entirely
   machine-specific — it must not be baked into the committed code, and the
   committed repo must keep offering only Ollama.
2. **The UI needed a real picker.** Once more than one provider can exist, the web
   app has to discover the enabled set, let the user choose provider + model, and
   drive the PHI warning from whether the choice is off-device.

Alongside, the note *output* was reshaped and *timing/session* features landed;
those share this ADR because they were built in the same slice.

## Decision

Turn `note_core.providers` into a **generic plugin seam** and gate what it offers
by an **operator allowlist** — the committed default exposes only the local model.

- **Descriptor API.** `list_providers()` returns `{key, label, models,
  default_model, off_device}` for every offerable provider; `get_provider(name)`
  resolves a key to a live provider. The web `NoteGenerator` calls
  `GET /notes/providers` and shows a **"Sağlayıcı" + "Model"** selector, **hidden
  when only one provider is enabled** (so the default UI is unchanged); the chosen
  descriptor's **`off_device`** flag drives the PHI banner. `POST /notes`
  validates the requested provider against `list_providers()` and fills an omitted
  model from the descriptor's `default_model`.
- **Operator allowlist.** `_provider_allowlist()` reads **`STT_NOTE_PROVIDERS`**
  (comma list, **default `ollama`**). Anything off-device or machine-specific must
  be turned on deliberately — typically in the **git-ignored `env.local.sh`** that
  `env.sh` sources last.
- **Optional git-ignored plugin module.** `_local_registry()` best-effort-imports
  a sibling **`note_core._local_providers`** module and merges its
  `{factories, descriptors}` into `get_provider()` / `list_providers()`
  (consulted **last**). Each descriptor is filtered by the allowlist **and** its
  own **`available()`** predicate, so a provider that can't run on this machine
  (e.g. no `claude` on `PATH`) never appears. If the module is absent or broken,
  the app falls back to the built-ins **without error**. The machine-local
  `ClaudeCliProvider` (Opus 4.8 via the authenticated `claude` CLI) lives only in
  this uncommitted module — **no Opus/cloud-CLI wording exists in committed code.**
- **Note-output reshape (REQ-114–115).** The chosen template **is** the whole note
  (+ exactly one appended `Klinik İnceleme Gerekli` section); no A–E scaffold, no
  banner/preamble, pedigree only for a rich family history. Prompt-level, so it
  applies to **every** provider.
Timing metrics, the in-progress-sessions sidebar, refresh-safe timers, and retry
(REQ-116–119) are a separate decision — see **ADR-0012**.

## Consequences

- ✅ Stronger local model available on this machine without committing any
  machine-specific code; the public repo still offers only Ollama.
- ✅ A generic seam: any future provider is a descriptor + factory, not a new
  branch in the app.
- ✅ Privacy defaults hold — off-device providers are opt-in via the allowlist,
  and the `off_device` flag surfaces the warning in the UI.
- ➖ The picker/allowlist adds indirection versus the old two-branch resolver.
- ⚠️ **Do not** hardwire a cloud/off-device provider as the default, or commit the
  `_local_providers` module / `env.local.sh` — machine-specific integrations stay
  out of version control (ADR-0003). **Do not** assume in-flight jobs are durable;
  only *completed* notes persist (ADR-0010).
