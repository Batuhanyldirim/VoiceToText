import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import PersonRoundedIcon from "@mui/icons-material/PersonRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import type { PatientDetail } from "../types";
import { getPatient } from "../config/api";
import { ApiError } from "../config/api";
import { navigate } from "../utils/router";
import { Link } from "../utils/Link";

// Patient page (ADR-0024): header + union problem/med rollup across the patient's
// notes + encounter timeline. Mounted at /patients/:id.

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function PatientPage({ patientId }: { patientId: string }) {
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPatient(patientId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled)
          setError(
            e instanceof ApiError && e.status === 404
              ? "Hasta bulunamadı."
              : "Hasta yüklenemedi.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  return (
    <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
      <Button
        startIcon={<ArrowBackRoundedIcon />}
        onClick={() => navigate("/patients")}
        color="inherit"
        sx={{ color: "text.secondary", mb: 1 }}
      >
        Hastalar
      </Button>

      {loading ? (
        <Stack sx={{ alignItems: "center", py: 6 }}>
          <CircularProgress />
        </Stack>
      ) : error || !detail ? (
        <Alert severity="error">{error ?? "Hasta yüklenemedi."}</Alert>
      ) : (
        <Stack spacing={2.5}>
          {/* Header */}
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{ justifyContent: "space-between", alignItems: { sm: "center" } }}
          >
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <PersonRoundedIcon color="primary" />
                <Typography variant="h4">{detail.name}</Typography>
                {detail.mrn ? <Chip label={detail.mrn} size="small" variant="outlined" /> : null}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {detail.notes.length} muayene
                {detail.notes[0] ? ` · Son ziyaret: ${fmtDate(detail.notes[0].created_at)}` : ""}
              </Typography>
            </Box>
            <Button
              variant="contained"
              startIcon={<AddRoundedIcon />}
              onClick={() => navigate(`/?new=1&patient=${encodeURIComponent(detail.id)}`)}
            >
              Bu hasta için yeni muayene
            </Button>
          </Stack>

          {/* Rollup: current problems + medications (union across notes) */}
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Güncel durum
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                  (muayenelerden derlendi)
                </Typography>
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={3}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                    Aktif sorunlar
                  </Typography>
                  {detail.problems_summary.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Kayıtlı sorun yok.
                    </Typography>
                  ) : (
                    <Stack component="ul" sx={{ m: 0, pl: 2.5 }} spacing={0.25}>
                      {detail.problems_summary.map((p, i) => (
                        <Typography component="li" variant="body2" key={i}>
                          {p.name}
                          {p.status ? ` — ${p.status}` : ""}
                        </Typography>
                      ))}
                    </Stack>
                  )}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                    Güncel ilaçlar
                  </Typography>
                  {detail.medications_summary.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Kayıtlı ilaç yok.
                    </Typography>
                  ) : (
                    <Stack component="ul" sx={{ m: 0, pl: 2.5 }} spacing={0.25}>
                      {detail.medications_summary.map((m, i) => (
                        <Typography component="li" variant="body2" key={i}>
                          {m.name}
                          {[m.dose, m.route, m.frequency].filter(Boolean).length
                            ? ` — ${[m.dose, m.route, m.frequency].filter(Boolean).join(", ")}`
                            : ""}
                        </Typography>
                      ))}
                    </Stack>
                  )}
                </Box>
              </Stack>
            </CardContent>
          </Card>

          {/* Encounter timeline */}
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Muayeneler
          </Typography>
          {detail.notes.length === 0 ? (
            <Typography color="text.secondary" variant="body2">
              Bu hastaya ait not yok.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {detail.notes.map((n) => (
                <Link
                  key={n.id}
                  to={`/?note=${encodeURIComponent(n.id)}`}
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
                    <DescriptionRoundedIcon sx={{ color: "text.disabled" }} />
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600 }} noWrap>
                        {n.chief_complaint || n.title || "(başlıksız)"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {fmtDate(n.created_at)}
                        {n.visit_type ? ` · ${n.visit_type}` : ""}
                      </Typography>
                    </Box>
                    {n.status === "final" ? (
                      <Chip
                        icon={<CheckCircleRoundedIcon />}
                        label="Tamamlandı"
                        size="small"
                        color="success"
                        variant="outlined"
                      />
                    ) : (
                      <Chip label="Taslak" size="small" variant="outlined" />
                    )}
                  </Box>
                </Link>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Container>
  );
}
