import { useCallback, useState } from "react";
import {
  AppBar,
  Box,
  Container,
  CssBaseline,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import theme from "./theme";
import type { JobOptions, JobResult } from "./types";
import { createJob } from "./config/api";
import UploadScreen from "./components/UploadScreen";
import ProgressScreen from "./components/ProgressScreen";
import TranscriptViewer from "./components/TranscriptViewer";
import NoteGenerator from "./components/NoteGenerator";
import NoteViewer from "./components/NoteViewer";
import NotesSidebar, { SIDEBAR_WIDTH } from "./components/NotesSidebar";

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
  // Note source-picker for a brand-new note (reuse an existing transcript, or
  // route to the upload flow). Not tied to a transcription job.
  | { screen: "note-source" }
  // Live token stream for a brand-new note started from the source-picker
  // (no originating transcription job).
  | { screen: "note-stream-fresh"; noteId: string }
  // A saved note opened read-only from the sidebar.
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

  // Persistent left sidebar (ChatGPT-style note history).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Bumped whenever a note is saved/deleted so the sidebar reloads its list.
  const [notesRefresh, setNotesRefresh] = useState(0);
  const bumpNotes = useCallback(() => setNotesRefresh((n) => n + 1), []);

  // The saved note currently shown (for sidebar highlight).
  const activeNoteId = view.screen === "note-saved" ? view.noteId : null;

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

  // Start a brand-new note from the source picker (reuse an existing transcript
  // or route to upload). Reachable from the sidebar and the upload screen.
  const handleNewNote = useCallback(() => {
    setView({ screen: "note-source" });
  }, []);

  // Open a saved note read-only (from the sidebar).
  const handleOpenNote = useCallback((id: string) => {
    setView({ screen: "note-saved", noteId: id });
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
      <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
        {/* Persistent collapsible left sidebar (note history) */}
        <Box
          sx={{
            width: sidebarOpen ? SIDEBAR_WIDTH : 0,
            flexShrink: 0,
            overflow: "hidden",
            transition: "width .2s ease",
            borderRight: sidebarOpen ? "1px solid rgba(26,26,46,0.08)" : "none",
            position: "sticky",
            top: 0,
            height: "100vh",
          }}
        >
          <NotesSidebar
            activeNoteId={activeNoteId}
            onOpenNote={handleOpenNote}
            onNewNote={handleNewNote}
            onCollapse={() => setSidebarOpen(false)}
            refreshToken={notesRefresh}
          />
        </Box>

        {/* Main column */}
        <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <AppBar
            position="sticky"
            color="inherit"
            elevation={0}
            sx={{ borderBottom: "1px solid rgba(26,26,46,0.08)" }}
          >
            <Toolbar>
              {!sidebarOpen && (
                <Tooltip title="Notları göster">
                  <IconButton
                    edge="start"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="Notları göster"
                    sx={{ mr: 1 }}
                  >
                    <MenuRoundedIcon />
                  </IconButton>
                </Tooltip>
              )}
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
            </Toolbar>
          </AppBar>

          <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 }, flexGrow: 1 }}>
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
                sourceName={file?.name ?? undefined}
                transcribeSeconds={view.result.transcribe_seconds ?? null}
                onGenerating={handleNoteStarted}
                onBack={handleBackToTranscript}
              />
            )}
            {view.screen === "note-stream" && (
              <NoteViewer
                noteId={view.noteId}
                onBack={handleBackToNoteSetup}
                onReset={handleReset}
                onSaved={bumpNotes}
              />
            )}

            {view.screen === "note-source" && (
              // Reuse mode: no transcript prop → NoteGenerator shows the source
              // picker. onNeedTranscript routes to the existing upload flow.
              <NoteGenerator
                onGenerating={handleFreshNoteStarted}
                onBack={handleReset}
                onNeedTranscript={handleReset}
              />
            )}

            {view.screen === "note-stream-fresh" && (
              <NoteViewer
                noteId={view.noteId}
                onBack={handleNewNote}
                onReset={handleReset}
                onSaved={bumpNotes}
              />
            )}

            {view.screen === "note-saved" && (
              <NoteViewer
                noteId={view.noteId}
                live={false}
                onBack={handleReset}
                onReset={handleReset}
              />
            )}
          </Container>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
