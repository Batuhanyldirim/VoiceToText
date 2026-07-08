// Note export helpers (REQ-142): markdown → clean plain text for pasting into an
// EHR, and print-to-PDF via a print stylesheet (no dependency, no server call).

/** Convert the note's markdown to clean plain text suitable for pasting into a
 *  hospital record system: strip heading/bold/italic/code/quote markers, turn
 *  "- " into "• ", keep line structure and blank-line spacing. Deliberately
 *  simple — matches the small markdown subset the notes use (see Markdown.tsx). */
export function markdownToPlainText(md: string): string {
  const lines = (md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw;
    // Headings: drop leading #'s (keep the text).
    line = line.replace(/^\s{0,3}#{1,6}\s+/, "");
    // Blockquote marker.
    line = line.replace(/^\s{0,3}>\s?/, "");
    // Horizontal rule → blank line.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("");
      continue;
    }
    // Bullet markers "- " / "* " / "• " → "• ".
    line = line.replace(/^(\s*)[-*•]\s+/, "$1• ");
    // Numbered "1. " kept as-is (already plain).
    // Inline: strip bold, italic, inline-code, and link syntax (keep link text).
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    line = line.replace(/__([^_]+)__/g, "$1");
    line = line.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2");
    // Inline code: strip the backtick fences (built via RegExp to avoid a
    // backtick-delimited regex literal, which the bundler's lexer mis-reads).
    const BACKTICK = String.fromCharCode(96);
    line = line.replace(new RegExp(BACKTICK + "([^" + BACKTICK + "]+)" + BACKTICK, "g"), "$1");
    line = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    out.push(line);
  }
  // Collapse 3+ blank lines to a single blank line; trim outer whitespace.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface PrintMeta {
  title: string;
  patient?: string | null;
  status?: string | null;   // "Taslak" | "Tamamlandı"
  finalizedAt?: string | null;
}

/** Open a print window with a clean stylesheet and trigger the browser's print
 *  dialog (the user picks "Save as PDF"). Content is passed as plain text and
 *  inserted via textContent, never innerHTML — XSS-safe for PHI. */
export function printNoteAsPdf(noteMarkdown: string, meta: PrintMeta): void {
  const plain = markdownToPlainText(noteMarkdown);
  const w = window.open("", "_blank", "noopener,noreferrer,width=820,height=1000");
  if (!w) return; // popup blocked — caller can surface a hint

  const doc = w.document;
  doc.title = meta.title || "Klinik not";

  const style = doc.createElement("style");
  style.textContent = `
    @page { margin: 20mm; }
    * { box-sizing: border-box; }
    body {
      font: 12pt/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111; margin: 0; padding: 24px;
    }
    h1 { font-size: 18pt; margin: 0 0 4px; }
    .meta { color: #555; font-size: 10pt; margin: 0 0 16px; }
    .meta .sep { margin: 0 6px; }
    hr { border: none; border-top: 1px solid #ccc; margin: 12px 0; }
    pre {
      white-space: pre-wrap; word-break: break-word;
      font: inherit; margin: 0;
    }
    .draft-note { color: #8a6d3b; font-size: 9.5pt; margin-top: 20px;
      border-top: 1px dashed #ccc; padding-top: 8px; }
  `;
  doc.head.appendChild(style);

  const h1 = doc.createElement("h1");
  h1.textContent = meta.title || "Klinik not";
  doc.body.appendChild(h1);

  const metaParts: string[] = [];
  if (meta.patient) metaParts.push(`Hasta: ${meta.patient}`);
  if (meta.status) metaParts.push(meta.status);
  if (meta.finalizedAt) metaParts.push(meta.finalizedAt);
  if (metaParts.length) {
    const m = doc.createElement("p");
    m.className = "meta";
    m.textContent = metaParts.join("  ·  ");
    doc.body.appendChild(m);
  }

  const hr = doc.createElement("hr");
  doc.body.appendChild(hr);

  const pre = doc.createElement("pre");
  pre.textContent = plain;
  doc.body.appendChild(pre);

  // If it's a draft, print a small footer clarifying it's not a final record.
  if (meta.status && meta.status !== "Tamamlandı") {
    const note = doc.createElement("div");
    note.className = "draft-note";
    note.textContent =
      "Taslak — hekim incelemesi için, nihai kayıt değildir.";
    doc.body.appendChild(note);
  }

  // Give the new document a tick to lay out, then print.
  w.focus();
  setTimeout(() => {
    w.print();
    // Leave the window open so the user can retry the dialog; most browsers
    // close it after printing anyway.
  }, 150);
}
