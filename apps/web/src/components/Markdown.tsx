import { Fragment, type ReactNode } from "react";
import { Box, Divider, Link, Typography } from "@mui/material";

// A small, self-contained Markdown renderer for the clinical notes (which are
// generated as Markdown: #/##/### headings, **bold**, *italic*, `code`, "- "/
// "* " bullets, "N." numbered lists, "> " quotes, "---" rules, and paragraphs).
// We render to MUI components so the note reads like a formatted document
// instead of raw source. Deliberately NOT a full CommonMark parser and NO new
// dependency — the input surface is small and known (see NoteViewer). Text is
// rendered as React children (never dangerouslySetInnerHTML), so it's XSS-safe.

interface MarkdownProps {
  children: string;
  /** Drop a leading heading line (the review card supplies its own title). */
  stripFirstHeading?: boolean;
}

// --- inline: **bold**, *italic*, `code`, [text](url) ----------------------
const INLINE_RE =
  /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  let i = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(
        <Box component="strong" key={key} sx={{ fontWeight: 700 }}>
          {tok.slice(2, -2)}
        </Box>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <Box
          component="code"
          key={key}
          sx={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: "0.85em",
            bgcolor: "rgba(26,26,46,0.06)",
            px: 0.5,
            py: 0.1,
            borderRadius: 0.5,
          }}
        >
          {tok.slice(1, -1)}
        </Box>,
      );
    } else if (tok.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (linkMatch) {
        out.push(
          <Link key={key} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </Link>,
        );
      } else {
        out.push(tok);
      }
    } else {
      // *italic*
      out.push(
        <Box component="em" key={key}>
          {tok.slice(1, -1)}
        </Box>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- block model -----------------------------------------------------------
type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "rule" }
  | { type: "p"; lines: string[] };

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // Unordered list (group consecutive "- " / "* " / "• " items)
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list (group consecutive "N. " items)
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const qlines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        qlines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: qlines });
      continue;
    }

    // Paragraph: gather consecutive plain lines until a blank or a block starter.
    const plines: string[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        t === "" ||
        /^(#{1,6})\s+/.test(t) ||
        /^[-*•]\s+/.test(t) ||
        /^\d+[.)]\s+/.test(t) ||
        /^>\s?/.test(t) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(t)
      ) {
        break;
      }
      plines.push(t);
      i++;
    }
    blocks.push({ type: "p", lines: plines });
  }
  return blocks;
}

const HEADING_VARIANTS: Record<number, "h5" | "h6" | "subtitle1" | "subtitle2"> = {
  1: "h5",
  2: "h6",
  3: "subtitle1",
  4: "subtitle2",
  5: "subtitle2",
  6: "subtitle2",
};

export default function Markdown({ children, stripFirstHeading }: MarkdownProps) {
  let blocks = parseBlocks(children ?? "");
  if (stripFirstHeading && blocks[0]?.type === "heading") {
    blocks = blocks.slice(1);
  }

  return (
    <Box
      sx={{
        // Comfortable reading measure + rhythm for a clinical document.
        color: "text.primary",
        "& > :first-of-type": { mt: 0 },
      }}
    >
      {blocks.map((b, idx) => {
        const key = `b${idx}`;
        switch (b.type) {
          case "heading":
            return (
              <Typography
                key={key}
                variant={HEADING_VARIANTS[b.level]}
                sx={{
                  fontWeight: b.level <= 2 ? 800 : 700,
                  mt: b.level <= 1 ? 0 : b.level === 2 ? 3 : 2,
                  mb: 1,
                  ...(b.level === 2 && {
                    pb: 0.5,
                    borderBottom: "1px solid rgba(26,26,46,0.10)",
                  }),
                  letterSpacing: b.level <= 2 ? "-0.01em" : undefined,
                }}
              >
                {renderInline(b.text, key)}
              </Typography>
            );
          case "ul":
          case "ol":
            return (
              <Box
                key={key}
                component={b.type === "ul" ? "ul" : "ol"}
                sx={{
                  my: 1,
                  pl: 3,
                  "& li": { mb: 0.75, lineHeight: 1.65 },
                  "& li::marker": { color: "primary.main" },
                }}
              >
                {b.items.map((it, j) => (
                  <Typography component="li" variant="body2" key={`${key}-${j}`}>
                    {renderInline(it, `${key}-${j}`)}
                  </Typography>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box
                key={key}
                sx={{
                  my: 1.5,
                  pl: 2,
                  borderLeft: "3px solid",
                  borderColor: "primary.light",
                  color: "text.secondary",
                }}
              >
                {b.lines.map((ln, j) => (
                  <Typography variant="body2" key={`${key}-${j}`} sx={{ lineHeight: 1.65 }}>
                    {renderInline(ln, `${key}-${j}`)}
                  </Typography>
                ))}
              </Box>
            );
          case "rule":
            return <Divider key={key} sx={{ my: 2 }} />;
          case "p":
            return (
              <Typography
                key={key}
                variant="body2"
                sx={{ my: 1, lineHeight: 1.7 }}
              >
                {b.lines.map((ln, j) => (
                  <Fragment key={`${key}-${j}`}>
                    {renderInline(ln, `${key}-${j}`)}
                    {j < b.lines.length - 1 && <br />}
                  </Fragment>
                ))}
              </Typography>
            );
        }
      })}
    </Box>
  );
}
