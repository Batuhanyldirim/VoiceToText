# Task: Export — PDF print + EHR plain-text copy (Tier 1)

**Status:** DONE on `feat/tier1-export`. REQ-142.

## What shipped
- **utils/noteExport.ts** — `markdownToPlainText()` (strips heading/bold/italic/
  code/quote markers, "- "→"• ", collapses blank lines) and `printNoteAsPdf()`
  (opens a print window with a clean stylesheet + title/patient/status header,
  triggers the browser print dialog → "Save as PDF"; content inserted via
  textContent, never innerHTML — XSS-safe for PHI). No new dependency.
- **NoteViewer** — a consolidated "Dışa aktar" menu: PDF olarak indir · EHR için
  kopyala (düz metin) · Markdown kopyala · .md indir. Replaces the two flat
  copy/download buttons to keep the action bar uncluttered.

## Verified
- markdownToPlainText unit-checked in node (headings/bold/italic/code/quote/
  bullets/rules) — before and after the backtick-regex rewrite.
- Web build + lint green.

## Note
Chose browser print-to-PDF over a PDF library (no dep, no server round-trip),
consistent with the repo's minimal-deps ethos. A lexer gotcha: a lone backtick in
a source comment opens a phantom template literal — keep backticks out of
comments in .ts files here.
