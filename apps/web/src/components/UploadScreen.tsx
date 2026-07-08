import { useCallback, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Divider,
  FormControlLabel,
  Grid,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import GraphicEqOutlinedIcon from "@mui/icons-material/GraphicEqOutlined";
import type { JobOptions, JobResult, ModelName } from "../types";
import VoiceRecorder from "./VoiceRecorder";
import StreamingRecorder from "./StreamingRecorder";

const ACCEPTED_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".flac",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
];
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface UploadScreenProps {
  onSubmit: (file: File, options: JobOptions) => void;
  submitting: boolean;
  submitError: string | null;
  /** Optional: jump straight to generating a note from an already-transcribed
   *  file in out/ (skips upload + transcription — handy for dev/testing). */
  onUseExisting?: () => void;
  /** Live-transcription finished — hand the finished result up (ADR-0014). */
  onStreamComplete?: (streamId: string, result: JobResult, name: string) => void;
}

type CaptureMode = "upload" | "record" | "stream";

export default function UploadScreen({
  onSubmit,
  submitting,
  submitError,
  onUseExisting,
  onStreamComplete,
}: UploadScreenProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  // Which capture source is showing: drop/pick a file, record from the mic, or
  // live-transcribe while recording. Upload+record share the SAME submit path (a
  // recording becomes a File — ADR-0013); "stream" uses the /stream path (ADR-0014).
  const [mode, setMode] = useState<CaptureMode>("upload");
  const [dragActive, setDragActive] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [showOptions, setShowOptions] = useState(false);
  const [language, setLanguage] = useState("");
  const [diarize, setDiarize] = useState(true);
  const [minSpeakers, setMinSpeakers] = useState("");
  const [maxSpeakers, setMaxSpeakers] = useState("");
  const [model, setModel] = useState<ModelName>("large-v3");

  const acceptFile = useCallback((f: File) => {
    if (!hasAcceptedExtension(f.name)) {
      setFileError(
        `Desteklenmeyen dosya türü. Kabul edilenler: ${ACCEPTED_EXTENSIONS.join(", ")}`,
      );
      return;
    }
    setFileError(null);
    setFile(f);
  }, []);

  // Switch capture source. Clearing the staged file on switch avoids submitting
  // a stale pick after moving to the recorder (and vice-versa).
  const handleModeChange = useCallback(
    (_e: React.MouseEvent<HTMLElement>, next: CaptureMode | null) => {
      if (!next || next === mode) return;
      setFile(null);
      setFileError(null);
      if (inputRef.current) inputRef.current.value = "";
      setMode(next);
    },
    [mode],
  );

  const streamOptions: JobOptions = {
    language: language.trim() || undefined,
    diarize,
    model,
    ...(Number.isNaN(parseInt(minSpeakers, 10)) ? {} : { min_speakers: parseInt(minSpeakers, 10) }),
    ...(Number.isNaN(parseInt(maxSpeakers, 10)) ? {} : { max_speakers: parseInt(maxSpeakers, 10) }),
  };

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const f = e.dataTransfer.files?.[0];
      if (f) acceptFile(f);
    },
    [acceptFile],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) acceptFile(f);
    },
    [acceptFile],
  );

  const handleSubmit = () => {
    if (!file) return;
    const options: JobOptions = {
      language: language.trim() || undefined,
      diarize,
      model,
    };
    const min = parseInt(minSpeakers, 10);
    const max = parseInt(maxSpeakers, 10);
    if (!Number.isNaN(min)) options.min_speakers = min;
    if (!Number.isNaN(max)) options.max_speakers = max;
    onSubmit(file, options);
  };

  return (
    <Stack spacing={3}>
      <Box sx={{ textAlign: "center" }}>
        <Typography variant="h4" gutterBottom>
          Konuşmayı konuşmacı etiketleriyle deşifre edin
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Temiz, konuşmacı ayrımlı bir deşifre için bir ses veya video dosyası
          bırakın.
        </Typography>
      </Box>

      {onUseExisting && (
        <Alert
          severity="info"
          icon={<DescriptionRoundedIcon />}
          action={
            <Button color="inherit" size="small" onClick={onUseExisting}>
              Mevcut deşifreyi kullan
            </Button>
          }
        >
          Zaten deşifre edilmiş bir dosyanız mı var? Yeniden yüklemeden doğrudan
          not oluşturun.
        </Alert>
      )}

      <Card>
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          {/* Capture source toggle: upload a file, or record from the mic. */}
          <ToggleButtonGroup
            value={mode}
            exclusive
            onChange={handleModeChange}
            fullWidth
            size="small"
            sx={{ mb: 2.5 }}
          >
            <ToggleButton value="upload" disabled={submitting}>
              <CloudUploadOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Dosya yükle
            </ToggleButton>
            <ToggleButton value="record" disabled={submitting}>
              <MicRoundedIcon fontSize="small" sx={{ mr: 1 }} />
              Ses kaydet
            </ToggleButton>
            {onStreamComplete && (
              <ToggleButton value="stream" disabled={submitting}>
                <GraphicEqOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
                Canlı deşifre
              </ToggleButton>
            )}
          </ToggleButtonGroup>

          {/* Dropzone (upload mode) */}
          {mode === "upload" && (
            <Box
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              sx={{
                cursor: "pointer",
                borderRadius: 3,
                border: "2px dashed",
                borderColor: dragActive ? "primary.main" : "rgba(26,26,46,0.18)",
                bgcolor: dragActive ? "primary.light" : "background.default",
                transition: "all 0.15s ease",
                px: 3,
                py: { xs: 5, sm: 7 },
                textAlign: "center",
                outline: "none",
                "&:hover": {
                  borderColor: "primary.main",
                  bgcolor: "rgba(91,91,214,0.04)",
                },
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT_ATTR}
                hidden
                onChange={handleFileInput}
              />
              <CloudUploadOutlinedIcon
                sx={{ fontSize: 56, color: "primary.main", mb: 1 }}
              />
              <Typography variant="h6" gutterBottom>
                {dragActive
                  ? "Yüklemek için bırakın"
                  : "Dosyanızı buraya sürükleyip bırakın"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                veya tıklayıp seçin
              </Typography>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ mt: 2, justifyContent: "center", flexWrap: "wrap" }}
              >
                {ACCEPTED_EXTENSIONS.map((ext) => (
                  <Chip
                    key={ext}
                    label={ext.replace(".", "")}
                    size="small"
                    variant="outlined"
                  />
                ))}
              </Stack>
            </Box>
          )}

          {/* Recorder (record mode). It hands a finalized File back via setFile,
              so the shared "Deşifre et" submit works identically to an upload. */}
          {mode === "record" && (
            <VoiceRecorder onRecordingChange={setFile} disabled={submitting} />
          )}

          {/* Live transcription (stream mode). Self-contained: it opens a /stream
              session, streams PCM, and on stop hands the finished result up via
              onStreamComplete — no shared "Deşifre et" submit. */}
          {mode === "stream" && onStreamComplete && (
            <StreamingRecorder options={streamOptions} onComplete={onStreamComplete} />
          )}

          {fileError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {fileError}
            </Alert>
          )}

          {/* Staged-file chip. Only shown for uploads — the recorder shows its
              own captured-clip player + "Tekrar kaydet" while in record mode. */}
          {file && mode === "upload" && (
            <Box
              sx={{
                mt: 2,
                p: 1.5,
                borderRadius: 2,
                bgcolor: "background.default",
                display: "flex",
                alignItems: "center",
                gap: 1.5,
              }}
            >
              <InsertDriveFileOutlinedIcon color="primary" />
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ fontWeight: 600 }}>
                  {file.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatBytes(file.size)}
                </Typography>
              </Box>
              <IconButton
                size="small"
                aria-label="Dosyayı kaldır"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = "";
                }}
              >
                <CloseRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          )}

          {/* Options */}
          <Box sx={{ mt: 2 }}>
            <Button
              startIcon={<TuneRoundedIcon />}
              onClick={() => setShowOptions((s) => !s)}
              color="inherit"
              sx={{ color: "text.secondary" }}
            >
              {showOptions ? "Seçenekleri gizle" : "Seçenekler"}
            </Button>
            <Collapse in={showOptions}>
              <Box sx={{ pt: 2 }}>
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Dil"
                      placeholder="otomatik algıla"
                      helperText="Otomatik algılama için boş bırakın (örn. en, tr)"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      fullWidth
                      size="small"
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      select
                      label="Model"
                      value={model}
                      onChange={(e) => setModel(e.target.value as ModelName)}
                      fullWidth
                      size="small"
                      helperText="small ~4 kat daha hızlı, daha az doğru"
                    >
                      <MenuItem value="large-v3">large-v3 (en iyi)</MenuItem>
                      <MenuItem value="small">small (daha hızlı)</MenuItem>
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 6, sm: 3 }}>
                    <TextField
                      label="En az konuşmacı"
                      type="number"
                      value={minSpeakers}
                      onChange={(e) => setMinSpeakers(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={!diarize}
                      slotProps={{ htmlInput: { min: 1 } }}
                    />
                  </Grid>
                  <Grid size={{ xs: 6, sm: 3 }}>
                    <TextField
                      label="En çok konuşmacı"
                      type="number"
                      value={maxSpeakers}
                      onChange={(e) => setMaxSpeakers(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={!diarize}
                      slotProps={{ htmlInput: { min: 1 } }}
                    />
                  </Grid>
                  <Grid size={12}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={diarize}
                          onChange={(e) => setDiarize(e.target.checked)}
                        />
                      }
                      label="Konuşmacıları ayır (diyarizasyon)"
                    />
                  </Grid>
                </Grid>
              </Box>
            </Collapse>
          </Box>

          {/* The shared submit is for upload/record only — live transcription
              (stream mode) completes itself and needs no "Deşifre et" button. */}
          {mode !== "stream" && (
            <>
              <Divider sx={{ my: 2 }} />

              {submitError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {submitError}
                </Alert>
              )}

              <Button
                variant="contained"
                size="large"
                fullWidth
                disabled={!file || submitting}
                onClick={handleSubmit}
                startIcon={<GraphicEqRoundedIcon />}
              >
                {submitting ? "Başlatılıyor…" : "Deşifre et"}
              </Button>

              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1.5, display: "block", textAlign: "center" }}
              >
                Yerel olarak CPU üzerinde çalışır — dakika başına ~50 sn bekleyin.
              </Typography>
            </>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
