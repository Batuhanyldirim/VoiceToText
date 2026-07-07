import { memo } from "react";
import { Box, Chip, Typography } from "@mui/material";
import type { Turn } from "../types";
import { formatTimestamp, speakerColor } from "../utils/format";

interface TurnBubbleProps {
  turn: Turn;
  query: string;
  clickable: boolean;
  onSeek: (start: number) => void;
}

/** Highlight occurrences of `query` inside `text`. */
function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const target = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let idx = 0;
  let from = 0;
  let key = 0;
  while ((idx = lower.indexOf(target, from)) !== -1) {
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <Box
        component="mark"
        key={key++}
        sx={{
          bgcolor: "warning.light",
          color: "inherit",
          px: 0.25,
          borderRadius: 0.5,
        }}
      >
        {text.slice(idx, idx + target.length)}
      </Box>,
    );
    from = idx + target.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function TurnBubbleImpl({ turn, query, clickable, onSeek }: TurnBubbleProps) {
  const color = speakerColor(turn.speaker);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 0.5,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 0.5 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            bgcolor: color.main,
            flexShrink: 0,
          }}
        />
        <Typography variant="subtitle2" sx={{ color: color.main, fontWeight: 700 }}>
          {turn.speaker}
        </Typography>
        <Chip
          label={formatTimestamp(turn.start)}
          size="small"
          variant="outlined"
          sx={{
            height: 20,
            fontSize: "0.7rem",
            fontVariantNumeric: "tabular-nums",
            borderColor: "rgba(0,0,0,0.12)",
          }}
        />
      </Box>
      <Box
        onClick={clickable ? () => onSeek(turn.start) : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") onSeek(turn.start);
              }
            : undefined
        }
        sx={{
          maxWidth: "min(680px, 100%)",
          bgcolor: color.bg,
          borderLeft: `3px solid ${color.main}`,
          borderRadius: "4px 14px 14px 14px",
          px: 2,
          py: 1.25,
          cursor: clickable ? "pointer" : "default",
          transition: "filter 0.12s ease",
          "&:hover": clickable ? { filter: "brightness(0.97)" } : undefined,
        }}
      >
        <Typography variant="body1" sx={{ color: "text.primary", lineHeight: 1.55 }}>
          {highlight(turn.text, query)}
        </Typography>
      </Box>
    </Box>
  );
}

export default memo(TurnBubbleImpl);
