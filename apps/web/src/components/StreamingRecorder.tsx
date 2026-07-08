import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import type { JobOptions, JobResult, NoteSSEPayload } from "../types";
import {
  ApiError,
  cancelStream,
  finishStream,
  getStream,
  openStream,
  sendStreamAudio,
  streamEventsUrl,
} from "../config/api";
import { useElapsed } from "../hooks/useElapsed";
import { formatSeconds } from "../utils/format";

// Live (streaming) transcription (ADR-0014): capture mic PCM via an AudioWorklet,
// downsample to 16 kHz int16, stream frames to the local API while the server
// transcribes silence-cut chunks incrementally. On stop the server flushes the
// tail + runs ONE global diarization pass and returns a normal JobResult, which
// we hand back so the app shows the usual transcript viewer. Audio only ever goes
// to 127.0.0.1 — no cloud speech service.

const TARGET_SR = 16000;

type Phase = "idle" | "recording" | "finalizing";

/** Downsample a Float32 mono buffer from srcRate to 16 kHz (linear interpolation)
 *  and quantize to little-endian int16 — the wire format the API expects. */
function downsampleToInt16(input: Float32Array, srcRate: number): Int16Array {
  if (srcRate === TARGET_SR) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = srcRate / TARGET_SR;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Mikrofon izni reddedildi. Kayıt için tarayıcı ayarlarından mikrofona izin verin.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "Mikrofon bulunamadı. Bir giriş cihazı bağlayıp tekrar deneyin.";
  if (name === "NotReadableError")
    return "Mikrofona erişilemiyor — başka bir uygulama kullanıyor olabilir.";
  return "Mikrofon başlatılamadı. Lütfen izinleri kontrol edip tekrar deneyin.";
}

interface StreamingRecorderProps {
  options: JobOptions;
  /** Called when finalize completes with the finished transcript. `streamId`
   *  lets the caller build download URLs against /stream/{id}. */
  onComplete: (streamId: string, result: JobResult, name: string) => void;
  disabled?: boolean;
}

export default function StreamingRecorder({
  options,
  onComplete,
  disabled = false,
}: StreamingRecorderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  // True once finish() has been signalled, so unmount cleanup knows NOT to cancel
  // a session that's legitimately finalizing/done (only abandon un-finished ones).
  const finishedRef = useRef(false);
  // Serialize PCM uploads so frames arrive in order (the server appends in
  // receive order); a dropped/late frame would reorder audio.
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());

  const elapsed = useElapsed(phase === "recording", startedAtMs);

  const teardownAudio = useCallback(() => {
    try {
      nodeRef.current?.port.close();
    } catch {
      /* already closed */
    }
    nodeRef.current?.disconnect();
    sourceRef.current?.disconnect();
    nodeRef.current = null;
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
    esRef.current?.close();
    esRef.current = null;
  }, []);

  // Open the SSE stream for transcript deltas (falls back to polling on error).
  const openEvents = useCallback((id: string) => {
    let es: EventSource;
    try {
      es = new EventSource(streamEventsUrl(id));
    } catch {
      return;
    }
    esRef.current = es;
    const onText = (ev: MessageEvent) => {
      let data: NoteSSEPayload & { text?: string } = {};
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof data.text === "string") {
        // Full-transcript replay (late joiner / first event).
        setLiveText(data.text);
      } else if (data.delta) {
        setLiveText((prev) => (prev ? prev + " " + data.delta : data.delta!));
      }
    };
    es.addEventListener("transcribe", onText);
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined" ||
      !("audioWorklet" in AudioContext.prototype)
    ) {
      setError("Tarayıcınız canlı deşifreyi (AudioWorklet) desteklemiyor. Dosya yükleyin veya normal kaydı kullanın.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (isMountedRef.current) setError(micErrorMessage(e));
      return;
    }
    if (!isMountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;

    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      if (!isMountedRef.current) {
        teardownAudio();
        return;
      }
      // Open the server session first so we have an id before audio flows.
      const name = `kayit-canli-${Date.now()}`;
      const { stream_id } = await openStream(options, name);
      if (!isMountedRef.current) {
        teardownAudio();
        return;
      }
      streamIdRef.current = stream_id;
      openEvents(stream_id);

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      const srcRate = ctx.sampleRate;
      node.port.onmessage = (ev: MessageEvent) => {
        if (!streamIdRef.current) return;
        const pcm = downsampleToInt16(ev.data as Float32Array, srcRate);
        if (pcm.length === 0) return;
        const id = streamIdRef.current;
        // Chain uploads so frames stay ordered; swallow transient errors.
        sendChainRef.current = sendChainRef.current
          .then(() => sendStreamAudio(id, pcm))
          .catch(() => {});
      };
      source.connect(node);
      // A worklet needs a graph path to pull audio; route through a muted gain to
      // the destination so we don't echo the mic to the speakers.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
      sourceRef.current = source;
      nodeRef.current = node;

      setStartedAtMs(Date.now());
      setLiveText("");
      setPhase("recording");
    } catch (e) {
      teardownAudio();
      streamIdRef.current = null;
      if (isMountedRef.current) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Canlı deşifre başlatılamadı. Sunucu çalışıyor mu?",
        );
      }
    }
  }, [options, openEvents, teardownAudio]);

  const stopRecording = useCallback(async () => {
    const id = streamIdRef.current;
    finishedRef.current = true; // legit finalize — unmount must not cancel it
    setPhase("finalizing");
    // Stop capturing but keep the SSE open to receive the final diarized result.
    nodeRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (!id) {
      teardownAudio();
      setPhase("idle");
      return;
    }
    try {
      // Wait for queued PCM to flush, then signal finish.
      await sendChainRef.current;
      await finishStream(id);
    } catch {
      /* finish will still be attempted server-side if audio arrived */
    }
    // Poll for the finished result (SSE 'done' also fires, but poll is robust).
    const poll = async (attempt = 0): Promise<void> => {
      if (!isMountedRef.current) return;
      try {
        const s = await getStream(id);
        if (s.status === "done" && s.result) {
          teardownAudio();
          onComplete(id, s.result, s.original_name || "kayit");
          return;
        }
        if (s.status === "error") {
          teardownAudio();
          setError(s.error || "Deşifre tamamlanamadı.");
          setPhase("idle");
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          teardownAudio();
          setError("Oturum bulunamadı — sunucu yeniden başlamış olabilir.");
          setPhase("idle");
          return;
        }
      }
      if (attempt < 600) setTimeout(() => void poll(attempt + 1), 1000);
    };
    void poll();
  }, [onComplete, teardownAudio]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // If we're unmounting with a live session that was never finished (user
      // navigated away mid-recording), abandon it server-side so its worker
      // thread + buffered audio are freed (don't cancel a finished/finalizing one).
      const id = streamIdRef.current;
      if (id && !finishedRef.current) void cancelStream(id);
      teardownAudio();
    };
  }, [teardownAudio]);

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)} closeText="Kapat">
          {error}
        </Alert>
      )}

      {phase === "idle" && (
        <Stack spacing={2} sx={{ alignItems: "center", py: { xs: 3, sm: 4 } }}>
          <IconButton
            onClick={() => void startRecording()}
            disabled={disabled}
            aria-label="Canlı deşifreyi başlat"
            sx={{
              width: 96,
              height: 96,
              bgcolor: "primary.main",
              color: "primary.contrastText",
              boxShadow: 3,
              "&:hover": { bgcolor: "primary.dark" },
            }}
          >
            <MicRoundedIcon sx={{ fontSize: 48 }} />
          </IconButton>
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            Canlı deşifre
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", maxWidth: 420 }}>
            Konuşurken deşifre edilir — durdurduğunuzda sonuç çok daha hızlı hazır olur.
          </Typography>
        </Stack>
      )}

      {(phase === "recording" || phase === "finalizing") && (
        <Stack spacing={2}>
          <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: phase === "recording" ? "error.main" : "text.secondary" }}>
              <FiberManualRecordRoundedIcon
                fontSize="small"
                sx={{
                  animation: phase === "recording" ? "vtt-rec-pulse 1.4s ease-in-out infinite" : "none",
                  "@keyframes vtt-rec-pulse": {
                    "0%, 100%": { opacity: 1 },
                    "50%": { opacity: 0.25 },
                  },
                }}
              />
              <Typography variant="body1" sx={{ fontWeight: 700 }}>
                {phase === "recording" ? "Kaydediliyor ve deşifre ediliyor…" : "Sonlandırılıyor (konuşmacı ayrımı)…"}
              </Typography>
            </Stack>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: "primary.main" }}>
              <TimerOutlinedIcon fontSize="small" />
              <Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {formatSeconds(elapsed)}
              </Typography>
            </Box>
          </Stack>

          <Paper
            variant="outlined"
            sx={{
              p: 2,
              minHeight: 160,
              maxHeight: 340,
              overflowY: "auto",
              bgcolor: "background.default",
              whiteSpace: "pre-wrap",
            }}
          >
            <Typography variant="body1" sx={{ lineHeight: 1.7 }}>
              {liveText || (
                <Box component="span" sx={{ color: "text.secondary" }}>
                  Konuşmaya başlayın… deşifre birkaç saniye gecikmeyle burada belirir.
                </Box>
              )}
            </Typography>
          </Paper>

          {phase === "recording" && (
            <Button
              variant="contained"
              color="error"
              size="large"
              startIcon={<StopRoundedIcon />}
              onClick={() => void stopRecording()}
              disabled={disabled}
            >
              Durdur ve tamamla
            </Button>
          )}
        </Stack>
      )}
    </Box>
  );
}
