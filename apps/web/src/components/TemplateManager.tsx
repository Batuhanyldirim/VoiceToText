import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import type { CustomTemplate } from "../types";
import {
  createCustomTemplate,
  deleteCustomTemplate,
  listCustomTemplates,
  updateCustomTemplate,
} from "../config/api";

// Manage custom note templates (ADR-0021): a dialog listing saved templates with
// create/edit/delete. A template is a named, reusable sample format (Markdown)
// that drives note generation — saved once, reused instead of re-pasting "free".

interface TemplateManagerProps {
  open: boolean;
  onClose: () => void;
  /** Called after any create/edit/delete so the caller can refresh its picker. */
  onChanged?: () => void;
}

type Mode = { view: "list" } | { view: "edit"; template: CustomTemplate | null };

export default function TemplateManager({ open, onClose, onChanged }: TemplateManagerProps) {
  const [templates, setTemplates] = useState<CustomTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ view: "list" });
  const [name, setName] = useState("");
  const [body, setBody] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setTemplates(await listCustomTemplates());
      setError(null);
    } catch {
      setError("Şablonlar yüklenemedi.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setMode({ view: "list" });
      void load();
    }
  }, [open]);

  const startNew = () => {
    setName("");
    setBody("");
    setMode({ view: "edit", template: null });
  };

  const startEdit = (t: CustomTemplate) => {
    setName(t.name);
    setBody(t.body);
    setMode({ view: "edit", template: t });
  };

  const save = async () => {
    if (!name.trim() || !body.trim()) return;
    setBusy(true);
    try {
      if (mode.view === "edit" && mode.template) {
        await updateCustomTemplate(mode.template.id, { name, body });
      } else {
        await createCustomTemplate(name, body);
      }
      await load();
      setMode({ view: "list" });
      onChanged?.();
    } catch {
      setError("Şablon kaydedilemedi.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: CustomTemplate) => {
    if (!window.confirm(`"${t.name}" şablonunu silmek istiyor musunuz?`)) return;
    setBusy(true);
    try {
      await deleteCustomTemplate(t.id);
      await load();
      onChanged?.();
    } catch {
      setError("Şablon silinemedi.");
    } finally {
      setBusy(false);
    }
  };

  const editing = mode.view === "edit";

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {editing ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <IconButton size="small" onClick={() => setMode({ view: "list" })} aria-label="Geri">
              <ArrowBackRoundedIcon fontSize="small" />
            </IconButton>
            {mode.view === "edit" && mode.template ? "Şablonu düzenle" : "Yeni şablon"}
          </Stack>
        ) : (
          "Şablonlar"
        )}
      </DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)} closeText="Kapat">
            {error}
          </Alert>
        )}

        {editing ? (
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Şablon adı"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
              autoFocus
              required
            />
            <TextField
              label="Şablon formatı (Markdown)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              fullWidth
              required
              multiline
              minRows={12}
              helperText="Notun izleyeceği örnek başlıklar/format. Örn: # Başlık, ## Bölüm, - madde."
              slotProps={{
                htmlInput: {
                  style: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: "0.875rem",
                  },
                },
              }}
            />
          </Stack>
        ) : loading ? (
          <Stack sx={{ alignItems: "center", py: 3 }}>
            <CircularProgress size={22} />
          </Stack>
        ) : templates.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
            Henüz özel şablon yok. Sık kullandığınız bir not formatını kaydedin.
          </Typography>
        ) : (
          <List dense>
            {templates.map((t) => (
              <ListItemButton key={t.id} onClick={() => startEdit(t)} disabled={busy}>
                <ListItemText
                  primary={t.name}
                  secondary={t.body.split("\n")[0]?.slice(0, 60) || ""}
                />
                <Tooltip title="Sil">
                  <span>
                    <IconButton
                      edge="end"
                      size="small"
                      color="error"
                      aria-label="Şablonu sil"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(t);
                      }}
                    >
                      <DeleteOutlineRoundedIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </ListItemButton>
            ))}
          </List>
        )}

        {!editing && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Button startIcon={<AddRoundedIcon />} onClick={startNew} disabled={busy}>
              Yeni şablon
            </Button>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {editing ? (
          <>
            <Button color="inherit" onClick={() => setMode({ view: "list" })} disabled={busy}>
              İptal
            </Button>
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={busy || !name.trim() || !body.trim()}
              startIcon={busy ? <CircularProgress size={16} /> : undefined}
            >
              Kaydet
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Kapat</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
