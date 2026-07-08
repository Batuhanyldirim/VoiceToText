import { useEffect, useMemo, useState } from "react";
import {
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
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import PeopleAltRoundedIcon from "@mui/icons-material/PeopleAltRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import type { ActiveJob, ActiveNote, Patient, SavedNoteSummary } from "../types";
import {
  listActiveJobs,
  listActiveNotes,
  listNotes,
  listPatients,
} from "../config/api";
import { navigate } from "../utils/router";
import { Link } from "../utils/Link";

// Home / "Bugün" dashboard at "/" (ADR-0025). Composed entirely from EXISTING
// endpoints (no new backend): today's encounters, in-progress work to resume,
// unsigned drafts, and quick stats — grouped client-side.

function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function withinDays(iso: string | null | undefined, days: number): boolean {
  if (!iso) return false;
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return false;
  return Date.now() - d <= days * 86400_000;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

export default function HomePage() {
  const [notes, setNotes] = useState<SavedNoteSummary[]>([]);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [activeNotes, setActiveNotes] = useState<ActiveNote[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listNotes().catch(() => [] as SavedNoteSummary[]),
      listActiveJobs().catch(() => [] as ActiveJob[]),
      listActiveNotes().catch(() => [] as ActiveNote[]),
      listPatients().catch(() => [] as Patient[]),
    ]).then(([n, j, an, p]) => {
      if (cancelled) return;
      setNotes(n);
      setJobs(j);
      setActiveNotes(an);
      setPatients(p);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const todays = useMemo(() => notes.filter((n) => isToday(n.created_at)), [notes]);
  const drafts = useMemo(
    () => notes.filter((n) => (n.status ?? "draft") !== "final").slice(0, 8),
    [notes],
  );
  const weekCount = useMemo(
    () => notes.filter((n) => withinDays(n.created_at, 7)).length,
    [notes],
  );
  const inProgress = jobs.length + activeNotes.length;

  const openNote = (id: string) => navigate(`/yeni?note=${encodeURIComponent(id)}`);

  return (
    <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
      {/* Hero + primary CTA */}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        sx={{ justifyContent: "space-between", alignItems: { sm: "center" }, mb: 3 }}
      >
        <Box>
          <Typography variant="h4">Bugün</Typography>
          <Typography variant="body2" color="text.secondary">
            Muayeneden nota — kaydedin, düzenleyin, imzalayın.
          </Typography>
        </Box>
        <Button
          variant="contained"
          size="large"
          startIcon={<AddRoundedIcon />}
          onClick={() => navigate("/yeni?new=1")}
        >
          Yeni muayene
        </Button>
      </Stack>

      {loading ? (
        <Stack sx={{ alignItems: "center", py: 6 }}>
          <CircularProgress />
        </Stack>
      ) : (
        <Stack spacing={2.5}>
          {/* Quick stats */}
          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
            <StatCard label="Bugünkü muayene" value={todays.length} />
            <StatCard label="Bu hafta not" value={weekCount} />
            <StatCard
              label="Hasta"
              value={patients.length}
              onClick={() => navigate("/patients")}
              icon={<PeopleAltRoundedIcon fontSize="small" />}
            />
            <StatCard label="Devam eden" value={inProgress} highlight={inProgress > 0} />
          </Stack>

          {/* Resume in-progress work */}
          {inProgress > 0 && (
            <Card sx={{ borderColor: "primary.main", borderWidth: 1 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                  Devam eden
                </Typography>
                <Divider sx={{ mb: 1 }} />
                <Stack spacing={0.5}>
                  {jobs.map((j) => (
                    <HomeRow
                      key={`job-${j.id}`}
                      icon={<GraphicEqRoundedIcon fontSize="small" color="primary" />}
                      primary={j.name || "Deşifre"}
                      secondary={j.status === "error" ? "Başarısız" : "Deşifre sürüyor…"}
                      onClick={() => navigate(`/yeni?job=${encodeURIComponent(j.id)}`)}
                    />
                  ))}
                  {activeNotes.map((n) => (
                    <HomeRow
                      key={`note-${n.id}`}
                      icon={<DescriptionRoundedIcon fontSize="small" color="primary" />}
                      primary={n.title || "Klinik not"}
                      secondary={n.status === "error" ? "Başarısız" : "Not oluşturuluyor…"}
                      onClick={() => navigate(`/yeni?activeNote=${encodeURIComponent(n.id)}`)}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          )}

          {/* Today's encounters */}
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Bugünkü muayeneler
              </Typography>
              <Divider sx={{ mb: 1 }} />
              {todays.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Bugün henüz not yok. “Yeni muayene” ile başlayın.
                </Typography>
              ) : (
                <Stack spacing={0.5}>
                  {todays.map((n) => (
                    <HomeRow
                      key={n.id}
                      icon={<DescriptionRoundedIcon fontSize="small" sx={{ color: "text.disabled" }} />}
                      primary={n.chief_complaint || n.title || "(başlıksız)"}
                      secondary={`${fmtTime(n.created_at)}${n.patient_name ? ` · ${n.patient_name}` : ""}${n.visit_type ? ` · ${n.visit_type}` : ""}`}
                      chip={n.status === "final" ? "final" : "draft"}
                      onClick={() => openNote(n.id)}
                    />
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>

          {/* Needs attention: unsigned drafts */}
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                İncelenmesi gerekenler
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                  (imzalanmamış taslaklar)
                </Typography>
              </Typography>
              <Divider sx={{ mb: 1 }} />
              {drafts.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Bekleyen taslak yok. 👍
                </Typography>
              ) : (
                <Stack spacing={0.5}>
                  {drafts.map((n) => (
                    <HomeRow
                      key={n.id}
                      icon={<DescriptionRoundedIcon fontSize="small" sx={{ color: "warning.main" }} />}
                      primary={n.title || "(başlıksız)"}
                      secondary={`${n.patient_name ? `${n.patient_name} · ` : ""}${fmtTime(n.created_at)}`}
                      chip="draft"
                      onClick={() => openNote(n.id)}
                    />
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>

          <Box sx={{ textAlign: "center" }}>
            <Link to="/patients" style={{ textDecoration: "none" }}>
              <Button startIcon={<PeopleAltRoundedIcon />} color="inherit" sx={{ color: "text.secondary" }}>
                Tüm hastaları gör
              </Button>
            </Link>
          </Box>
        </Stack>
      )}
    </Container>
  );
}

function StatCard({
  label,
  value,
  icon,
  onClick,
  highlight,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
  onClick?: () => void;
  highlight?: boolean;
}) {
  return (
    <Card
      onClick={onClick}
      sx={{
        flex: "1 1 140px",
        minWidth: 130,
        cursor: onClick ? "pointer" : "default",
        borderColor: highlight ? "primary.main" : undefined,
        "&:hover": onClick ? { borderColor: "primary.main" } : {},
      }}
    >
      <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", color: "text.secondary" }}>
          {icon}
          <Typography variant="caption">{label}</Typography>
        </Stack>
        <Typography variant="h4" sx={{ fontWeight: 800, mt: 0.5 }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

function HomeRow({
  icon,
  primary,
  secondary,
  chip,
  onClick,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  chip?: "draft" | "final";
  onClick: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        p: 1,
        borderRadius: 1.5,
        cursor: "pointer",
        outline: "none",
        "&:hover": { bgcolor: "action.hover" },
        "&:focus-visible": { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.main}` },
      }}
    >
      {icon}
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {primary}
        </Typography>
        {secondary && (
          <Typography variant="caption" color="text.secondary" noWrap>
            {secondary}
          </Typography>
        )}
      </Box>
      {chip === "final" ? (
        <Chip icon={<CheckCircleRoundedIcon />} label="Tamamlandı" size="small" color="success" variant="outlined" />
      ) : chip === "draft" ? (
        <Chip label="Taslak" size="small" variant="outlined" />
      ) : null}
    </Box>
  );
}
