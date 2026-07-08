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
  // Epoch ms when recording started — anchors the live timer (survives a refresh
  // is moot here since a recording can't outlive the tab, but reuse keeps parity).
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chosenFmtRef = useRef<RecordingFormat | null>(null);
  // Tracks mount state so an async getUserMedia that resolves AFTER unmount
  // (the permission prompt was still open when the user switched mode) can stop
  // the freshly-granted mic stream instead of orphaning a live, un-cleanable one.
  const isMountedRef = useRef(true);
  // Mirror blobUrl into a ref so the unmount cleanup can revoke the latest one.
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    blobUrlRef.current = blobUrl;
  }, [blobUrl]);

  const elapsed = useElapsed(phase === "recording", startedAtMs);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

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
    recorder.start();
    setStartedAtMs(Date.now());
    setPhase("recording");
  }, [finalize, stopTracks]);

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

  // Release the mic + revoke the blob URL if the component unmounts mid-record
  // (e.g. the user switches back to file-upload mode, or the job is submitted).
  // Null the handlers first so a stop during unmount doesn't run finalize().
  useEffect(() => {
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

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
              width: 88,
              height: 88,
              bgcolor: "primary.main",
              color: "primary.contrastText",
              "&:hover": { bgcolor: "primary.dark" },
            }}
          >
            <MicRoundedIcon sx={{ fontSize: 44 }} />
          </IconButton>
          <Typography variant="body2" color="text.secondary">
            Mikrofonunuzdan kaydetmek için dokunun
          </Typography>
          <Button
            variant="contained"
            startIcon={<MicRoundedIcon />}
            onClick={() => void startRecording()}
            disabled={disabled}
          >
            Ses kaydet
          </Button>
        </Stack>
      )}

      {phase === "recording" && (
        <Stack spacing={2} sx={{ alignItems: "center", py: { xs: 3, sm: 4 } }}>
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
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Kaydediliyor…
            </Typography>
          </Stack>
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
