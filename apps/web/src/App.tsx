import { useCallback, useEffect, useState } from "react";
import {
  AppBar,
  Box,
  CircularProgress,
  Container,
  CssBaseline,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import theme from "./theme";
import type { JobOptions, JobResult } from "./types";
import { createJob, getJob } from "./config/api";
import UploadScreen from "./components/UploadScreen";
import ProgressScreen from "./components/ProgressScreen";
import TranscriptViewer from "./components/TranscriptViewer";
import NoteGenerator from "./components/NoteGenerator";
import NoteViewer from "./components/NoteViewer";
import NotesSidebar, { SIDEBAR_WIDTH } from "./components/NotesSidebar";
import {
  loadSession,
  saveSession,
  type PersistedView,
} from "./utils/session";

type View =
  | { screen: "upload" }
  | { screen: "progress"; jobId: string }
  | { screen: "result"; jobId: string; result: JobResult }
  // A finished LIVE (streaming) transcription. Same viewer as "result", but
  // downloads come from /stream/{id} instead of /jobs/{id} (ADR-0014).
  | { screen: "stream-result"; streamId: string; result: JobResult }
  | {
      screen: "note-setup";
      jobId: string;
      result: JobResult;
      transcript: string;
      // Where the transcript came from — drives download URLs and back-nav.
      source?: "jobs" | "stream";
    }
  | {
      screen: "note-stream";
      jobId: string;
      result: JobResult;
      transcript: string;
      noteId: string;
      source?: "jobs" | "stream";
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

/** Map the rich in-memory View to the minimal serializable pointer we persist.
 *  Views that can't/needn't survive a refresh (the picker holding a File, the
 *  bare upload screen) map to null → cleared. */
function viewToPersisted(view: View, fileName: string | null): PersistedView | null {
  switch (view.screen) {
    case "progress":
      return { screen: "progress", jobId: view.jobId, fileName };
    case "result":
      return { screen: "result", jobId: view.jobId, fileName };
    case "note-stream":
      return {
        screen: "note-stream",
        jobId: view.jobId,
        fileName,
        noteId: view.noteId,
        source: view.source,
      };
    case "note-source":
      return { screen: "note-source" };
    case "note-stream-fresh":
      return { screen: "note-stream-fresh", noteId: view.noteId };
    case "note-saved":
      return { screen: "note-saved", noteId: view.noteId };
    // "upload" and "note-setup" (holds a File / picker state) are not persisted.
    default:
      return null;
  }
}

export default function App() {
  const [view, setView] = useState<View>({ screen: "upload" });
  const [file, setFile] = useState<File | null>(null);
  // The uploaded file's NAME, kept separately so it survives a refresh (the
  // File blob itself can't be persisted, but the name drives the audio-player
  // label / display and is safe to store).
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // True while we rehydrate a persisted session from the backend on first load.
  const [restoring, setRestoring] = useState(true);

  // Persistent left sidebar (ChatGPT-style note history).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Bumped whenever a note is saved/deleted so the sidebar reloads its list.
  const [notesRefresh, setNotesRefresh] = useState(0);
  const bumpNotes = useCallback(() => setNotesRefresh((n) => n + 1), []);

  // The id of whatever is currently open, so the sidebar highlights it —
  // whether that's a saved note, a live note, or an in-progress transcription.
  const activeId =
    view.screen === "note-saved" ||
    view.screen === "note-stream" ||
    view.screen === "note-stream-fresh"
      ? view.noteId
      : view.screen === "progress" || view.screen === "result"
        ? view.jobId
        : null;

  // --- Restore a persisted session on first load (survives page refresh) ----
  useEffect(() => {
    let cancelled = false;
    const saved = loadSession();
    if (!saved) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        switch (saved.screen) {
          case "note-source":
          case "note-stream-fresh":
          case "note-saved":
            // No transcription job to rebuild — restore the pointer directly.
            setView(saved);
            return;
          case "progress":
            // Still-running (or finished) job: re-attach the progress screen; it
            // re-opens the SSE stream and transitions to result on done.
            setFileName(saved.fileName);
            setView({ screen: "progress", jobId: saved.jobId });
            return;
          case "result":
          case "note-stream": {
            // A note started from a live stream has NO /jobs job (getJob would
            // 404) and no server-persisted result; the note itself is reattachable
            // by id (live via SSE, or from saved history), so restore it as a
            // standalone note view instead of re-fetching a transcript.
            if (saved.screen === "note-stream" && saved.source === "stream") {
              setView({ screen: "note-stream-fresh", noteId: saved.noteId });
              return;
            }
            // These need the finished JobResult back — re-fetch it.
            setFileName(saved.fileName);
            const job = await getJob(saved.jobId);
            if (cancelled) return;
            if (job.status === "done" && job.result) {
              if (saved.screen === "result") {
                setView({ screen: "result", jobId: saved.jobId, result: job.result });
              } else {
                setView({
                  screen: "note-stream",
                  jobId: saved.jobId,
                  result: job.result,
                  transcript: transcriptToText(job.result),
                  noteId: saved.noteId,
                });
              }
            } else if (job.status !== "error") {
              // Not done yet — send them back to the progress screen to watch it.
              setView({ screen: "progress", jobId: saved.jobId });
            }
            // job errored / gone → fall through to the default upload screen.
            return;
          }
        }
      } catch {
        /* stale/unknown job — start fresh on the upload screen */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Persist the current screen whenever it changes -----------------------
  useEffect(() => {
    if (restoring) return; // don't clobber the saved session mid-restore
    saveSession(viewToPersisted(view, fileName));
  }, [view, fileName, restoring]);

  const handleSubmit = useCallback(
    async (uploaded: File, options: JobOptions) => {
      setSubmitting(true);
      setSubmitError(null);
      setFile(uploaded);
      setFileName(uploaded.name);
      try {
        const { job_id } = await createJob(uploaded, options);
        setView({ screen: "progress", jobId: job_id });
        bumpNotes(); // show the active transcription in the sidebar immediately
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
    [bumpNotes],
  );

  const handleDone = useCallback((result: JobResult) => {
    setView((v) =>
      v.screen === "progress"
        ? { screen: "result", jobId: v.jobId, result }
        : v,
    );
    bumpNotes(); // transcription finished → drop its active row from the sidebar
  }, [bumpNotes]);

  const handleReset = useCallback(() => {
    setFile(null);
    setFileName(null);
    setSubmitError(null);
    setView({ screen: "upload" });
  }, []);

  // Live transcription finished → show its result in the transcript viewer.
  const handleStreamComplete = useCallback(
    (streamId: string, result: JobResult, name: string) => {
      setFile(null);
      setFileName(name);
      setView({ screen: "stream-result", streamId, result });
      bumpNotes(); // drop its active row from the sidebar
    },
    [bumpNotes],
  );

  // Start a brand-new note from the source picker (reuse an existing transcript
  // or route to upload). Used by the upload screen's "Mevcut deşifreyi kullan".
  const handleNewNote = useCallback(() => {
    setView({ screen: "note-source" });
  }, []);

  // Sidebar "Yeni not" → the main capture screen (upload / record / live +
  // "Mevcut deşifreyi kullan"), not the reuse-only source picker. Clears any
  // in-progress file/error so it's a clean start.
  const handleNewFromSidebar = useCallback(() => {
    setFile(null);
    setFileName(null);
    setSubmitError(null);
    setView({ screen: "upload" });
  }, []);

  // Open a saved note read-only (from the sidebar).
  const handleOpenNote = useCallback((id: string) => {
    setView({ screen: "note-saved", noteId: id });
  }, []);

  // Transcript result → clinical note setup. Works for both a normal job result
  // and a live-transcription (stream) result — the note flow only needs the
  // transcript text + result, not where the transcript came from.
  const handleGenerateNote = useCallback(() => {
    setView((v) => {
      if (v.screen === "result") {
        return {
          screen: "note-setup",
          jobId: v.jobId,
          result: v.result,
          transcript: transcriptToText(v.result),
          source: "jobs",
        };
      }
      if (v.screen === "stream-result") {
        return {
          screen: "note-setup",
          jobId: v.streamId,
          result: v.result,
          transcript: transcriptToText(v.result),
          source: "stream",
        };
      }
      return v;
    });
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
            source: v.source,
          }
        : v,
    );
    bumpNotes(); // surface the in-progress note in the sidebar immediately
  }, [bumpNotes]);

  // Note source-picker (brand-new note) → live token stream. Here we have no
  // originating transcription job/result, so we render a standalone NoteViewer.
  const handleFreshNoteStarted = useCallback((noteId: string) => {
    setView({ screen: "note-stream-fresh", noteId });
    bumpNotes();
  }, [bumpNotes]);

  // Open an in-progress / failed transcription from the sidebar.
  const handleOpenJob = useCallback((jobId: string) => {
    setView({ screen: "progress", jobId });
  }, []);

  // Open an in-progress / failed note from the sidebar (live view).
  const handleOpenActiveNote = useCallback((noteId: string) => {
    setView({ screen: "note-stream-fresh", noteId });
  }, []);

  // Back from note flow → the transcript result screen. Return to the stream
  // result viewer (not the /jobs one) when the transcript came from a live
  // stream, so its downloads keep hitting /stream/{id} (not a 404 /jobs/{id}).
  const handleBackToTranscript = useCallback(() => {
    setView((v) => {
      if (v.screen !== "note-setup" && v.screen !== "note-stream") return v;
      return v.source === "stream"
        ? { screen: "stream-result", streamId: v.jobId, result: v.result }
        : { screen: "result", jobId: v.jobId, result: v.result };
    });
  }, []);

  const handleBackToNoteSetup = useCallback(() => {
    setView((v) =>
      v.screen === "note-stream"
        ? {
            screen: "note-setup",
            jobId: v.jobId,
            result: v.result,
            transcript: v.transcript,
            source: v.source,
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
            activeId={activeId}
            onOpenNote={handleOpenNote}
            onOpenJob={handleOpenJob}
            onOpenActiveNote={handleOpenActiveNote}
            onNewNote={handleNewFromSidebar}
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
            {restoring ? (
              <Stack sx={{ alignItems: "center", py: 10 }} spacing={2}>
                <CircularProgress />
                <Typography color="text.secondary">Oturum geri yükleniyor…</Typography>
              </Stack>
            ) : (
              <>
            {view.screen === "upload" && (
              <UploadScreen
                onSubmit={handleSubmit}
                submitting={submitting}
                submitError={submitError}
                onUseExisting={handleNewNote}
                onStreamComplete={handleStreamComplete}
              />
            )}
            {view.screen === "progress" && (
              <ProgressScreen
                jobId={view.jobId}
                fileName={file?.name ?? fileName}
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
            {view.screen === "stream-result" && (
              <TranscriptViewer
                jobId={view.streamId}
                result={view.result}
                file={null}
                downloadSource="stream"
                onReset={handleReset}
                onGenerateNote={handleGenerateNote}
              />
            )}
            {view.screen === "note-setup" && (
              <NoteGenerator
                transcript={view.transcript}
                sourceName={file?.name ?? undefined}
                transcribeSeconds={view.result.transcribe_seconds ?? null}
                // Persist the structured turns + link the source audio (ADR-0019).
                // jobId is the originating transcription job id, or the streamId
                // for a live-stream result — both resolve to on-disk source audio.
                turns={view.result.turns ?? undefined}
                audioSourceId={view.jobId}
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
              </>
            )}
          </Container>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
