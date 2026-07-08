import { useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import PersonRoundedIcon from "@mui/icons-material/PersonRounded";
import PersonAddAlt1RoundedIcon from "@mui/icons-material/PersonAddAlt1Rounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import type { Patient } from "../types";
import { createPatient, listPatients, setNotePatient } from "../config/api";

// Assign a note to a patient (ADR-0016). Explicit select-or-create model:
//  - unassigned → a "Hasta ata" button → a menu of existing patients + "Yeni hasta"
//  - "Yeni hasta" → a dialog (Ad + Hasta No + Kaydet) that creates then assigns
//  - assigned → a patient chip ("Ad · MRN") you can change or remove
// No free-text field, no auto-save, no accidental shared renames. Assignment is
// allowed even when a note is final — filing is metadata, not content (REQ-139).

interface PatientSelectorProps {
  noteId: string;
  patientId: string | null;
  patientName: string | null;
  onAssigned: (patientId: string | null, patientName: string | null) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}

export default function PatientSelector({
  noteId,
  patientId,
  patientName,
  onAssigned,
  onError,
  disabled = false,
}: PatientSelectorProps) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMrn, setNewMrn] = useState("");

  const fail = (m: string) => onError?.(m);

  const loadPatients = async () => {
    setLoading(true);
    try {
      setPatients(await listPatients());
    } catch {
      fail("Hastalar yüklenemedi.");
    } finally {
      setLoading(false);
    }
  };

  const openMenu = async (e: React.MouseEvent<HTMLElement>) => {
    setMenuAnchor(e.currentTarget);
    await loadPatients();
  };

  const assign = async (pid: string | null, pname: string | null) => {
    setBusy(true);
    try {
      await setNotePatient(noteId, pid);
      onAssigned(pid, pname);
    } catch {
      fail("Hasta ataması kaydedilemedi.");
    } finally {
      setBusy(false);
      setMenuAnchor(null);
    }
  };

  const pickExisting = (p: Patient) => void assign(p.id, p.name);

  const openNewDialog = () => {
    setMenuAnchor(null);
    setNewName("");
    setNewMrn("");
    setDialogOpen(true);
  };

  const saveNewPatient = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const p = await createPatient(name, newMrn.trim() || undefined);
      await setNotePatient(noteId, p.id);
      onAssigned(p.id, p.name);
      setDialogOpen(false);
    } catch {
      fail("Hasta oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  };

  // --- assigned: show a chip with change / remove ---------------------------
  if (patientId) {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
        <Chip
          icon={<PersonRoundedIcon />}
          label={patientName || "(hasta)"}
          color="primary"
          onDelete={disabled || busy ? undefined : () => void assign(null, null)}
          deleteIcon={busy ? <CircularProgress size={14} /> : <CloseRoundedIcon />}
        />
        <Button
          size="small"
          color="inherit"
          onClick={(e) => void openMenu(e)}
          disabled={disabled || busy}
          sx={{ color: "text.secondary" }}
        >
          Değiştir
        </Button>
        {renderMenu()}
        {renderDialog()}
      </Stack>
    );
  }

  // --- unassigned: an explicit "assign" button ------------------------------
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<PersonAddAlt1RoundedIcon />}
        onClick={(e) => void openMenu(e)}
        disabled={disabled || busy}
      >
        Hasta ata
      </Button>
      {renderMenu()}
      {renderDialog()}
    </>
  );

  function renderMenu() {
    return (
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 240, maxHeight: 360 } } }}
      >
        <MenuItem onClick={openNewDialog}>
          <PersonAddAlt1RoundedIcon fontSize="small" sx={{ mr: 1, color: "primary.main" }} />
          Yeni hasta…
        </MenuItem>
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
            <CircularProgress size={18} />
          </Box>
        )}
        {!loading && patients.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 1, display: "block" }}>
            Henüz hasta yok.
          </Typography>
        )}
        {patients.map((p) => (
          <MenuItem
            key={p.id}
            selected={p.id === patientId}
            onClick={() => pickExisting(p)}
          >
            <PersonRoundedIcon fontSize="small" sx={{ mr: 1, color: "text.disabled" }} />
            {p.name}
            {p.mrn ? (
              <Chip label={p.mrn} size="small" variant="outlined" sx={{ ml: 1 }} />
            ) : null}
          </MenuItem>
        ))}
      </Menu>
    );
  }

  function renderDialog() {
    return (
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
                if (e.key === "Enter" && newName.trim()) void saveNewPatient();
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
            onClick={() => void saveNewPatient()}
            disabled={busy || !newName.trim()}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Kaydet
          </Button>
        </DialogActions>
      </Dialog>
    );
  }
}
