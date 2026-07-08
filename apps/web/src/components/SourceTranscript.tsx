import { useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import type { Turn } from "../types";
import { API } from "../config/api";
import { formatTimestamp, speakerColor } from "../utils/format";

// "Kaynak deşifre" panel (ADR-0019): the note's source transcript turns, and —
// when the recording is available — an embedded player where clicking a turn
// seeks/plays that moment. Lets a clinician verify an ambiguous passage against
// the original audio without leaving the note. Degrades to transcript-only when
// there's no audio (reused/old notes).

interface SourceTranscriptProps {
  noteId: string;
  turns: Turn[];
  hasAudio: boolean;
}

export default function SourceTranscript({ noteId, turns, hasAudio }: SourceTranscriptProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  if (!turns || turns.length === 0) return null;

  const audioUrl = hasAudio ? `${API}/notes/${encodeURIComponent(noteId)}/audio` : null;

  const seekTo = (turn: Turn, idx: number) => {
    const el = audioRef.current;
    if (!el || typeof turn.start !== "number") return;
    el.currentTime = turn.start;
    setActiveIdx(idx);
    void el.play().catch(() => {
      /* autoplay may be blocked; the user can press play */
    });
  };

  return (
    <Accordion
      disableGutters
      sx={{
        "&:before": { display: "none" },
        border: "1px solid rgba(26,26,46,0.10)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <GraphicEqRoundedIcon fontSize="small" color="primary" />
          <Typography sx={{ fontWeight: 700 }}>Kaynak deşifre</Typography>
          <Chip label={`${turns.length} konuşma`} size="small" variant="outlined" />
          {hasAudio ? (
            <Chip
              icon={<PlayArrowRoundedIcon />}
              label="Sesli"
              size="small"
              color="primary"
              variant="outlined"
            />
          ) : null}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        {audioUrl && (
          <Box sx={{ mb: 1.5 }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              preload="none"
              style={{ width: "100%" }}
              onTimeUpdate={() => {
                // Keep the highlighted turn in sync with playback position.
                const t = audioRef.current?.currentTime ?? 0;
                const idx = turns.findIndex(
                  (turn) =>
                    typeof turn.start === "number" &&
                    typeof turn.end === "number" &&
                    t >= turn.start &&
                    t < turn.end,
                );
                if (idx !== -1 && idx !== activeIdx) setActiveIdx(idx);
              }}
            />
            <Typography variant="caption" color="text.secondary">
              İpucu: sesi o ana götürmek için bir konuşmaya tıklayın.
            </Typography>
          </Box>
        )}

        <Stack spacing={0.75}>
          {turns.map((turn, i) => {
            const color = speakerColor(turn.speaker || "");
            const clickable = hasAudio && typeof turn.start === "number";
            const active = i === activeIdx;
            return (
              <Box
                key={`${turn.start ?? i}-${i}`}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => seekTo(turn, i) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") seekTo(turn, i);
                      }
                    : undefined
                }
                sx={{
                  display: "flex",
                  gap: 1,
                  p: 1,
                  borderRadius: 1.5,
                  cursor: clickable ? "pointer" : "default",
                  bgcolor: active ? "primary.light" : "transparent",
                  transition: "background-color .15s",
                  "&:hover": clickable ? { bgcolor: active ? "primary.light" : "action.hover" } : {},
                  outline: "none",
                  "&:focus-visible": clickable
                    ? { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}` }
                    : {},
                }}
              >
                <Box sx={{ flexShrink: 0, minWidth: 92 }}>
                  <Chip
                    label={turn.speaker}
                    size="small"
                    sx={{ bgcolor: color.bg, color: color.main, fontWeight: 600 }}
                  />
                  {typeof turn.start === "number" && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: "block", mt: 0.25, fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatTimestamp(turn.start)}
                    </Typography>
                  )}
                </Box>
                <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
                  {turn.text}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
