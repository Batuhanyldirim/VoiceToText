import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import PersonRoundedIcon from "@mui/icons-material/PersonRounded";
import PersonAddAlt1RoundedIcon from "@mui/icons-material/PersonAddAlt1Rounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import type { Patient } from "../types";
import { createPatient, listPatients } from "../config/api";
import { navigate } from "../utils/router";
import { Link } from "../utils/Link";

// Patient list page (ADR-0024): every patient with encounter count + last visit,
// searchable by name/MRN, with create + open. Mounted at /patients.

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function PatientListPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMrn, setNewMrn] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setPatients(await listPatients());
      setError(null);
    } catch {
      setError("Hastalar yüklenemedi. Servis çalışıyor mu?");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.mrn ?? "").toLowerCase().includes(q),
    );
  }, [patients, query]);

  const createAndOpen = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const p = await createPatient(newName.trim(), newMrn.trim() || undefined);
      setDialogOpen(false);
      setNewName("");
      setNewMrn("");
      navigate(`/patients/${encodeURIComponent(p.id)}`);
    } catch {
      setError("Hasta oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Typography variant="h4">Hastalar</Typography>
        <Button
          variant="contained"
          startIcon={<PersonAddAlt1RoundedIcon />}
          onClick={() => setDialogOpen(true)}
        >
          Yeni hasta
        </Button>
      </Stack>

      <TextField
        fullWidth
        size="small"
        placeholder="Ad veya hasta no ile ara…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 2 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Stack sx={{ alignItems: "center", py: 6 }}>
          <CircularProgress />
        </Stack>
      ) : filtered.length === 0 ? (
        <Typography color="text.secondary" sx={{ py: 6, textAlign: "center" }}>
          {patients.length === 0
            ? "Henüz hasta yok. Bir not oluştururken hasta atayın veya buradan ekleyin."
            : "Eşleşen hasta bulunamadı."}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {filtered.map((p) => (
            <Link
              key={p.id}
              to={`/patients/${encodeURIComponent(p.id)}`}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 2,
                  border: "1px solid rgba(26,26,46,0.10)",
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  cursor: "pointer",
                  "&:hover": { bgcolor: "action.hover", borderColor: "primary.main" },
                }}
              >
                <PersonRoundedIcon color="primary" />
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>
                    {p.name}
                    {p.mrn ? (
                      <Chip label={p.mrn} size="small" variant="outlined" sx={{ ml: 1 }} />
                    ) : null}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {p.note_count ?? 0} muayene · Son ziyaret: {formatDate(p.last_visit_at)}
                  </Typography>
                </Box>
              </Box>
            </Link>
          ))}
        </Stack>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Yeni hasta</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Ad Soyad"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              fullWidth
              autoFocus
              required
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) void createAndOpen();
              }}
            />
            <TextField
              label="Hasta No (isteğe bağlı)"
              value={newMrn}
              onChange={(e) => setNewMrn(e.target.value)}
              fullWidth
              helperText="Aynı ada sahip mevcut bir hasta varsa yeniden kullanılır."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setDialogOpen(false)} disabled={busy}>
            İptal
          </Button>
          <Button
            variant="contained"
            onClick={() => void createAndOpen()}
            disabled={busy || !newName.trim()}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Oluştur ve aç
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
