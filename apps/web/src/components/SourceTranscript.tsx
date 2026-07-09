import { useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import type { Note, Turn } from "../types";
import { API, correctTurn } from "../config/api";
import { formatTimestamp, speakerColor } from "../utils/format";

// "Kaynak deşifre" panel (ADR-0019 + ADR-0029): the note's source transcript turns,
// and — when the recording is available — an embedded player where clicking a turn
// seeks/plays that moment. A clinician can verify an ambiguous passage against the
// original audio AND correct the turn text INLINE right here (reusing the
// PATCH /notes/{id}/turns path from the review page) — no need to leave the note.
// Degrades to transcript-only when there's no audio (reused/old notes).

interface SourceTranscriptProps {
  noteId: string;
  turns: Turn[];
  hasAudio: boolean;
  /** Called after a turn is corrected so the parent can sync its own turns state. */
  onTurnsChange?: (turns: Turn[]) => void;
}

export default function SourceTranscript({ noteId, turns, hasAudio, onTurnsChange }: SourceTranscriptProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const startEdit = (turn: Turn, idx: number) => {
    setEditingIdx(idx);
    setDraft(turn.text);
    setErr(null);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setErr(null);
  };

  const saveEdit = async (idx: number) => {
    if (draft.trim() === turns[idx].text.trim()) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const updated: Note = await correctTurn(noteId, idx, draft.trim());
      // Sync the parent (NoteViewer) with the server's authoritative turns.
      if (updated.turns) onTurnsChange?.(updated.turns);
      setEditingIdx(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setSaving(false);
    }
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
              İpucu: sesi o ana götürmek için bir konuşmaya tıklayın; metni düzeltmek için ✎ simgesine dokunun.
            </Typography>
          </Box>
        )}

        <Stack spacing={0.75}>
          {turns.map((turn, i) => {
            const color = speakerColor(turn.speaker || "");
            const clickable = hasAudio && typeof turn.start === "number";
            const active = i === activeIdx;
            const isEditing = i === editingIdx;
            return (
              <Box
                key={`${turn.start ?? i}-${i}`}
                sx={{
                  display: "flex",
                  gap: 1,
                  p: 1,
                  borderRadius: 1.5,
                  bgcolor: active
                    ? "primary.light"
                    : turn.corrected
                      ? "rgba(76,175,80,0.08)"
                      : "transparent",
                  transition: "background-color .15s",
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
                  <Stack direction="row" spacing={0.25} sx={{ mt: 0.5 }}>
                    {clickable && !isEditing && (
                      <Tooltip title="Sesde bu ana git">
                        <IconButton
                          size="small"
                          onClick={() => seekTo(turn, i)}
                          color={active ? "primary" : "default"}
                        >
                          <PlayArrowRoundedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {!isEditing && (
                      <Tooltip title="Metni düzelt">
                        <IconButton size="small" onClick={() => startEdit(turn, i)}>
                          <EditRoundedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    {turn.corrected && !isEditing && (
                      <Tooltip title="Bu konuşma düzeltildi">
                        <CheckCircleRoundedIcon color="success" fontSize="small" sx={{ mt: 0.5 }} />
                      </Tooltip>
                    )}
                  </Stack>
                </Box>

                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  {isEditing ? (
                    <Stack spacing={1}>
                      <TextField
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        multiline
                        fullWidth
                        size="small"
                        autoFocus
                        disabled={saving}
                      />
                      {err && <Alert severity="error">{err}</Alert>}
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => saveEdit(i)}
                          disabled={saving}
                        >
                          {saving ? "Kaydediliyor…" : "Kaydet"}
                        </Button>
                        <Button size="small" onClick={cancelEdit} disabled={saving}>
                          Vazgeç
                        </Button>
                      </Stack>
                    </Stack>
                  ) : (
                    <Box
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
                        cursor: clickable ? "pointer" : "default",
                        outline: "none",
                        "&:focus-visible": clickable
                          ? { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}`, borderRadius: 1 }
                          : {},
                      }}
                    >
                      <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
                        {turn.text}
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
            );
          })}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
