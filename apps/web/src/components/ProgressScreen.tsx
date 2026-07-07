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
import type { JobResult, SSEPayload, Stage } from "../types";
import { getJob, jobEventsUrl } from "../config/api";

// The stages we surface in the stepper (fuse folded into diarize→done flow).
const STEP_STAGES: Stage[] = ["enhance", "transcribe", "align", "diarize", "done"];
const STEP_LABELS: Record<string, string> = {
  enhance: "Enhance",
  transcribe: "Transcribe",
  align: "Align",
  diarize: "Diarize",
  done: "Done",
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
  const [message, setMessage] = useState<string>("Starting…");
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<"sse" | "polling">("sse");

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

    async function fetchResultAndFinish() {
      if (finishedRef.current || cancelled) return;
      try {
        const job = await getJob(jobId);
        if (cancelled) return;
        if (job.status === "error") {
          setError(job.error ?? "The job failed.");
          setStage("error");
          return;
        }
        if (job.status === "done" && job.result) {
          finishedRef.current = true;
          onDoneRef.current(job.result);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load result.");
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
            setError(job.error ?? "The job failed.");
            setStage("error");
            if (pollTimer) clearInterval(pollTimer);
            return;
          }
          if (job.status === "done" && job.result) {
            if (pollTimer) clearInterval(pollTimer);
            finishedRef.current = true;
            onDoneRef.current(job.result);
          }
        } catch {
          /* transient; try again next tick */
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
          let msg = "The job failed.";
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

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2.5, sm: 4 } }}>
        <Typography variant="h5" gutterBottom>
          {isError ? "Something went wrong" : "Transcribing…"}
        </Typography>
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
              {error ?? "The job failed."}
            </Alert>
            <Button
              variant="contained"
              startIcon={<ReplayRoundedIcon />}
              onClick={onReset}
            >
              Start over
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
                {transport === "polling" && " (polling)"}
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
              Runs locally on CPU — expect ~50s per minute of audio.
            </Typography>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
