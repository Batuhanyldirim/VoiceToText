import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import type { SavedNoteSummary } from "../types";
import { deleteNote, listNotes } from "../config/api";

interface NotesHistoryProps {
  /** Open a saved note read-only (App fetches getNote(id) → NoteViewer live=false). */
  onOpen: (id: string) => void;
  /** Start a brand-new note (App routes to the note source picker). */
  onNew: () => void;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("tr-TR");
}

export default function NotesHistory({ onOpen, onNew }: NotesHistoryProps) {
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
      if (!(signal?.aborted)) {
        setLoadError(
          e instanceof Error
            ? e.message
            : "Notlar yüklenemedi. Servis çalışıyor mu?",
        );
      }
    } finally {
      if (!(signal?.aborted)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Bu notu silmek istediğinize emin misiniz?")) return;
      setDeletingId(id);
      try {
        await deleteNote(id);
        await refresh();
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : "Not silinemedi.",
        );
      } finally {
        setDeletingId(null);
      }
    },
    [refresh],
  );

  return (
    <Stack spacing={2.5}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{
          justifyContent: "space-between",
          alignItems: { xs: "flex-start", sm: "center" },
        }}
      >
        <Box>
          <Typography variant="h4" gutterBottom>
            Kayıtlı Notlar
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Daha önce oluşturulmuş klinik notların geçmişi.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddRoundedIcon />}
          onClick={onNew}
        >
          Yeni not
        </Button>
      </Stack>

      {loadError && <Alert severity="error">{loadError}</Alert>}

      {loading ? (
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: "center", py: 4, justifyContent: "center" }}
        >
          <CircularProgress size={20} />
          <Typography color="text.secondary">Notlar yükleniyor…</Typography>
        </Stack>
      ) : notes.length === 0 && !loadError ? (
        <Card>
          <CardContent>
            <Typography
              color="text.secondary"
              sx={{ py: 4, textAlign: "center" }}
            >
              Henüz kayıtlı not yok.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {notes.map((n) => (
            <Card key={n.id}>
              <CardContent>
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  spacing={2}
                  sx={{
                    justifyContent: "space-between",
                    alignItems: { xs: "flex-start", md: "center" },
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: "center", mb: 0.5 }}
                    >
                      <DescriptionRoundedIcon
                        color="primary"
                        fontSize="small"
                      />
                      <Typography sx={{ fontWeight: 700 }} noWrap>
                        {n.title || "(başlıksız)"}
                      </Typography>
                    </Stack>
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      sx={{ flexWrap: "wrap", mb: 0.5 }}
                    >
                      {n.source_name && (
                        <Chip label={n.source_name} size="small" variant="outlined" />
                      )}
                      <Chip label={n.template} size="small" variant="outlined" />
                      <Chip label={n.provider} size="small" variant="outlined" />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(n.created_at)}
                    </Typography>
                  </Box>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ flexShrink: 0 }}
                  >
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<OpenInNewRoundedIcon />}
                      onClick={() => onOpen(n.id)}
                    >
                      Aç
                    </Button>
                    <Tooltip title="Sil">
                      <span>
                        <IconButton
                          color="error"
                          onClick={() => void handleDelete(n.id)}
                          disabled={deletingId === n.id}
                          aria-label="Notu sil"
                        >
                          {deletingId === n.id ? (
                            <CircularProgress size={18} />
                          ) : (
                            <DeleteOutlineRoundedIcon />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
