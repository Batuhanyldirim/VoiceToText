import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import type { Note, NoteSSEPayload, NoteStage } from "../types";
import { ApiError, getNote, noteEventsUrl } from "../config/api";

// A vanished note job (server restarted mid-run) surfaces as a 404 — terminal.
const GONE_MESSAGE =
  "This note is no longer available — the server may have restarted. Please generate it again.";

interface NoteViewerProps {
  noteId: string;
  onBack: () => void;
  onReset: () => void;
}

// Split a note into the body and a trailing "Clinician Review Needed" region
// (section E), if present. We match a heading line that mentions clinician
// review so we can surface it in a distinct callout.
const REVIEW_HEADING =
  /^\s*(?:#+\s*)?(?:\*\*)?\s*(?:E[.)]\s*)?clinician review needed.*$/im;

function splitReviewSection(text: string): {
  body: string;
  review: string | null;
} {
  const match = REVIEW_HEADING.exec(text);
  if (!match || match.index === undefined) return { body: text, review: null };
  return {
    body: text.slice(0, match.index).trimEnd(),
    review: text.slice(match.index).trim(),
  };
}

const NOTE_TEXT_SX = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: "0.875rem",
  lineHeight: 1.6,
  m: 0,
} as const;

export default function NoteViewer({
  noteId,
  onBack,
  onReset,
}: NoteViewerProps) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<NoteStage>("start");
  const [message, setMessage] = useState("Starting…");
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<"sse" | "polling">("sse");
  const [copied, setCopied] = useState(false);

  const finishedRef = useRef(false);

  useEffect(() => {
    finishedRef.current = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let abort: AbortController | null = null;
    let cancelled = false;

    function finish(job: Note) {
      if (finishedRef.current || cancelled) return;
      finishedRef.current = true;
      const finalText = job.result?.note ?? job.note ?? "";
      if (finalText) setNote(finalText);
      setStatus("done");
    }

    async function fetchResultAndFinish(attempt = 0) {
      if (finishedRef.current || cancelled) return;
      try {
        const job = await getNote(noteId);
        if (cancelled) return;
        if (job.status === "error") {
          setError(job.error ?? "Note generation failed.");
          setStatus("error");
          return;
        }
        if (job.status === "done") {
          finish(job);
          return;
        }
        // "done" event but result not published yet — retry, then poll-fallback
        // (defense in depth against the terminal-event/result-write race).
        if (attempt < 5) {
          setTimeout(() => void fetchResultAndFinish(attempt + 1), 400);
        } else {
          startPolling();
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiError && e.status === 404
              ? GONE_MESSAGE
              : e instanceof Error
                ? e.message
                : "Failed to load note.",
          );
          setStatus("error");
        }
      }
    }

    function startPolling() {
      if (pollTimer || cancelled) return;
      setTransport("polling");
      const poll = async () => {
        if (finishedRef.current || cancelled) return;
        abort?.abort();
        abort = new AbortController();
        try {
          const job = await getNote(noteId, abort.signal);
          if (cancelled) return;
          // Polling can't stream deltas; show whatever text exists so far.
          const partial = job.result?.note ?? job.note;
          if (typeof partial === "string" && partial) setNote(partial);
          if (job.status === "error") {
            setError(job.error ?? "Note generation failed.");
            setStatus("error");
            if (pollTimer) clearInterval(pollTimer);
            return;
          }
          if (job.status === "done") {
            if (pollTimer) clearInterval(pollTimer);
            finish(job);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            if (pollTimer) clearInterval(pollTimer);
            setError(GONE_MESSAGE);
            setStatus("error");
            return;
          }
          /* transient network blip; retry next tick */
        }
      };
      void poll();
      pollTimer = setInterval(poll, 2000);
    }

    try {
      es = new EventSource(noteEventsUrl(noteId));

      es.addEventListener("start", (ev) => {
        if (cancelled) return;
        setStatus("generating");
        const data = parse((ev as MessageEvent).data);
        if (data?.message) setMessage(data.message);
        else setMessage("Generating…");
      });

      es.addEventListener("generating", (ev) => {
        if (cancelled) return;
        setStatus("generating");
        const data = parse((ev as MessageEvent).data);
        if (typeof data?.delta === "string" && data.delta) {
          setNote((prev) => prev + data.delta);
        }
      });

      es.addEventListener("done", () => {
        if (cancelled) return;
        es?.close();
        void fetchResultAndFinish();
      });

      es.addEventListener("error", (ev) => {
        // A server "error" named event carries data; a transport failure does
        // not → fall back to polling on the latter.
        const data = (ev as MessageEvent).data;
        if (typeof data === "string" && data.length > 0) {
          let msg = "Note generation failed.";
          const parsed = parse(data);
          if (parsed?.message) msg = parsed.message;
          setError(msg);
          setStatus("error");
          es?.close();
        } else if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          startPolling();
        }
      });
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      es?.close();
      abort?.abort();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [noteId]);

  const { body, review } = useMemo(() => splitReviewSection(note), [note]);

  const isError = status === "error" || error !== null;
  const isDone = status === "done";
  const isGenerating = !isError && !isDone;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(note);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([note], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "clinical-note.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack spacing={2.5}>
      <Box>
        <Button
          startIcon={<ArrowBackRoundedIcon />}
          onClick={onBack}
          color="inherit"
          sx={{ color: "text.secondary", mb: 1 }}
        >
          Back
        </Button>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          sx={{
            justifyContent: "space-between",
            alignItems: { xs: "flex-start", md: "center" },
          }}
        >
          <Box>
            <Typography variant="h4" gutterBottom>
              Clinical note
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
              {isGenerating && (
                <Chip
                  icon={<CircularProgress size={14} thickness={6} />}
                  label={transport === "polling" ? "Generating (polling)" : "Generating…"}
                  size="small"
                  color="primary"
                  variant="outlined"
                />
              )}
              {isDone && <Chip label="Complete" size="small" color="success" />}
            </Stack>
          </Box>
          {isDone && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
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
                onClick={handleDownload}
              >
                Download .md
              </Button>
              <Button
                variant="outlined"
                startIcon={<ReplayRoundedIcon />}
                onClick={onReset}
              >
                Start over
              </Button>
            </Stack>
          )}
        </Stack>
      </Box>

      <Alert severity="warning" icon={<WarningAmberRoundedIcon />}>
        Draft for clinician review — not a finalized record. Verify every detail
        against the source before use.
      </Alert>

      {isError ? (
        <Card>
          <CardContent>
            <Alert severity="error" sx={{ mb: 2 }}>
              {error ?? "Note generation failed."}
            </Alert>
            <Button
              variant="contained"
              startIcon={<ReplayRoundedIcon />}
              onClick={onReset}
            >
              Start over
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent>
              {body || isGenerating ? (
                <Box component="pre" sx={NOTE_TEXT_SX}>
                  {body}
                  {isGenerating && (
                    <Box
                      component="span"
                      sx={{
                        display: "inline-block",
                        width: "0.55em",
                        height: "1.05em",
                        ml: 0.25,
                        verticalAlign: "text-bottom",
                        bgcolor: "primary.main",
                        borderRadius: 0.5,
                        animation: "note-blink 1s step-end infinite",
                        "@keyframes note-blink": {
                          "50%": { opacity: 0 },
                        },
                      }}
                    />
                  )}
                </Box>
              ) : (
                <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
                  {message}
                </Typography>
              )}
            </CardContent>
          </Card>

          {review && (
            <Card
              sx={{
                borderColor: "warning.main",
                borderWidth: 2,
                bgcolor: "rgba(255, 167, 38, 0.06)",
              }}
            >
              <CardContent>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", mb: 1 }}
                >
                  <WarningAmberRoundedIcon color="warning" fontSize="small" />
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                    Clinician review needed
                  </Typography>
                </Stack>
                <Divider sx={{ mb: 1.5 }} />
                <Box component="pre" sx={NOTE_TEXT_SX}>
                  {review}
                </Box>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message="Clinical note copied to clipboard"
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Stack>
  );
}

/** Best-effort JSON parse of an SSE data payload. */
function parse(raw: string): NoteSSEPayload | null {
  try {
    return JSON.parse(raw) as NoteSSEPayload;
  } catch {
    return null;
  }
}
