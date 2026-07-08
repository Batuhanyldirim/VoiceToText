import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import PersonRoundedIcon from "@mui/icons-material/PersonRounded";
import type { ActiveJob, ActiveNote, Patient, SavedNoteSummary } from "../types";
import {
  deleteNote,
  listActiveJobs,
  listActiveNotes,
  listNotes,
  listPatients,
  retryJob,
  retryNote,
} from "../config/api";
import { formatSeconds } from "../utils/format";

export const SIDEBAR_WIDTH = 288;

// How often to re-poll active items so they progress / drop off when done.
const POLL_MS = 3000;

interface NotesSidebarProps {
  /** The item currently open in the main pane (highlighted). May be a saved
   *  note id, an active note id, or an active job id. */
  activeId: string | null;
  /** Open a saved note (read-only). */
  onOpenNote: (id: string) => void;
  /** Return to an in-progress/failed transcription's progress screen. */
  onOpenJob: (jobId: string) => void;
  /** Return to an in-progress/failed note's live view. */
  onOpenActiveNote: (noteId: string) => void;
  /** Start a brand-new note (source picker). */
  onNewNote: () => void;
  /** Collapse the sidebar. */
  onCollapse: () => void;
  /** Bump to force an immediate reload (e.g. right after a job/note starts). */
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

// Turkish labels for transcription stages (mirrors ProgressScreen).
const STAGE_TR: Record<string, string> = {
  enhance: "İyileştirme",
  transcribe: "Deşifre",
  align: "Hizalama",
  diarize: "Konuşmacı ayrımı",
  fuse: "Birleştirme",
  queued: "Sırada",
};

export default function NotesSidebar({
  activeId,
  onOpenNote,
  onOpenJob,
  onOpenActiveNote,
  onNewNote,
  onCollapse,
  refreshToken,
}: NotesSidebarProps) {
  const [saved, setSaved] = useState<SavedNoteSummary[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [activeNotes, setActiveNotes] = useState<ActiveNote[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  // "" = all patients; otherwise a patient id to filter the saved-note list by.
  const [patientFilter, setPatientFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal, filter?: string) => {
      try {
        const [s, j, n, ps] = await Promise.all([
          listNotes(signal, filter || undefined),
          listActiveJobs(signal),
          listActiveNotes(signal),
          listPatients(signal),
        ]);
        if (signal?.aborted) return;
        setSaved(s);
        setActiveJobs(j);
        setActiveNotes(n);
        setPatients(ps);
        setLoadError(null);
      } catch (e) {
        if (!signal?.aborted) {
          setLoadError(e instanceof Error ? e.message : "Liste yüklenemedi.");
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [],
  );

  // Initial load + reload on refreshToken or patient-filter change.
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal, patientFilter);
    return () => abort.abort();
  }, [refresh, refreshToken, patientFilter]);

  // Poll while there is active work so rows progress and drop off when done.
  const hasActive = activeJobs.length > 0 || activeNotes.length > 0;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => void refresh(undefined, patientFilter), POLL_MS);
    return () => clearInterval(id);
  }, [hasActive, refresh, patientFilter]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
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

  const handleRetry = useCallback(
    async (
      e: React.MouseEvent,
      kind: "transcription" | "note",
      id: string,
    ) => {
      e.stopPropagation();
      setRetryingId(id);
      try {
        if (kind === "transcription") {
          await retryJob(id);
          onOpenJob(id);
        } else {
          await retryNote(id);
          onOpenActiveNote(id);
        }
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Tekrar denenemedi.");
      } finally {
        setRetryingId(null);
      }
    },
    [refresh, onOpenJob, onOpenActiveNote],
  );

  const nothing =
    !loading && !loadError && saved.length === 0 && !hasActive;

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
      {/* Header: title + collapse */}
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", px: 2, py: 1.5 }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 800, letterSpacing: "-0.01em" }}>
          {hasActive ? "Oturumlar" : "Notlarım"}
        </Typography>
        <Tooltip title="Kenar çubuğunu gizle">
          <IconButton size="small" onClick={onCollapse} aria-label="Kenar çubuğunu gizle">
            <ChevronLeftRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* New note */}
      <Box sx={{ px: 2, pb: 1.5 }}>
        <Button fullWidth variant="outlined" startIcon={<AddRoundedIcon />} onClick={onNewNote}>
          Yeni not
        </Button>
      </Box>

      {/* Patient filter (ADR-0016) — only shown once patients exist. */}
      {patients.length > 0 && (
        <Box sx={{ px: 2, pb: 1.5 }}>
          <FormControl fullWidth size="small">
            <Select
              value={patientFilter}
              onChange={(e) => setPatientFilter(e.target.value)}
              displayEmpty
              startAdornment={
                <PersonRoundedIcon fontSize="small" sx={{ color: "text.disabled", mr: 1 }} />
              }
            >
              <MenuItem value="">Tüm hastalar</MenuItem>
              {patients.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                  {typeof p.note_count === "number" ? ` (${p.note_count})` : ""}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}

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
        ) : nothing ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 4, textAlign: "center" }}
          >
            Henüz bir şey yok. Başlamak için “Yeni not”.
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {/* Active transcriptions */}
            {activeJobs.map((j) => (
              <ActiveRow
                key={`job-${j.id}`}
                selected={j.id === activeId}
                icon={<GraphicEqRoundedIcon fontSize="small" />}
                title={j.name}
                failed={j.status === "error"}
                statusLabel={
                  j.status === "error"
                    ? "Başarısız"
                    : `Deşifre · ${STAGE_TR[j.stage ?? "queued"] ?? j.stage ?? ""}`
                }
                retrying={retryingId === j.id}
                onOpen={() => onOpenJob(j.id)}
                onRetry={(e) => void handleRetry(e, "transcription", j.id)}
              />
            ))}

            {/* Active note generations */}
            {activeNotes.map((n) => (
              <ActiveRow
                key={`note-${n.id}`}
                selected={n.id === activeId}
                icon={<DescriptionRoundedIcon fontSize="small" />}
                title={n.title || "Klinik not"}
                failed={n.status === "error"}
                statusLabel={n.status === "error" ? "Başarısız" : "Not oluşturuluyor"}
                retrying={retryingId === n.id}
                onOpen={() => onOpenActiveNote(n.id)}
                onRetry={(e) => void handleRetry(e, "note", n.id)}
              />
            ))}

            {hasActive && saved.length > 0 && <Divider sx={{ my: 1 }} />}

            {/* Saved notes */}
            {saved.map((n) => {
              const selected = n.id === activeId;
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
                    bgcolor: selected ? "primary.light" : "transparent",
                    outline: "none",
                    "&:hover": {
                      bgcolor: selected ? "primary.light" : "action.hover",
                      "& .note-del": { opacity: 1 },
                    },
                    "&:focus-visible": {
                      boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}`,
                    },
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", pr: 3 }}>
                    <DescriptionRoundedIcon
                      fontSize="small"
                      sx={{ color: selected ? "primary.main" : "text.disabled", flexShrink: 0 }}
                    />
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", minWidth: 0 }}>
                        {n.status === "final" && (
                          <Tooltip title="Tamamlandı">
                            <CheckCircleRoundedIcon
                              sx={{ fontSize: 14, color: "success.main", flexShrink: 0 }}
                            />
                          </Tooltip>
                        )}
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{ fontWeight: selected ? 700 : 500 }}
                          title={n.title}
                        >
                          {n.title || "(başlıksız)"}
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {n.patient_name ? `${n.patient_name} · ` : ""}
                        {formatDate(n.created_at)}
                        {n.status === "final"
                          ? " · Tamamlandı"
                          : n.edited
                            ? " · Düzenlendi"
                            : n.note_seconds != null
                              ? ` · Not: ${formatSeconds(n.note_seconds)}`
                              : ""}
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

/** A row for an in-progress or failed session (transcription or note). Shows a
 *  spinner + stage while running, or a ⚠ + "Tekrar dene" button when failed. */
function ActiveRow({
  selected,
  icon,
  title,
  statusLabel,
  failed,
  retrying,
  onOpen,
  onRetry,
}: {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  statusLabel: string;
  failed: boolean;
  retrying: boolean;
  onOpen: () => void;
  onRetry: (e: React.MouseEvent) => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      sx={{
        cursor: "pointer",
        borderRadius: 2,
        px: 1.5,
        py: 1,
        bgcolor: selected ? "primary.light" : "transparent",
        outline: "none",
        "&:hover": { bgcolor: selected ? "primary.light" : "action.hover" },
        "&:focus-visible": { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}` },
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box sx={{ color: failed ? "error.main" : "primary.main", flexShrink: 0, display: "flex" }}>
          {failed ? <ErrorOutlineRoundedIcon fontSize="small" /> : icon}
        </Box>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }} title={title}>
            {title}
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mt: 0.25 }}>
            {!failed && <CircularProgress size={11} thickness={6} />}
            <Typography
              variant="caption"
              color={failed ? "error.main" : "text.secondary"}
              noWrap
            >
              {statusLabel}
            </Typography>
          </Stack>
        </Box>
        {failed && (
          <Chip
            size="small"
            color="primary"
            variant="outlined"
            icon={retrying ? <CircularProgress size={12} /> : <ReplayRoundedIcon />}
            label="Tekrar dene"
            onClick={onRetry}
            disabled={retrying}
            sx={{ flexShrink: 0 }}
          />
        )}
      </Stack>
    </Box>
  );
}
