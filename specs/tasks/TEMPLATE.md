# Task: <feature or refactor name>

*Copy this file to `specs/tasks/<short-name>.md` and fill it in before writing
code. This is the Kiro-style "tasks" step: a numbered, checkable plan where each
task traces back to a requirement. Keep it updated as you work.*

## Goal

<One or two sentences: what this change delivers and why. Link the product/user
need.>

## Requirements touched

- New/changed EARS lines in [`../requirements.md`](../requirements.md):
  - `REQ-###` — <the new requirement text>
- Existing requirements this must NOT break: `REQ-###`, `REQ-###`

## Design notes

- <How it works; which pipeline stage / function in `transcribe.py` changes
  (see [`../structure.md`](../structure.md)). Update
  [`../design.md`](../design.md) if the architecture or data flow changes.>
- New decision? Add an ADR in [`../adr/`](../adr/) and reference it here.

## Constraints to respect (don't violate these)

- [ ] CPU-only — no `mps`/`cuda` (ADR-0001)
- [ ] No casual version-pin bumps (ADR-0002)
- [ ] No downloads/caches outside the project (ADR-0003)
- [ ] Keep the no-flags default path robust (ADR-0004)
- [ ] Keep the diarizer two-attempt fallback (ADR-0005)
- [ ] Keep heavy imports lazy so `--help` works dependency-free
- [ ] Terminal and `out/<stem>.txt` stay identical (route through `emit()`)

## Task checklist

- [ ] 1. <first concrete step>  → satisfies `REQ-###`
- [ ] 2. <next step>            → satisfies `REQ-###`
- [ ] 3. Update affected specs (`requirements.md` / `design.md` / ADR)
- [ ] 4. Run the verification gate and confirm PASS

## Verification

```bash
source env.sh
bash make_sample.sh
python transcribe.py samples/conversation.wav        # add --model small for a faster loop
```

- **Gate:** `out/conversation.txt` has the header and ≥ 2 distinct `Speaker N` turns.
- **This feature specifically:** <the extra check that proves THIS change works,
  e.g. "`out/conversation.vtt` exists and is valid WebVTT">
