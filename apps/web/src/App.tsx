import { useCallback, useState } from "react";
import {
  AppBar,
  Box,
  Button,
  Container,
  CssBaseline,
  Toolbar,
  Typography,
} from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import theme from "./theme";
import type { JobOptions, JobResult } from "./types";
import { createJob } from "./config/api";
import UploadScreen from "./components/UploadScreen";
import ProgressScreen from "./components/ProgressScreen";
import TranscriptViewer from "./components/TranscriptViewer";
import NoteGenerator from "./components/NoteGenerator";
import NoteViewer from "./components/NoteViewer";
import NotesHistory from "./components/NotesHistory";

type View =
  | { screen: "upload" }
  | { screen: "progress"; jobId: string }
  | { screen: "result"; jobId: string; result: JobResult }
  | {
      screen: "note-setup";
      jobId: string;
      result: JobResult;
      transcript: string;
    }
  | {
      screen: "note-stream";
      jobId: string;
      result: JobResult;
      transcript: string;
      noteId: string;
    }
  // Saved-note history list.
  | { screen: "history" }
  // Note source-picker for a brand-new note (reuse an existing transcript, or
  // route to the upload flow). Not tied to a transcription job.
  | { screen: "note-source" }
  // Live token stream for a brand-new note started from the source-picker
  // (no originating transcription job).
  | { screen: "note-stream-fresh"; noteId: string }
  // A saved note opened read-only from history.
  | { screen: "note-saved"; noteId: string };

/** Flatten a transcript result into "Speaker: text" lines for note generation. */
function transcriptToText(result: JobResult): string {
  return (result.turns ?? [])
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");
}

export default function App() {
  const [view, setView] = useState<View>({ screen: "upload" });
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (uploaded: File, options: JobOptions) => {
      setSubmitting(true);
      setSubmitError(null);
      setFile(uploaded);
      try {
        const { job_id } = await createJob(uploaded, options);
        setView({ screen: "progress", jobId: job_id });
      } catch (e) {
        setSubmitError(
          e instanceof Error
            ? e.message
            : "Deşifre servisine ulaşılamadı. Çalışıyor mu?",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const handleDone = useCallback((result: JobResult) => {
    setView((v) =>
      v.screen === "progress"
        ? { screen: "result", jobId: v.jobId, result }
        : v,
    );
  }, []);

  const handleReset = useCallback(() => {
    setFile(null);
    setSubmitError(null);
    setView({ screen: "upload" });
  }, []);

  // App bar → saved-notes history.
  const handleOpenHistory = useCallback(() => {
    setView({ screen: "history" });
  }, []);

  // Start a brand-new note from the source picker (reuse an existing transcript
  // or route to upload). Reachable from the app bar and the upload screen.
  const handleNewNote = useCallback(() => {
    setView({ screen: "note-source" });
  }, []);

  // Transcript result → clinical note setup.
  const handleGenerateNote = useCallback(() => {
    setView((v) =>
      v.screen === "result"
        ? {
            screen: "note-setup",
            jobId: v.jobId,
            result: v.result,
            transcript: transcriptToText(v.result),
          }
        : v,
    );
  }, []);

  // Note setup (from a transcription job) → live token stream.
  const handleNoteStarted = useCallback((noteId: string) => {
    setView((v) =>
      v.screen === "note-setup"
        ? {
            screen: "note-stream",
            jobId: v.jobId,
            result: v.result,
            transcript: v.transcript,
            noteId,
          }
        : v,
    );
  }, []);

  // Note source-picker (brand-new note) → live token stream. Here we have no
  // originating transcription job/result, so we render a standalone NoteViewer.
  const handleFreshNoteStarted = useCallback((noteId: string) => {
    setView({ screen: "note-stream-fresh", noteId });
  }, []);

  // Back from note flow → the transcript result screen.
  const handleBackToTranscript = useCallback(() => {
    setView((v) =>
      v.screen === "note-setup" || v.screen === "note-stream"
        ? { screen: "result", jobId: v.jobId, result: v.result }
        : v,
    );
  }, []);

  const handleBackToNoteSetup = useCallback(() => {
    setView((v) =>
      v.screen === "note-stream"
        ? {
            screen: "note-setup",
            jobId: v.jobId,
            result: v.result,
            transcript: v.transcript,
          }
        : v,
    );
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
        <AppBar
          position="sticky"
          color="inherit"
          elevation={0}
          sx={{ borderBottom: "1px solid rgba(26,26,46,0.08)" }}
        >
          <Toolbar>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                cursor: "pointer",
              }}
              onClick={handleReset}
            >
              <Box
                sx={{
                  width: 36,
                  height: 36,
                  borderRadius: 2,
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <GraphicEqRoundedIcon fontSize="small" />
              </Box>
              <Typography
                variant="h6"
                sx={{ fontWeight: 800, letterSpacing: "-0.02em" }}
              >
                VoiceToText
              </Typography>
            </Box>

            <Box sx={{ flexGrow: 1 }} />

            <Button
              color="inherit"
              startIcon={<HomeRoundedIcon />}
              onClick={handleReset}
              sx={{ color: "text.secondary", mr: 0.5 }}
            >
              Ana sayfa
            </Button>
            <Button
              color="inherit"
              startIcon={<DescriptionRoundedIcon />}
              onClick={handleNewNote}
              sx={{ color: "text.secondary", mr: 0.5 }}
            >
              Yeni not
            </Button>
            <Button
              color="inherit"
              startIcon={<HistoryRoundedIcon />}
              onClick={handleOpenHistory}
              sx={{ color: "text.secondary" }}
            >
              Geçmiş
            </Button>
          </Toolbar>
        </AppBar>

        <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
          {view.screen === "upload" && (
            <UploadScreen
              onSubmit={handleSubmit}
              submitting={submitting}
              submitError={submitError}
              onUseExisting={handleNewNote}
            />
          )}
          {view.screen === "progress" && (
            <ProgressScreen
              jobId={view.jobId}
              fileName={file?.name ?? null}
              onDone={handleDone}
              onReset={handleReset}
            />
          )}
          {view.screen === "result" && (
            <TranscriptViewer
              jobId={view.jobId}
              result={view.result}
              file={file}
              onReset={handleReset}
              onGenerateNote={handleGenerateNote}
            />
          )}
          {view.screen === "note-setup" && (
            <NoteGenerator
              transcript={view.transcript}
              onGenerating={handleNoteStarted}
              onBack={handleBackToTranscript}
            />
          )}
          {view.screen === "note-stream" && (
            <NoteViewer
              noteId={view.noteId}
              onBack={handleBackToNoteSetup}
              onReset={handleReset}
            />
          )}

          {view.screen === "history" && (
            <NotesHistory
              onOpen={(id) => setView({ screen: "note-saved", noteId: id })}
              onNew={() => setView({ screen: "note-source" })}
            />
          )}

          {view.screen === "note-source" && (
            // Reuse mode: no transcript prop → NoteGenerator shows the source
            // picker. onNeedTranscript routes to the existing upload flow.
            <NoteGenerator
              onGenerating={handleFreshNoteStarted}
              onBack={handleOpenHistory}
              onNeedTranscript={handleReset}
            />
          )}

          {view.screen === "note-stream-fresh" && (
            <NoteViewer
              noteId={view.noteId}
              onBack={() => setView({ screen: "note-source" })}
              onReset={handleReset}
            />
          )}

          {view.screen === "note-saved" && (
            <NoteViewer
              noteId={view.noteId}
              live={false}
              onBack={handleOpenHistory}
              onReset={handleReset}
            />
          )}
        </Container>
      </Box>
    </ThemeProvider>
  );
}
