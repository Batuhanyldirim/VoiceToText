# Delivery summary — Tier 2 + the "Yeni not" fix (2026-07-08, cont.)

All merged to `main` and pushed to `origin/main` (HEAD `b0a22d6`). `make test` →
**62 passed** (<1.5 s); web build + lint green (only the 2 long-standing
TranscriptViewer warnings). Working tree clean.

## Fix: sidebar "Yeni not" (`54a7582`)
"Yeni not" opened the reuse-only source picker; it now opens the main capture
screen (Dosya yükle / Ses kaydet / Canlı deşifre + "Mevcut deşifreyi kullan"),
clearing any in-progress file. The "Mevcut deşifreyi kullan" link still reaches
the reuse picker.

## Tier 2 — all three items shipped

### 1. Autosave + version history  (`ddcca20`, REQ-147–149, ADR-0020)
- **Autosave:** while editing a draft, edits persist ~1.5 s after you stop typing
  (reuses the overlay PATCH; "Kaydediliyor…/Otomatik kaydedildi" chip) — no lost
  work on navigate/refresh. Manual Kaydet still works. Not for finalized notes.
- **Version history:** every distinct saved body is snapshotted (incl. the AI
  original on first edit, and the finalized body); no-op autosaves don't create
  versions. A "Sürüm geçmişi" dialog lists versions (timestamp + preview) with
  click-to-restore (restore is itself versioned; blocked when final). Deleting a
  note deletes its versions.

### 2. Custom note templates  (`dd1deb3`, REQ-150–152, ADR-0021)
- Save your own reusable note formats instead of re-pasting "free" each time. A
  "Şablonlar" manager (create/edit/delete, name + Markdown body), reachable via
  "Şablonları yönet" in the note generator; custom templates appear in the picker
  labelled "(özel)".
- A custom template is resolved server-side to a saved "free" sample at generation
  time (`custom:<id>` → stored body) — **no change to note_core**.

### 3. Encounter metadata up front  (`b0a22d6`, REQ-153–155, ADR-0022)
- A "Muayene bilgisi" section in the note generator: pick/create a **patient**,
  set a **visit type** (presets: İlk başvuru / Kontrol / Konsültasyon / Acil /
  Telefon), and a **chief complaint** — all optional.
- Notes now **auto-title** from the chief complaint ("Öksürük — SOAP notu"), the
  patient is assigned up front, and **search matches** chief complaint + visit
  type too. Visit-type + chief-complaint chips show on the note.

## Testing
The pytest suite (ADR-0017) grew from 43 → **62 cases** across these features
(version snapshot/restore/finalize/delete semantics, template CRUD + resolution,
metadata persist + search). Hermetic (temp DB, no ML), <1.5 s.

## Known limitation (documented)
Turkish dotted-İ: a search term *starting with* "İ"/"I" isn't matched by SQLite's
ASCII `lower()` (e.g. "ilk" misses "İlk başvuru"); substrings after it still work.
Pre-existing to the LIKE search (ADR-0018); a Turkish-collation fix would be its
own ADR.

## What I couldn't verify without you
The live browser UX (autosave timing feel, the version-history and template
dialogs, the metadata form). All logic is unit- + build-verified. **Restart
`make api`** first (migrations add the note_versions / note_templates tables +
visit_type / chief_complaint columns).

## Roadmap status
**Tier 1 and Tier 2 are complete.** Remaining is **Tier 3** (extracted
problem/medication list, follow-up reminders, quick-phrases/dictation commands) —
see the product-roadmap memory.
