import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  IconButton,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import type { Note, ReviewFlag, Turn } from "../types";
import { correctTurn, getNote, noteAudioUrl } from "../config/api";
import { navigate } from "../utils/router";
import { formatTimestamp, speakerColor } from "../utils/format";

// Raw-transcript review + STT-error correction page (ADR-0029). The note already
// flags likely mistranscriptions ("Klinik İnceleme Gerekli"); here we surface those
// flags as STRUCTURED, clickable items over the RAW transcript so a clinician can:
//   1. jump the audio to the flagged moment (verify what was actually said), and
//   2. correct the turn text in place (a real, human-verified correction).
// Corrections touch ONLY the transcript turn — never the note body (ADR-0015).

interface Props {
  noteId: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  "ilaç": "İlaç",
  doz: "Doz",
  olumsuzlama: "Olumsuzlama",
  isim: "İsim",
  tarih: "Tarih",
  "sayı": "Sayı",
  belirsiz: "Belirsiz",
  "diğer": "Diğer",
};

export default function TranscriptReviewPage({ noteId }: Props) {
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const turnRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const n = await getNote(noteId, signal);
        setNote(n);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Not yüklenemedi");
      } finally {
        setLoading(false);
      }
    },
    [noteId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const turns: Turn[] = useMemo(() => note?.turns ?? [], [note]);
  const flags: ReviewFlag[] = useMemo(() => note?.review_flags ?? [], [note]);
  const hasAudio = !!note?.has_audio;
  const audioUrl = hasAudio ? noteAudioUrl(noteId) : null;

  // Map turn index → the flags anchored to it (for inline highlighting).
  const flagsByTurn = useMemo(() => {
    const m: Record<number, ReviewFlag[]> = {};
    for (const f of flags) {
      if (typeof f.turn_index === "number") (m[f.turn_index] ||= []).push(f);
    }
    return m;
  }, [flags]);

  const openFlags = flags.filter((f) => !f.resolved);
  const resolvedCount = flags.length - openFlags.length;

  const seekToTurn = useCallback(
    (idx: number) => {
      const turn = turns[idx];
      const el = audioRef.current;
      turnRefs.current[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveIdx(idx);
      if (el && turn && typeof turn.start === "number") {
        el.currentTime = turn.start;
        void el.play().catch(() => {
          /* autoplay may be blocked; controls remain */
        });
      }
    },
    [turns],
  );

  const onCorrected = (updated: Note, category?: string) => {
    setNote(updated);
    setToast(
      category
        ? `Düzeltme kaydedildi (${CATEGORY_LABELS[category] ?? category}).`
        : "Düzeltme kaydedildi.",
    );
  };

  if (loading) {
    return (
      <Container maxWidth="md" sx={{ py: 6, textAlign: "center" }}>
        <CircularProgress />
      </Container>
    );
  }
  if (error || !note) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Alert severity="error">{error ?? "Not bulunamadı."}</Alert>
        <Button startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate("/")} sx={{ mt: 2 }}>
          Ana sayfa
        </Button>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack spacing={2.5}>
        {/* Header */}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Tooltip title="Nota dön">
            <IconButton onClick={() => navigate(`/yeni?note=${encodeURIComponent(noteId)}`)}>
              <ArrowBackRoundedIcon />
            </IconButton>
          </Tooltip>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              Deşifre incelemesi
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {note.title || "Not"} — olası konuşma-tanıma hatalarını sesle karşılaştırıp düzeltin
            </Typography>
          </Box>
        </Stack>

        {/* Audio player */}
        {audioUrl ? (
          <Card variant="outlined">
            <CardContent sx={{ py: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
                <GraphicEqRoundedIcon fontSize="small" color="primary" />
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  Kaynak kayıt
                </Typography>
              </Stack>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                ref={audioRef}
                src={audioUrl}
                controls
                preload="none"
                style={{ width: "100%" }}
                onTimeUpdate={() => {
                  const t = audioRef.current?.currentTime ?? 0;
                  const idx = turns.findIndex(
                    (tn) =>
                      typeof tn.start === "number" &&
                      typeof tn.end === "number" &&
                      t >= tn.start &&
                      t < tn.end,
                  );
                  if (idx !== -1 && idx !== activeIdx) setActiveIdx(idx);
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <Alert severity="info">
            Bu not için ses kaydı yok; işaretli ifadeleri metin üzerinden inceleyip düzeltebilirsiniz.
          </Alert>
        )}

        {/* Flag summary */}
        <Card
          variant="outlined"
          sx={{
            borderColor: openFlags.length ? "warning.main" : "success.main",
            borderWidth: 2,
            bgcolor: openFlags.length ? "rgba(255,167,38,0.06)" : "rgba(76,175,80,0.06)",
          }}
        >
          <CardContent>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
              {openFlags.length ? (
                <WarningAmberRoundedIcon color="warning" />
              ) : (
                <CheckCircleRoundedIcon color="success" />
              )}
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Olası konuşma-tanıma hataları
              </Typography>
              <Chip
                size="small"
                label={`${openFlags.length} açık`}
                color={openFlags.length ? "warning" : "success"}
                variant="outlined"
              />
              {resolvedCount > 0 && (
                <Chip size="small" label={`${resolvedCount} çözüldü`} variant="outlined" />
              )}
            </Stack>
            <Divider sx={{ mb: 1.5 }} />
            {flags.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Model şüpheli bir ifade işaretlemedi. Yine de aşağıdaki deşifreyi gözden
                geçirebilirsiniz.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {flags.map((f, i) => (
                  <FlagRow
                    key={i}
                    flag={f}
                    onJump={
                      typeof f.turn_index === "number" ? () => seekToTurn(f.turn_index!) : undefined
                    }
                  />
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>

        {/* Raw transcript with inline correction */}
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 0.5 }}>
              Ham deşifre
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
              İşaretli konuşmalar sarı ile vurgulanır. Sesi o ana götürmek için ▶ simgesine,
              metni düzeltmek için ✎ simgesine dokunun.
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            <Stack spacing={0.5}>
              {turns.map((turn, i) => (
                <TurnRow
                  key={`${turn.start ?? i}-${i}`}
                  ref={(el) => {
                    turnRefs.current[i] = el;
                  }}
                  turn={turn}
                  index={i}
                  flags={flagsByTurn[i] ?? []}
                  active={i === activeIdx}
                  canSeek={hasAudio && typeof turn.start === "number"}
                  onSeek={() => seekToTurn(i)}
                  noteId={noteId}
                  onCorrected={onCorrected}
                />
              ))}
            </Stack>
          </CardContent>
        </Card>
      </Stack>

      <Snackbar
        open={!!toast}
        autoHideDuration={2500}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Container>
  );
}

// --- A single flag in the summary list -------------------------------------

function FlagRow({ flag, onJump }: { flag: ReviewFlag; onJump?: () => void }) {
  const cat = flag.category ?? "diğer";
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{
        alignItems: "center",
        p: 1,
        borderRadius: 1.5,
        bgcolor: flag.resolved ? "action.hover" : "transparent",
        opacity: flag.resolved ? 0.7 : 1,
      }}
    >
      <Chip size="small" label={CATEGORY_LABELS[cat] ?? cat} variant="outlined" />
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 600, textDecoration: flag.resolved ? "line-through" : "none" }}
        >
          "{flag.quote}"
        </Typography>
        {flag.reason ? (
          <Typography variant="caption" color="text.secondary">
            {flag.reason}
          </Typography>
        ) : null}
      </Box>
      {flag.resolved ? (
        <CheckCircleRoundedIcon color="success" fontSize="small" />
      ) : onJump ? (
        <Tooltip title="Sesde bu ana git">
          <IconButton size="small" onClick={onJump} color="primary">
            <PlayArrowRoundedIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Bu ifade deşifrede tam olarak bulunamadı">
          <Chip size="small" label="konum yok" variant="outlined" />
        </Tooltip>
      )}
    </Stack>
  );
}

// --- A single transcript turn (highlighted if flagged; inline-editable) -----

interface TurnRowProps {
  turn: Turn;
  index: number;
  flags: ReviewFlag[];
  active: boolean;
  canSeek: boolean;
  onSeek: () => void;
  noteId: string;
  onCorrected: (n: Note, category?: string) => void;
}

const TurnRow = forwardRef<HTMLDivElement, TurnRowProps>(function TurnRow(
  { turn, index, flags, active, canSeek, onSeek, noteId, onCorrected },
  ref,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flagged = flags.length > 0;
  const openFlagged = flags.some((f) => !f.resolved);
  const color = speakerColor(turn.speaker || "");

  const save = async () => {
    if (draft.trim() === turn.text.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const updated = await correctTurn(noteId, index, draft.trim());
      onCorrected(updated, flags[0]?.category);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      ref={ref}
      sx={{
        display: "flex",
        gap: 1,
        p: 1,
        borderRadius: 1.5,
        border: openFlagged ? "1px solid" : "1px solid transparent",
        borderColor: openFlagged ? "warning.main" : "transparent",
        bgcolor: active
          ? "primary.light"
          : openFlagged
            ? "rgba(255,167,38,0.10)"
            : turn.corrected
              ? "rgba(76,175,80,0.08)"
              : "transparent",
        transition: "background-color .15s",
      }}
    >
      <Box sx={{ flexShrink: 0, minWidth: 96 }}>
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
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
          {canSeek && (
            <Tooltip title="Sesde bu ana git">
              <IconButton size="small" onClick={onSeek} color={active ? "primary" : "default"}>
                <PlayArrowRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {!editing && (
            <Tooltip title="Metni düzelt">
              <IconButton
                size="small"
                onClick={() => {
                  setDraft(turn.text);
                  setEditing(true);
                }}
              >
                <EditRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {turn.corrected && !openFlagged && (
            <Tooltip title="Bu konuşma düzeltildi">
              <CheckCircleRoundedIcon color="success" fontSize="small" sx={{ mt: 0.5 }} />
            </Tooltip>
          )}
        </Stack>
      </Box>

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        {editing ? (
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
              <Button size="small" variant="contained" onClick={save} disabled={saving}>
                {saving ? "Kaydediliyor…" : "Kaydet"}
              </Button>
              <Button size="small" onClick={() => setEditing(false)} disabled={saving}>
                Vazgeç
              </Button>
            </Stack>
          </Stack>
        ) : (
          <>
            <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
              {turn.text}
            </Typography>
            {flagged && (
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: "wrap" }}>
                {flags.map((f, k) => (
                  <Chip
                    key={k}
                    size="small"
                    icon={
                      f.resolved ? (
                        <CheckCircleRoundedIcon />
                      ) : (
                        <WarningAmberRoundedIcon />
                      )
                    }
                    color={f.resolved ? "success" : "warning"}
                    variant="outlined"
                    label={f.reason || CATEGORY_LABELS[f.category ?? "diğer"] || "incele"}
                    sx={{ maxWidth: "100%" }}
                  />
                ))}
              </Stack>
            )}
          </>
        )}
      </Box>
    </Box>
  );
});
