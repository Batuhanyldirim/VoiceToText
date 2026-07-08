import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import type { SavedNoteSummary } from "../types";
import { deleteNote, listNotes } from "../config/api";

export const SIDEBAR_WIDTH = 288;

interface NotesSidebarProps {
  /** The note currently open in the main pane (highlighted in the list). */
  activeNoteId: string | null;
  /** Open a saved note (App renders it read-only). */
  onOpenNote: (id: string) => void;
  /** Start a brand-new note (App routes to the source picker). */
  onNewNote: () => void;
  /** Collapse the sidebar. */
  onCollapse: () => void;
  /** Bump this to force a reload (e.g. after a new note is saved). */
  refreshToken: number;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact duration: "42 sn" / "2 dk 18 sn". */
function formatSeconds(s: number): string {
  const total = Math.round(s);
  if (total < 60) return `${total} sn`;
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return rem ? `${m} dk ${rem} sn` : `${m} dk`;
}

export default function NotesSidebar({
  activeNoteId,
  onOpenNote,
  onNewNote,
  onCollapse,
  refreshToken,
}: NotesSidebarProps) {
  const [notes, setNotes] = useState<SavedNoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const res = await listNotes(signal);
      setNotes(res);
    } catch (e) {
      if (!signal?.aborted) {
        setLoadError(
          e instanceof Error ? e.message : "Notlar yüklenemedi.",
        );
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh, refreshToken]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation(); // don't open the note when clicking delete
      if (!window.confirm("Bu notu silmek istediğinize emin misiniz?")) return;
      setDeletingId(id);
      try {
        await deleteNote(id);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Not silinemedi.");
      } finally {
        setDeletingId(null);
      }
    },
    [refresh],
  );

  return (
    <Box
      sx={{
        width: SIDEBAR_WIDTH,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      {/* Header: brand + collapse */}
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
        }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 800, letterSpacing: "-0.01em" }}>
          Notlarım
        </Typography>
        <Tooltip title="Kenar çubuğunu gizle">
          <IconButton size="small" onClick={onCollapse} aria-label="Kenar çubuğunu gizle">
            <ChevronLeftRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* New note */}
      <Box sx={{ px: 2, pb: 1.5 }}>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<AddRoundedIcon />}
          onClick={onNewNote}
        >
          Yeni not
        </Button>
      </Box>

      {/* List */}
      <Box sx={{ flexGrow: 1, overflowY: "auto", px: 1, pb: 2 }}>
        {loadError && (
          <Alert severity="error" sx={{ mx: 1, mb: 1 }}>
            {loadError}
          </Alert>
        )}

        {loading ? (
          <Stack sx={{ alignItems: "center", py: 4 }}>
            <CircularProgress size={20} />
          </Stack>
        ) : notes.length === 0 && !loadError ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 4, textAlign: "center" }}
          >
            Henüz kayıtlı not yok. Başlamak için “Yeni not”.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {notes.map((n) => {
              const active = n.id === activeNoteId;
              return (
                <Box
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenNote(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpenNote(n.id);
                  }}
                  sx={{
                    position: "relative",
                    cursor: "pointer",
                    borderRadius: 2,
                    px: 1.5,
                    py: 1,
                    bgcolor: active ? "primary.light" : "transparent",
                    outline: "none",
                    "&:hover": {
                      bgcolor: active ? "primary.light" : "action.hover",
                      "& .note-del": { opacity: 1 },
                    },
                    "&:focus-visible": { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}` },
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", pr: 3 }}>
                    <DescriptionRoundedIcon
                      fontSize="small"
                      sx={{ color: active ? "primary.main" : "text.disabled", flexShrink: 0 }}
                    />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{ fontWeight: active ? 700 : 500 }}
                        title={n.title}
                      >
                        {n.title || "(başlıksız)"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {formatDate(n.created_at)}
                        {n.note_seconds != null &&
                          ` · Not: ${formatSeconds(n.note_seconds)}`}
                      </Typography>
                    </Box>
                  </Stack>

                  <Box
                    className="note-del"
                    sx={{
                      position: "absolute",
                      right: 4,
                      top: "50%",
                      transform: "translateY(-50%)",
                      opacity: { xs: 1, md: 0 },
                      transition: "opacity .15s",
                    }}
                  >
                    <Tooltip title="Sil">
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          onClick={(e) => void handleDelete(e, n.id)}
                          disabled={deletingId === n.id}
                          aria-label="Notu sil"
                        >
                          {deletingId === n.id ? (
                            <CircularProgress size={16} />
                          ) : (
                            <DeleteOutlineRoundedIcon fontSize="small" />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                </Box>
              );
            })}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
