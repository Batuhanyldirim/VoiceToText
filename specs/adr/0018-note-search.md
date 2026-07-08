# ADR-0018 — Note search via SQLite LIKE (not FTS)

**Status:** Accepted · **Relates to:** REQ-141, ADR-0010, ADR-0016, `apps/api/src/stt_api/store.py`, `apps/web/src/components/NotesSidebar.tsx`

## Context

As saved notes accumulate, browsing a flat (or even patient-filtered) list isn't
enough — the doctor needs to *find* a note: by what it's about (body text), whose
it is (patient), or its title. This is the Tier-1 "search & filter" item.

The question is **how much search machinery** to build. SQLite offers FTS5
(tokenized full-text index with ranking). But: this is one local user with a
modest note count, the corpus is short clinical notes, and substring matching over
title + patient + body is exactly the mental model ("find where I mentioned
öksürük"). FTS5 adds an index to maintain, tokenizer/language concerns (Turkish),
and query-syntax surface — disproportionate here.

## Decision

Implement search as a **case-insensitive `LIKE` filter** in the existing store
`list()`, composable with the patient filter.

- `NoteStore.list(patient_id=None, q=None)` — when `q` is given, add
  `WHERE (lower(title) LIKE ? OR lower(patient_name) LIKE ? OR lower(note-body)
  LIKE ?)` with `%q%` (lowercased), where the note-body match uses
  `COALESCE(edited_note, note)` so search hits the **effective** text the user
  sees (ADR-0015). Combined with `patient_id` via `AND`.
- API: `GET /notes?q=…&patient_id=…` — both optional, both applied.
- Web: a search `TextField` in the sidebar ("Notlarda ara…") that, combined with
  the patient dropdown, re-queries as the user types (debounced lightly by React
  state + the existing refresh path).

Out of scope: ranking/relevance, fuzzy/stemmed matching, searching transcript
text (the transcript isn't shown in the list; can be added to the OR later if
wanted), and highlighting matched snippets.

## Consequences

- ✅ Findability with near-zero machinery — a few extra SQL clauses, no index to
  maintain, no new dependency; correct for a local single-user corpus.
- ✅ Searches the **effective** note body (edits included) + title + patient, and
  composes with the patient filter.
- ➖ `LIKE '%q%'` is a full scan — fine at this scale; if the corpus ever grows
  large, revisit with FTS5 (this ADR would be superseded).
- ➖ No ranking or fuzzy matching — plain substring; acceptable for the use case.
- ⚠️ Keep the body match on `COALESCE(edited_note, note)` so search reflects what
  the clinician sees, not a stale AI original.
