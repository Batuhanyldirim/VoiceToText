import { useMemo } from "react";
import { Box, Typography } from "@mui/material";

// A compact line-level diff of two note bodies (current → proposed), rendered like
// a code review: removed lines in red, added in green, unchanged in muted grey.
// Used by the re-evaluation accept/reject flow (ADR-0029). LCS-based so unchanged
// blocks stay aligned; monospace-ish so lines line up.

type Row = { kind: "same" | "add" | "del"; text: string };

// Longest-common-subsequence line diff → an ordered list of rows.
function diffLines(a: string[], b: string[]): Row[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: "del", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return rows;
}

export default function NoteDiff({ current, proposed }: { current: string; proposed: string }) {
  const rows = useMemo(
    () => diffLines(current.replace(/\r/g, "").split("\n"), proposed.replace(/\r/g, "").split("\n")),
    [current, proposed],
  );
  const changed = rows.some((r) => r.kind !== "same");
  if (!changed) {
    return (
      <Typography variant="body2" color="text.secondary">
        Yeniden değerlendirme mevcut notla aynı sonucu verdi — değişiklik yok.
      </Typography>
    );
  }
  return (
    <Box
      sx={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.6,
        borderRadius: 1.5,
        border: "1px solid",
        borderColor: "divider",
        overflow: "hidden",
      }}
    >
      {rows.map((r, k) => (
        <Box
          key={k}
          sx={{
            display: "flex",
            px: 1,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            bgcolor:
              r.kind === "add"
                ? "rgba(76,175,80,0.14)"
                : r.kind === "del"
                  ? "rgba(244,67,54,0.12)"
                  : "transparent",
            color: r.kind === "same" ? "text.secondary" : "text.primary",
          }}
        >
          <Box component="span" sx={{ width: 16, flexShrink: 0, color: "text.disabled", userSelect: "none" }}>
            {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
          </Box>
          <Box component="span" sx={{ flexGrow: 1 }}>
            {r.text || " "}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
