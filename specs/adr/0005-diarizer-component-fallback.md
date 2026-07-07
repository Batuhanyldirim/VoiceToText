# ADR-0005 — Diarizer component-pipeline fallback

**Status:** Accepted · **Relates to:** REQ-061, `load_diarizer()`, `design.md`

## Context

pyannote's turnkey diarization is a **gated** Hugging Face model: the user must
accept its terms on the website before a token can download it. During setup, the
provided token had accepted terms for `speaker-diarization-community-1` and the
**component** models (`segmentation-3.0`, `wespeaker-voxceleb-resnet34-LM`) but
**not** for `speaker-diarization-3.1` — which is the model WhisperX's
`DiarizationPipeline` defaults to. Result: the turnkey path returned `None`
(403 GatedRepoError). Additionally, the `community-1` meta-model targets
pyannote **4.x**, while this project pins pyannote **3.x** (ADR-0002), so that
model can't be used directly either.

Rather than block on the user accepting more model terms, we reproduce the
meta-model from parts the token already has access to.

## Decision

`load_diarizer()` tries two attempts and returns the same DataFrame shape from
either:

1. **Meta-model** — `Pipeline.from_pretrained(--diar-model)` (default
   `pyannote/speaker-diarization-3.1`). Used if available.
2. **Component pipeline** — on any failure, assemble
   `SpeakerDiarization(segmentation="pyannote/segmentation-3.0",
   embedding="pyannote/wespeaker-voxceleb-resnet34-LM",
   clustering="AgglomerativeClustering")` and `instantiate()` it with the
   standard `speaker-diarization-3.1` hyper-parameters (clustering threshold
   ≈ 0.7046, `min_cluster_size` 12, centroid method). This *is* what the gated
   meta-model is internally.

## Consequences

- ✅ Diarization works with only the (already-accepted) component models — zero
  extra clicks from the user, and compatible with the pinned pyannote 3.x.
- ✅ If the user later accepts the meta-model's terms, attempt 1 transparently
  takes over.
- ➖ The hyper-parameters are hard-coded to the 3.1 recipe; if pyannote changes
  its recommended values, they must be updated here.
- ⚠️ **Do not delete attempt 2.** Removing it makes diarization fail on the
  common "terms not accepted / wrong major version" case. The two-attempt shape
  is intentional, not redundant.
