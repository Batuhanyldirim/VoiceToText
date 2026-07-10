import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import PauseRoundedIcon from "@mui/icons-material/PauseRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import GroupsRoundedIcon from "@mui/icons-material/GroupsRounded";
import DoneRoundedIcon from "@mui/icons-material/DoneRounded";
import UndoRoundedIcon from "@mui/icons-material/UndoRounded";
import type { Note, ReviewFlag, Segment, Turn } from "../types";
import { correctTurn, getNote, noteAudioUrl, rediarizeNote, resolveFlag } from "../config/api";
import { navigate } from "../utils/router";

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
  // Which flag last drove playback, and whether audio is currently playing — so a
  // flag's ▶ button can flip to ⏸ and stop the audio in place (no scroll-to-top).
  const [playingFlag, setPlayingFlag] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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
  const segments: Segment[] = useMemo(() => note?.segments ?? [], [note]);
  const hasAudio = !!note?.has_audio;
  const audioUrl = hasAudio ? noteAudioUrl(noteId) : null;

  // Word-timestamp index (ADR-0030): all words with their start time, in order.
  // Powers word-precise seek — a turn only carries its whole-span start/end, which
  // is useless when diarization merged the conversation into one long turn.
  const allWords = useMemo(() => {
    const out: { word: string; start: number }[] = [];
    for (const s of segments) {
      for (const w of s.words ?? []) {
        if (w && typeof w.start === "number" && w.word) {
          out.push({ word: String(w.word), start: w.start });
        }
      }
    }
    return out;
  }, [segments]);

  // For a per-turn word list: match the turn's text words to timestamped words in
  // order (a moving pointer), so each word in the rendered turn can carry a seek
  // time. Falls back to the turn start when a word can't be timestamped.
  const turnWordTimes = useMemo(() => {
    const norm = (s: string) =>
      s.replace(/İ/g, "i").replace(/I/g, "ı").toLocaleLowerCase("tr").replace(/[^\wçğışöü]/gi, "");
    let ptr = 0;
    return turns.map((turn) => {
      const words = (turn.text || "").split(/(\s+)/); // keep whitespace tokens
      return words.map((tok) => {
        if (/^\s+$/.test(tok) || tok === "") return { tok, start: null as number | null };
        // advance the pointer to the next timestamped word that matches
        const target = norm(tok);
        let start: number | null = null;
        for (let k = ptr; k < allWords.length && k < ptr + 6; k++) {
          if (norm(allWords[k].word) === target) {
            start = allWords[k].start;
            ptr = k + 1;
            break;
          }
        }
        if (start === null && ptr < allWords.length) {
          // best-effort: take the next word's time and advance, keeps us roughly aligned
          start = allWords[ptr].start;
          ptr += 1;
        }
        return { tok, start };
      });
    });
  }, [turns, allWords]);

  const openFlags = flags.filter((f) => !f.resolved);
  const resolvedCount = flags.length - openFlags.length;

  // Per-flag context: the flagged phrase plus a window of surrounding transcript
  // (so the doctor sees enough to judge WITHOUT scrolling the full transcript).
  // Returns {before, quote, after} char slices of the turn text, or null when the
  // quote can't be located (a locationless flag falls back to quote-only).
  const flagContext = useCallback(
    (flag: ReviewFlag): { before: string; quote: string; after: string } | null => {
      if (typeof flag.turn_index !== "number") return null;
      const turn = turns[flag.turn_index];
      if (!turn?.text) return null;
      const range = findQuoteRange(turn.text, flag.quote || "");
      if (!range) return null;
      const PAD = 90; // chars of context on each side
      const b0 = Math.max(0, range[0] - PAD);
      const a1 = Math.min(turn.text.length, range[1] + PAD);
      return {
        before: (b0 > 0 ? "…" : "") + turn.text.slice(b0, range[0]),
        quote: turn.text.slice(range[0], range[1]),
        after: turn.text.slice(range[1], a1) + (a1 < turn.text.length ? "…" : ""),
      };
    },
    [turns],
  );

  // The one seek primitive: move the player to an absolute time + play. Start a
  // short LEAD_IN before the target so the doctor has a moment to get ready and
  // hears the run-up to the phrase; clamped at 0 so early timestamps don't go
  // negative.
  const seekToTime = useCallback((seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    const LEAD_IN_S = 0.6;
    el.currentTime = Math.max(0, seconds - LEAD_IN_S);
    void el.play().catch(() => {
      /* autoplay may be blocked; controls remain */
    });
  }, []);

  const pauseAudio = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  // Word-precise time for a flag's quote. PREFER the segments: each WhisperX
  // segment carries its own accurate start time, so we find the segment whose text
  // best matches the quote (Turkish-folded token overlap) and return its start.
  // This is far more reliable than walking the turn's tokens against a flat word
  // list — that moving-pointer alignment drifts badly across a long MERGED turn
  // (e.g. a 500-char turn), landing the player tens of seconds off. Falls back to
  // the token walk, then the turn start.
  const timeForFlag = useCallback(
    (quote: string, turnIndex: number): number | null => {
      const turn = turns[turnIndex];
      if (!turn) return null;

      // 1) Best-matching segment by folded-token overlap of the quote.
      const fold = (s: string) =>
        s
          .replace(/İ/g, "i")
          .replace(/I/g, "ı")
          .toLocaleLowerCase("tr")
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .trim();
      const qTokens = fold(quote).split(/\s+/).filter(Boolean);
      if (qTokens.length && segments.length) {
        const qSet = new Set(qTokens);
        // Restrict to segments within the turn's time window when known (avoids a
        // false match on the same words spoken elsewhere in a long recording).
        const inWindow = (s: Segment) =>
          typeof turn.start !== "number" ||
          typeof turn.end !== "number" ||
          typeof s.start !== "number" ||
          (s.start >= turn.start - 0.5 && s.start <= turn.end + 0.5);
        let best: { start: number; score: number } | null = null;
        for (const s of segments) {
          if (typeof s.start !== "number" || !inWindow(s)) continue;
          const segTokens = fold(String(s.text ?? "")).split(/\s+/).filter(Boolean);
          if (!segTokens.length) continue;
          const segSet = new Set(segTokens);
          const hits = qTokens.filter((t) => segSet.has(t)).length;
          if (hits === 0) continue;
          // coverage of the quote, lightly rewarding a tight segment
          const score = hits / qTokens.length + (segTokens.filter((t) => qSet.has(t)).length / segTokens.length) * 0.25;
          if (!best || score > best.score) best = { start: s.start, score };
        }
        if (best && best.score >= 0.5) return best.start;
      }

      // 2) Fallback: walk the turn's tokens against the flat word-time list.
      const range = findQuoteRange(turn.text || "", quote);
      const wt = turnWordTimes[turnIndex] || [];
      if (range) {
        let pos = 0;
        for (const { tok, start } of wt) {
          if (pos + tok.length > range[0]) {
            if (typeof start === "number") return start;
            break;
          }
          pos += tok.length;
        }
      }
      return typeof turn.start === "number" ? turn.start : null;
    },
    [turns, turnWordTimes, segments],
  );

  // Play a specific FLAG: seek the audio to that PHRASE's word time (not the turn
  // start) so it's audible even inside a huge merged turn, and remember which flag
  // drives playback (for the ▶/⏸ toggle).
  const seekToFlag = useCallback(
    (flagIndex: number, turnIndex: number, quote: string) => {
      setPlayingFlag(flagIndex);
      const t = timeForFlag(quote, turnIndex);
      if (typeof t === "number") seekToTime(t);
    },
    [timeForFlag, seekToTime],
  );

  // Play/pause toggle for a flag's ▶ button: if this flag is the one currently
  // playing, pause in place; otherwise (re)seek to it and play. Lets the doctor
  // stop the audio from the item without scrolling up to the player.
  const toggleFlagPlay = useCallback(
    (flagIndex: number, turnIndex: number, quote: string) => {
      if (playingFlag === flagIndex && isPlaying) {
        pauseAudio();
      } else {
        seekToFlag(flagIndex, turnIndex, quote);
      }
    },
    [playingFlag, isPlaying, pauseAudio, seekToFlag],
  );

  const [resolvingFlag, setResolvingFlag] = useState<number | null>(null);
  const onToggleFlag = async (flagIndex: number, resolved: boolean) => {
    setResolvingFlag(flagIndex);
    try {
      const updated = await resolveFlag(noteId, flagIndex, resolved);
      setNote(updated);
      setToast(resolved ? "İşaret incelendi olarak işaretlendi." : "İşaret yeniden açıldı.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "İşlem başarısız");
    } finally {
      setResolvingFlag(null);
    }
  };

  // Correct a flag's phrase in place: replace the flagged quote inside its turn
  // with `newPhrase`, then persist the whole turn (reuses the same turn-correction
  // path as ADR-0029). Keeps the surrounding turn text intact. Scoped to THIS flag
  // (flagIndex): only it resolves and its quote re-anchors to `newPhrase`, so it
  // can be re-edited later (fix a typo in the edit) and sibling flags on the same
  // merged turn stay open.
  const correctFlagPhrase = useCallback(
    async (flagIndex: number, turnIndex: number, quote: string, newPhrase: string): Promise<boolean> => {
      const turn = turns[turnIndex];
      if (!turn) return false;
      const range = findQuoteRange(turn.text || "", quote);
      const oldText = turn.text || "";
      const newText = range
        ? oldText.slice(0, range[0]) + newPhrase.trim() + oldText.slice(range[1])
        : // no located range (shouldn't happen for a located flag) — return false so
          // the UI keeps the phrase editor open with an explanatory error.
          null;
      if (newText === null) return false;
      const updated = await correctTurn(noteId, turnIndex, newText.trim(), {
        flagIndex,
        newQuote: newPhrase.trim(),
      });
      setNote(updated);
      setToast("Düzeltme kaydedildi.");
      return true;
    },
    [turns, noteId],
  );

  const [rediarBusy, setRediarBusy] = useState(false);
  const doRediar = async () => {
    setRediarBusy(true);
    try {
      const updated = await rediarizeNote(noteId);
      setNote(updated);
      setActiveIdx(null);
      setToast(
        updated.rediar?.applied
          ? "Konuşmacılar konuşma akışına göre yeniden atandı."
          : "Yeniden atama uygulanmadı (yeterince ayırt edilemedi); mevcut etiketler korundu.",
      );
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Yeniden atama başarısız");
    } finally {
      setRediarBusy(false);
    }
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
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
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
              <Box sx={{ flexGrow: 1 }} />
              <Button
                size="small"
                variant="outlined"
                startIcon={<GroupsRoundedIcon />}
                onClick={doRediar}
                disabled={rediarBusy}
              >
                {rediarBusy ? "Atanıyor…" : "Konuşmacıları yeniden ata"}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
              Her işaret için şüpheli ifadeyi çevresiyle görüp ▶ ile o anı dinleyebilir,
              doğruysa “İncelendi” ile kapatabilir ya da ✎ ile yalnızca o ifadeyi düzeltebilirsiniz.
              Konuşmacılar karıştıysa “Konuşmacıları yeniden ata” ile deneyin.
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            {flags.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Model şüpheli bir ifade işaretlemedi. Aşağıdan tüm deşifreyi açıp gözden
                geçirebilirsiniz.
              </Typography>
            ) : (
              <Stack spacing={1.25}>
                {flags.map((f, i) => (
                  <FlagCard
                    key={i}
                    flag={f}
                    context={flagContext(f)}
                    canSeek={hasAudio && typeof f.turn_index === "number"}
                    playing={playingFlag === i && isPlaying}
                    busy={resolvingFlag === i}
                    onPlay={
                      typeof f.turn_index === "number"
                        ? () => toggleFlagPlay(i, f.turn_index!, f.quote)
                        : undefined
                    }
                    onToggle={(resolved) => onToggleFlag(i, resolved)}
                    onCorrectPhrase={
                      typeof f.turn_index === "number"
                        ? (newPhrase) => correctFlagPhrase(i, f.turn_index!, f.quote, newPhrase)
                        : undefined
                    }
                  />
                ))}
              </Stack>
            )}
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

// --- A single flag as a self-contained review+fix card ----------------------
// The primary fix surface (the full transcript is collapsed below). Shows the
// suspect phrase IN CONTEXT, plays its exact audio moment, and lets the doctor
// either acknowledge it (transcript already correct) or fix just that phrase.

function FlagCard({
  flag,
  context,
  canSeek,
  playing,
  busy,
  onPlay,
  onToggle,
  onCorrectPhrase,
}: {
  flag: ReviewFlag;
  context: { before: string; quote: string; after: string } | null;
  canSeek?: boolean;
  playing?: boolean;
  busy?: boolean;
  onPlay?: () => void;
  onToggle?: (resolved: boolean) => void;
  onCorrectPhrase?: (newPhrase: string) => Promise<boolean>;
}) {
  const cat = flag.category ?? "diğer";
  const acknowledged = flag.resolved && flag.resolution !== "corrected";
  const corrected = flag.resolved && flag.resolution === "corrected";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(context?.quote ?? flag.quote ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(context?.quote ?? flag.quote ?? "");
    setErr(null);
    setEditing(true);
  };

  // Play/pause this flag's audio. `playing` = this flag is currently the one
  // playing, so the button becomes ⏸ and stops it in place (no scroll to the
  // player). Shown in the actions row AND inside the editor so you can still
  // listen while correcting.
  const playButton =
    onPlay && canSeek ? (
      <Tooltip title={playing ? "Durdur" : "Sesde bu ana git"}>
        <IconButton size="small" onClick={onPlay} color="primary">
          {playing ? <PauseRoundedIcon /> : <PlayArrowRoundedIcon />}
        </IconButton>
      </Tooltip>
    ) : null;
  const saveEdit = async () => {
    if (!onCorrectPhrase) return;
    setSaving(true);
    setErr(null);
    try {
      const ok = await onCorrectPhrase(draft);
      if (ok) setEditing(false);
      else setErr("Bu ifade metinde tam bulunamadı; tüm deşifreden düzeltin.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Kaydedilemedi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 2,
        border: "1px solid",
        borderColor: flag.resolved ? "success.light" : "warning.light",
        bgcolor: flag.resolved ? "rgba(76,175,80,0.06)" : "rgba(255,167,38,0.07)",
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Chip size="small" label={CATEGORY_LABELS[cat] ?? cat} variant="outlined" sx={{ mt: 0.25 }} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {/* the suspect phrase in its surrounding context */}
          {context ? (
            <Typography variant="body2" sx={{ lineHeight: 1.7 }}>
              <span style={{ color: "rgba(0,0,0,0.55)" }}>{context.before}</span>
              <Box
                component="mark"
                sx={{
                  bgcolor: flag.resolved ? "rgba(76,175,80,0.35)" : "rgba(255,167,38,0.55)",
                  borderRadius: 0.5,
                  px: 0.25,
                  fontWeight: 700,
                  textDecoration: corrected ? "line-through" : "none",
                }}
              >
                {context.quote}
              </Box>
              <span style={{ color: "rgba(0,0,0,0.55)" }}>{context.after}</span>
            </Typography>
          ) : (
            <Typography
              variant="body2"
              sx={{ fontWeight: 700, textDecoration: flag.resolved ? "line-through" : "none" }}
            >
              "{flag.quote}"
            </Typography>
          )}
          {flag.reason ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {flag.reason}
            </Typography>
          ) : null}

          {/* inline phrase editor */}
          {editing ? (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                size="small"
                fullWidth
                autoFocus
                multiline
                disabled={saving}
                label="Doğru ifade"
              />
              {err && <Alert severity="error">{err}</Alert>}
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Button size="small" variant="contained" onClick={saveEdit} disabled={saving}>
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </Button>
                <Button size="small" onClick={() => setEditing(false)} disabled={saving}>
                  Vazgeç
                </Button>
                {/* keep playback reachable while editing */}
                {playButton}
              </Stack>
            </Stack>
          ) : null}
        </Box>

        {/* actions */}
        {!editing && (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", flexShrink: 0 }}>
            {playButton}
            {/* Edit is available while OPEN and after a CORRECTION (to fix a typo in
                the edit) — but not for a merely-acknowledged flag (nothing to fix). */}
            {onCorrectPhrase && !acknowledged ? (
              <Tooltip title={corrected ? "Düzeltmeyi tekrar düzenle" : "Bu ifadeyi düzelt"}>
                <IconButton size="small" onClick={startEdit}>
                  <EditRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : null}
            {flag.resolved ? (
              <>
                <Tooltip title={corrected ? "Düzeltildi" : "İncelendi"}>
                  <CheckCircleRoundedIcon color="success" fontSize="small" />
                </Tooltip>
                {acknowledged && onToggle ? (
                  <Tooltip title="İncelendi işaretini geri al">
                    <span>
                      <IconButton size="small" onClick={() => onToggle(false)} disabled={busy}>
                        {busy ? <CircularProgress size={16} /> : <UndoRoundedIcon fontSize="small" />}
                      </IconButton>
                    </span>
                  </Tooltip>
                ) : null}
              </>
            ) : onToggle ? (
              <Tooltip title="Deşifre doğru — incelendi olarak işaretle">
                <Button
                  size="small"
                  variant="outlined"
                  color="success"
                  startIcon={busy ? <CircularProgress size={14} /> : <DoneRoundedIcon />}
                  onClick={() => onToggle(true)}
                  disabled={busy}
                >
                  İncelendi
                </Button>
              </Tooltip>
            ) : null}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

// Locate a flag's quote inside the turn text so we can highlight the EXACT phrase.
// Tolerant like the backend's fuzzy match: case-insensitive (Turkish İ/I aware) and
// whitespace-collapsed, so "Marmaray'ın elbisesi" is found even if spacing differs.
// Returns the [start,end) char range in the ORIGINAL text, or null if not found.
//
// The LLM's quote is often a PARAPHRASE, not a verbatim copy (e.g. it wrote
// "enzimleri" where the transcript says "enzimler"), so an exact/whitespace-flexible
// match can miss even though the backend located the turn via token overlap. When
// the exact match fails we fall back to the best contiguous WORD-SPAN whose folded
// tokens overlap the quote's — mirroring review.locate_flags server-side — so we
// return the ACTUAL transcript substring (which is what the editor must replace).
function findQuoteRange(text: string, quote: string): [number, number] | null {
  if (!text || !quote) return null;
  const trLower = (s: string) =>
    s.replace(/İ/g, "i").replace(/I/g, "ı").toLocaleLowerCase("tr");
  // 1) exact, whitespace-flexible match on the raw quote.
  const esc = trLower(quote.trim())
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  try {
    const m = new RegExp(esc).exec(trLower(text));
    if (m && m.index >= 0) return [m.index, m.index + m[0].length];
  } catch {
    /* bad regex → fall through to fuzzy */
  }
  // 2) fuzzy fallback: pick the contiguous run of turn words that best covers the
  //    quote's word set. Turkish-fold each word for comparison (İ/I + strip
  //    non-word chars) but index into the ORIGINAL text char offsets.
  const fold = (s: string) => trLower(s).replace(/[^\p{L}\p{N}]/gu, "");
  const qTokens = new Set(quote.split(/\s+/).map(fold).filter(Boolean));
  if (qTokens.size === 0) return null;
  // tokenize the turn into [start,end,folded] word spans
  const words: { start: number; end: number; f: string }[] = [];
  const re = /\S+/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(text)) !== null) {
    const f = fold(mm[0]);
    if (f) words.push({ start: mm.index, end: mm.index + mm[0].length, f });
  }
  if (words.length === 0) return null;
  const target = qTokens.size; // window ~ number of quote words
  let best: { start: number; end: number; score: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= target + 2 && i + len <= words.length; len++) {
      const span = words.slice(i, i + len);
      const hits = span.filter((w) => qTokens.has(w.f)).length;
      // score: fraction of quote tokens covered, lightly penalizing extra words
      const score = hits / qTokens.size - (len - hits) * 0.05;
      if (hits > 0 && (!best || score > best.score)) {
        best = { start: span[0].start, end: span[span.length - 1].end, score };
      }
    }
  }
  // Require covering at least half the quote's tokens (same 0.5 bar as the backend).
  if (best && best.score >= 0.5) return [best.start, best.end];
  return null;
}
