import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import ClearRoundedIcon from "@mui/icons-material/ClearRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import RecordVoiceOverRoundedIcon from "@mui/icons-material/RecordVoiceOverRounded";
import TranslateRoundedIcon from "@mui/icons-material/TranslateRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import type { DownloadFormat, JobResult } from "../types";
import { downloadUrl } from "../config/api";
import { formatTimestamp, isAudioFile, languageLabel } from "../utils/format";
import TurnBubble from "./TurnBubble";

// Above this many turns we render a capped window with a "show all" escape
// hatch so the DOM stays light and scrolling stays smooth.
const RENDER_CAP = 300;

interface TranscriptViewerProps {
  jobId: string;
  result: JobResult;
  file: File | null;
  onReset: () => void;
}

export default function TranscriptViewer({
  jobId,
  result,
  file,
  onReset,
}: TranscriptViewerProps) {
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Build a blob URL for the uploaded file so we can embed a player.
  const audioUrl = useMemo(() => {
    if (file && isAudioFile(file)) return URL.createObjectURL(file);
    return null;
  }, [file]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const canSeek = audioUrl !== null;

  const turns = result.turns ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return turns;
    return turns.filter((t) => t.text.toLowerCase().includes(q));
  }, [turns, query]);

  const capped = filtered.length > RENDER_CAP && !showAll;
  const visible = capped ? filtered.slice(0, RENDER_CAP) : filtered;

  const speakerCount = useMemo(() => {
    if (result.num_speakers) return result.num_speakers;
    return new Set(turns.map((t) => t.speaker)).size;
  }, [result.num_speakers, turns]);

  const handleSeek = (start: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = start;
    void el.play().catch(() => {
      /* autoplay may be blocked; ignore */
    });
  };

  const buildPlainText = () =>
    turns
      .map((t) => `[${formatTimestamp(t.start)}] ${t.speaker}: ${t.text}`)
      .join("\n");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildPlainText());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = (fmt: DownloadFormat) => {
    const a = document.createElement("a");
    a.href = downloadUrl(jobId, fmt);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Stack spacing={2.5}>
      {/* Header card */}
      <Card>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            sx={{
              justifyContent: "space-between",
              alignItems: { xs: "flex-start", md: "center" },
            }}
          >
            <Box>
              <Typography variant="h5" gutterBottom>
                Transcript
              </Typography>
              <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap" }}
            >
                <Chip
                  icon={<TranslateRoundedIcon />}
                  label={languageLabel(result.language)}
                  size="small"
                />
                <Chip
                  icon={<RecordVoiceOverRoundedIcon />}
                  label={`${speakerCount} speaker${speakerCount === 1 ? "" : "s"}`}
                  size="small"
                />
                <Chip
                  label={`${turns.length} turn${turns.length === 1 ? "" : "s"}`}
                  size="small"
                  variant="outlined"
                />
              </Stack>
            </Box>
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: "wrap" }}
            >
              <Button
                variant="outlined"
                startIcon={<ContentCopyRoundedIcon />}
                onClick={handleCopy}
              >
                Copy
              </Button>
              <Button
                variant="outlined"
                startIcon={<DownloadRoundedIcon />}
                onClick={() => handleDownload("txt")}
              >
                TXT
              </Button>
              <Button
                variant="outlined"
                startIcon={<DownloadRoundedIcon />}
                onClick={() => handleDownload("srt")}
              >
                SRT
              </Button>
              <Button
                variant="outlined"
                startIcon={<DownloadRoundedIcon />}
                onClick={() => handleDownload("json")}
              >
                JSON
              </Button>
              <Tooltip title="Transcribe another file">
                <IconButton onClick={onReset} color="primary">
                  <ReplayRoundedIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          {audioUrl && (
            <Box sx={{ mt: 2 }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                ref={audioRef}
                src={audioUrl}
                controls
                style={{ width: "100%" }}
              />
              <Typography variant="caption" color="text.secondary">
                Tip: click any turn to jump the player to that moment.
              </Typography>
            </Box>
          )}

          <Divider sx={{ my: 2 }} />

          <TextField
            fullWidth
            size="small"
            placeholder="Search transcript…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRoundedIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <ClearRoundedIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : null,
              },
            }}
          />
          {query && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 1, display: "block" }}
            >
              {filtered.length} matching turn{filtered.length === 1 ? "" : "s"}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Transcript body */}
      <Card>
        <CardContent>
          {filtered.length === 0 ? (
            <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
              {turns.length === 0
                ? "No transcript turns were produced."
                : "No turns match your search."}
            </Typography>
          ) : (
            <Stack spacing={2}>
              {visible.map((turn, i) => (
                <TurnBubble
                  key={`${turn.start}-${i}`}
                  turn={turn}
                  query={query}
                  clickable={canSeek}
                  onSeek={handleSeek}
                />
              ))}
            </Stack>
          )}

          {capped && (
            <Box sx={{ mt: 3 }}>
              <Alert
                severity="info"
                action={
                  <Button color="inherit" size="small" onClick={() => setShowAll(true)}>
                    Show all
                  </Button>
                }
              >
                Showing the first {RENDER_CAP} of {filtered.length} turns for
                performance.
              </Alert>
            </Box>
          )}
        </CardContent>
      </Card>

      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message="Transcript copied to clipboard"
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Stack>
  );
}
