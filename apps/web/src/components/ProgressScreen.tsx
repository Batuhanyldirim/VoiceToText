import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  LinearProgress,
  Step,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import type { JobResult, SSEPayload, Stage } from "../types";
import { ApiError, getJob, jobEventsUrl } from "../config/api";
import { useElapsed } from "../hooks/useElapsed";
import { formatSeconds } from "../utils/format";

// A vanished job (server restarted mid-run → in-memory registry wiped) surfaces
// as a 404. Treat that as terminal so the client shows a clear error instead of
// polling a nonexistent job forever.
const GONE_MESSAGE =
  "Bu iş artık kullanılamıyor — sunucu yeniden başlamış olabilir. Lütfen dosyayı tekrar yükleyin.";

// The stages we surface in the stepper (fuse folded into diarize→done flow).
const STEP_STAGES: Stage[] = ["enhance", "transcribe", "align", "diarize", "done"];
const STEP_LABELS: Record<string, string> = {
  enhance: "İyileştirme",
  transcribe: "Deşifre",
  align: "Hizalama",
  diarize: "Konuşmacı ayrımı",
  done: "Tamamlandı",
};

// Map any backend stage onto a step index in STEP_STAGES.
function stageToStepIndex(stage: Stage | null): number {
  if (!stage) return 0;
  if (stage === "fuse") return STEP_STAGES.indexOf("diarize");
  if (stage === "error") return -1;
  const idx = STEP_STAGES.indexOf(stage);
  return idx === -1 ? 0 : idx;
}

interface ProgressScreenProps {
  jobId: string;
  fileName: string | null;
  onDone: (result: JobResult) => void;
  onReset: () => void;
}

export default function ProgressScreen({
  jobId,
  fileName,
  onDone,
  onReset,
}: ProgressScreenProps) {
  const [stage, setStage] = useState<Stage | null>("enhance");
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState<string>("Başlatılıyor…");
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<"sse" | "polling">("sse");
  // Real server start (epoch ms) so the timer shows true elapsed after a refresh.
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);

  // Keep the latest onDone in a ref so effect deps stay stable.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finishedRef = useRef(false);

  useEffect(() => {
    finishedRef.current = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let abort: AbortController | null = null;
    let cancelled = false;

    // Learn the job's real start time so the timer is correct across refresh.
    void getJob(jobId)
      .then((j) => {
        if (!cancelled && typeof j.started_at === "number")
          setStartedAtMs(j.started_at * 1000);
      })
      .catch(() => {});

    async function fetchResultAndFinish(attempt = 0) {
      if (finishedRef.current || cancelled) return;
      try {
        const job = await getJob(jobId);
        if (cancelled) return;
        if (job.status === "error") {
          setError(job.error ?? "İş başarısız oldu.");
          setStage("error");
          return;
        }
        if (job.status === "done" && job.result) {
          finishedRef.current = true;
          onDoneRef.current(job.result);
          return;
        }
        // "done" event arrived but the result isn't published yet (or status
        // still "running"). Instead of giving up (which froze the UI on large
        // files), retry a few times, then fall back to polling.
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
                : "Sonuç yüklenemedi.",
          );
          setStage("error");
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
          const job = await getJob(jobId, abort.signal);
          if (cancelled) return;
          setStage(job.stage);
          setPercent(job.percent);
          if (job.status === "error") {
            setError(job.error ?? "İş başarısız oldu.");
            setStage("error");
            if (pollTimer) clearInterval(pollTimer);
            return;
          }
          if (job.status === "done" && job.result) {
            if (pollTimer) clearInterval(pollTimer);
            finishedRef.current = true;
            onDoneRef.current(job.result);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            // Job gone (server restarted) — terminal, don't keep polling.
            if (pollTimer) clearInterval(pollTimer);
            setError(GONE_MESSAGE);
            setStage("error");
            return;
          }
          /* transient network blip; try again next tick */
        }
      };
      void poll();
      pollTimer = setInterval(poll, 2000);
    }

    function handlePayload(stageName: Stage, raw: string) {
      if (cancelled) return;
      let data: SSEPayload | null = null;
      try {
        data = JSON.parse(raw) as SSEPayload;
      } catch {
        data = null;
      }
      const effectiveStage = data?.stage ?? stageName;
      setStage(effectiveStage);
      if (typeof data?.percent === "number") setPercent(data.percent);
      if (data?.message) setMessage(data.message);
    }

    try {
      es = new EventSource(jobEventsUrl(jobId));

      const namedStages: Stage[] = [
        "enhance",
        "transcribe",
        "align",
        "diarize",
        "fuse",
      ];
      for (const s of namedStages) {
        es.addEventListener(s, (ev) =>
          handlePayload(s, (ev as MessageEvent).data),
        );
      }
      es.addEventListener("done", () => {
        setStage("done");
        setPercent(100);
        es?.close();
        void fetchResultAndFinish();
      });
      es.addEventListener("error", (ev) => {
        // Distinguish a *server* "error" named event (has data) from a
        // transport failure (no data) → fall back to polling on the latter.
        const data = (ev as MessageEvent).data;
        if (typeof data === "string" && data.length > 0) {
          let msg = "İş başarısız oldu.";
          try {
            const parsed = JSON.parse(data) as SSEPayload;
            msg = parsed.message ?? msg;
          } catch {
            /* keep default */
          }
          setError(msg);
          setStage("error");
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
  }, [jobId]);

  const activeStep = useMemo(() => stageToStepIndex(stage), [stage]);
  const isError = stage === "error" || error !== null;
  const showDeterminate = stage === "transcribe" && typeof percent === "number";
  // Live elapsed time while transcription runs, anchored to the real server
  // start so a refresh shows true elapsed (freezes on error; the flow navigates
  // away on success, so there's no lingering "done" state here).
  const elapsed = useElapsed(!isError, startedAtMs);

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 2,
          }}
        >
          <Typography variant="h5" gutterBottom>
            {isError ? "Bir sorun oluştu" : "Deşifre ediliyor…"}
          </Typography>
          {!isError && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                color: "primary.main",
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}
            >
              <TimerOutlinedIcon fontSize="small" />
              <Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {formatSeconds(elapsed)}
              </Typography>
            </Box>
          )}
        </Box>
        {fileName && (
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {fileName}
          </Typography>
        )}

        <Box sx={{ my: 4 }}>
          <Stepper
            activeStep={isError ? activeStep : activeStep}
            alternativeLabel
          >
            {STEP_STAGES.map((s, i) => (
              <Step key={s} completed={!isError && activeStep > i}>
                <StepLabel error={isError && i === activeStep}>
                  {STEP_LABELS[s]}
                </StepLabel>
              </Step>
            ))}
          </Stepper>
        </Box>

        {isError ? (
          <>
            <Alert severity="error" sx={{ mb: 3 }}>
              {error ?? "İş başarısız oldu."}
            </Alert>
            <Button
              variant="contained"
              startIcon={<ReplayRoundedIcon />}
              onClick={onReset}
            >
              Baştan başla
            </Button>
          </>
        ) : (
          <Box>
            <LinearProgress
              variant={showDeterminate ? "determinate" : "indeterminate"}
              value={showDeterminate ? (percent as number) : undefined}
              sx={{ height: 10, borderRadius: 5 }}
            />
            <Box
              sx={{
                mt: 1.5,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {message}
                {transport === "polling" && " (yoklama)"}
              </Typography>
              {showDeterminate && (
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {Math.round(percent as number)}%
                </Typography>
              )}
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 2, display: "block" }}
            >
              Yerel olarak CPU üzerinde çalışır — dakika başına ~50 sn bekleyin.
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
