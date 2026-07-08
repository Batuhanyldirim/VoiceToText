import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, IconButton, Stack, Typography } from "@mui/material";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import { useElapsed } from "../hooks/useElapsed";
import { formatSeconds } from "../utils/format";

// Browser mic recording → a File that flows through the SAME upload path as a
// dropped file (ADR-0013). This component only CAPTURES: on stop it wraps the
// recorded Blob into a File and hands it up via onRecordingChange; the parent
// UploadScreen owns the options + the single "Deşifre et" submit. The resulting
// transcription job is indistinguishable downstream from an uploaded one, so the
// sessions sidebar, live timer, refresh-persistence, and retry all work unchanged.
//
// Where does the audio live? In browser memory: MediaRecorder buffers Opus
// chunks (chunksRef) as it records, then on stop they assemble into one Blob
// that's uploaded. Opus is tiny (~32 kbps ≈ ~14 MB/hour), so memory is ample for
// one local user — and it keeps the "reuse the upload path" design (no streaming
// endpoint). `start(TIMESLICE_MS)` flushes chunks periodically so a very long
// recording delivers data incrementally instead of only at the end.

const TIMESLICE_MS = 1000;
const METER_BARS = 7;

/** A recordable container we can name with a server-accepted suffix. Every `ext`
 *  here MUST be in the API's ALLOWED_SUFFIXES (main.py). Ordered by preference —
 *  webm/Opus first (Chromium), mp4 for Safari, ogg as a last resort. */
interface RecordingFormat {
  mimeType: string;
  ext: string;
}

const CANDIDATE_FORMATS: RecordingFormat[] = [
  { mimeType: "audio/webm;codecs=opus", ext: "webm" },
  { mimeType: "audio/webm", ext: "webm" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", ext: "mp4" },
  { mimeType: "audio/mp4", ext: "mp4" },
  { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
  { mimeType: "audio/ogg", ext: "ogg" },
];

/** Map a bare MIME (no codecs) to an allowed extension — used for the fallback
 *  path where we record with the browser default and only learn the type after. */
const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm", // some browsers report video/webm for audio-only capture
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/** First candidate container the browser can actually record, or null if none
 *  (or MediaRecorder itself is missing). */
function pickSupportedFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const f of CANDIDATE_FORMATS) {
    try {
      if (MediaRecorder.isTypeSupported(f.mimeType)) return f;
    } catch {
      /* isTypeSupported can throw on some engines — treat as unsupported */
    }
  }
  return null;
}

function extForMime(mime: string): string | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

/** Compact, filename-safe timestamp (no colons): 20260707-142530. */
function timestampStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Turkish message for a getUserMedia failure, keyed off the DOMException name. */
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

type Phase = "idle" | "recording" | "recorded";

interface VoiceRecorderProps {
  /** Called with the finalized recording (a File named with a server-accepted
   *  suffix) when the user stops, or null when they clear it to re-record. */
  onRecordingChange: (file: File | null) => void;
  /** Disable the controls while the parent is submitting the job. */
  disabled?: boolean;
}

export default function VoiceRecorder({
  onRecordingChange,
  disabled = false,
}: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  // Epoch ms when recording started — anchors the live timer (reused hook).
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  // Per-bar levels (0..1) for the live equalizer indicator, driven by the mic.
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(METER_BARS).fill(0),
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chosenFmtRef = useRef<RecordingFormat | null>(null);
  // Web Audio graph for the level meter (torn down with the tracks).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  // Mirror blobUrl into a ref so the unmount cleanup can revoke the latest one.
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    blobUrlRef.current = blobUrl;
  }, [blobUrl]);
  // Tracks mount state so an async getUserMedia that resolves AFTER unmount
  // (the permission prompt was still open when the user switched mode) can stop
  // the freshly-granted mic stream instead of orphaning a live one. Set in the
  // effect *setup* below so React StrictMode's dev mount/unmount/remount doesn't
  // leave it stuck false.
  const isMountedRef = useRef(true);

  const elapsed = useElapsed(phase === "recording", startedAtMs);

  // Tear down the Web Audio level meter (cancel the rAF loop + close the ctx).
  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => {});
    }
  }, []);

  // Drive the equalizer bars from the live mic signal so the indicator visibly
  // reacts to the user's voice (best-effort — a Web Audio failure is non-fatal).
  const startMeter = useCallback((stream: MediaStream) => {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const step = Math.max(1, Math.floor(bins.length / METER_BARS));
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      const next: number[] = [];
      for (let b = 0; b < METER_BARS; b++) {
        // Average a small slice of frequency bins per bar for a stable height.
        let sum = 0;
        for (let k = 0; k < step; k++) sum += bins[b * step + k] ?? 0;
        next.push(Math.min(1, sum / step / 255));
      }
      setLevels(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopTracks = useCallback(() => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevels(new Array(METER_BARS).fill(0));
  }, [stopMeter]);

  const finalize = useCallback(() => {
    const recorder = recorderRef.current;
    const mime =
      recorder?.mimeType ||
      chosenFmtRef.current?.mimeType ||
      chunksRef.current[0]?.type ||
      "";
    const blob = new Blob(chunksRef.current, mime ? { type: mime } : undefined);
    stopTracks();
    if (blob.size === 0) {
      setError("Kayıt boş görünüyor. Lütfen tekrar deneyin.");
      setPhase("idle");
      return;
    }
    const ext = chosenFmtRef.current?.ext ?? extForMime(blob.type || mime);
    if (!ext) {
      setError("Bu tarayıcının kayıt biçimi desteklenmiyor. Lütfen bir dosya yükleyin.");
      setPhase("idle");
      return;
    }
    const file = new File([blob], `kayit-${timestampStr()}.${ext}`, {
      type: blob.type || mime || undefined,
    });
    const url = URL.createObjectURL(blob);
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    onRecordingChange(file);
    setPhase("recorded");
  }, [onRecordingChange, stopTracks]);

  const startRecording = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Tarayıcınız mikrofon kaydını desteklemiyor.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("Tarayıcınız ses kaydını (MediaRecorder) desteklemiyor.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (isMountedRef.current) setError(micErrorMessage(e));
      return;
    }
    // The permission prompt may have stayed open long enough for the user to
    // switch capture mode (unmounting us). If so, don't touch state/refs — just
    // stop the just-granted stream so the mic doesn't stay live forever.
    if (!isMountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;

    let fmt = pickSupportedFormat();
    let recorder: MediaRecorder;
    try {
      recorder = fmt
        ? new MediaRecorder(stream, { mimeType: fmt.mimeType })
        : new MediaRecorder(stream);
    } catch {
      // The chosen mimeType was rejected at construction — retry with the
      // default and DROP the chosen format, so finalize() names the file from
      // the recorder's actual mimeType rather than the container that failed.
      fmt = null;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        stopTracks();
        setError("Kayıt başlatılamadı — tarayıcı ses kaydını desteklemiyor.");
        return;
      }
    }
    chosenFmtRef.current = fmt;
    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => finalize();
    recorder.onerror = () => {
      stopTracks();
      setError("Kayıt sırasında bir hata oluştu. Lütfen tekrar deneyin.");
      setPhase("idle");
    };
    recorderRef.current = recorder;
    recorder.start(TIMESLICE_MS);
    startMeter(stream);
    setStartedAtMs(Date.now());
    setPhase("recording");
  }, [finalize, startMeter, stopTracks]);

  const stopRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") {
      r.stop(); // fires onstop → finalize()
    } else {
      stopTracks();
      setPhase("idle");
    }
  }, [stopTracks]);

  const reRecord = useCallback(() => {
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    chunksRef.current = [];
    onRecordingChange(null);
    setError(null);
    setPhase("idle");
  }, [onRecordingChange]);

  // Mount/unmount lifecycle. Setting isMountedRef=true here (not just at useRef
  // init) keeps it correct across React StrictMode's dev mount/unmount/remount.
  // On real unmount (switch back to file-upload, or job submitted) release the
  // mic + meter and revoke the blob URL. Null the handlers first so a stop during
  // unmount doesn't run finalize().
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const r = recorderRef.current;
      if (r) {
        r.ondataavailable = null;
        r.onstop = null;
        r.onerror = null;
        if (r.state !== "inactive") {
          try {
            r.stop();
          } catch {
            /* already stopped */
          }
        }
      }
      stopMeter();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, [stopMeter]);

  return (
    <Box>
      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setError(null)}
          closeText="Kapat"
        >
          {error}
        </Alert>
      )}

      {phase === "idle" && (
        <Stack spacing={2} sx={{ alignItems: "center", py: { xs: 3, sm: 4 } }}>
          <IconButton
            onClick={() => void startRecording()}
            disabled={disabled}
            aria-label="Kaydı başlat"
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
            Ses kaydet
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Mikrofonunuzdan kaydetmek için dokunun
          </Typography>
        </Stack>
      )}

      {phase === "recording" && (
        <Stack spacing={2.5} sx={{ alignItems: "center", py: { xs: 3, sm: 4 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", color: "error.main" }}>
            <FiberManualRecordRoundedIcon
              fontSize="small"
              sx={{
                animation: "vtt-rec-pulse 1.4s ease-in-out infinite",
                "@keyframes vtt-rec-pulse": {
                  "0%, 100%": { opacity: 1 },
                  "50%": { opacity: 0.25 },
                },
              }}
            />
            <Typography variant="body1" sx={{ fontWeight: 700 }}>
              Kaydediliyor…
            </Typography>
          </Stack>

          {/* Live equalizer — reacts to the mic so it's obvious we're hearing you. */}
          <Box
            aria-hidden
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 0.75,
              height: 64,
            }}
          >
            {levels.map((lvl, i) => (
              <Box
                key={i}
                sx={{
                  width: 8,
                  borderRadius: 4,
                  bgcolor: "primary.main",
                  // Floor so idle silence still shows a small tick, not nothing.
                  height: `${Math.max(8, lvl * 64)}px`,
                  transition: "height 90ms linear",
                }}
              />
            ))}
          </Box>

          <Typography
            variant="h3"
            sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
          >
            {formatSeconds(elapsed)}
          </Typography>
          <Button
            variant="contained"
            color="error"
            size="large"
            startIcon={<StopRoundedIcon />}
            onClick={stopRecording}
            disabled={disabled}
          >
            Kaydı durdur
          </Button>
        </Stack>
      )}

      {phase === "recorded" && (
        <Stack spacing={2} sx={{ py: 1 }}>
          <Alert severity="success">
            Kayıt hazır. Dinleyip deşifre edebilir veya yeniden kaydedebilirsiniz.
          </Alert>
          {blobUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio src={blobUrl} controls style={{ width: "100%" }} />
          )}
          <Box>
            <Button
              variant="outlined"
              startIcon={<MicRoundedIcon />}
              onClick={reRecord}
              disabled={disabled}
            >
              Tekrar kaydet
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
