import { useCallback, useEffect, useState } from "react";
import { CircularProgress, Container, Stack, Typography } from "@mui/material";
import type { JobOptions, JobResult } from "../types";
import { createJob, getJob } from "../config/api";
import UploadScreen from "./UploadScreen";
import ProgressScreen from "./ProgressScreen";
import TranscriptViewer from "./TranscriptViewer";
import NoteGenerator from "./NoteGenerator";
import NoteViewer from "./NoteViewer";
import AppShell from "./AppShell";
import { loadSession, saveSession, type PersistedView } from "../utils/session";

// The capture → transcript → note workspace, mounted at "/" (ADR-0024). This is
// the original App body, unchanged behavior (its view state machine, SSE
// sessions, refresh-safe persistence, retry) — now rendered inside AppShell, and
// reading a URL query (?note=/?job=/?activeNote=/?new=) so the shared sidebar (on
// any route) can open a note/job here by navigating to "/".

type View =
  | { screen: "upload" }
  | { screen: "progress"; jobId: string }
  | { screen: "result"; jobId: string; result: JobResult }
  | { screen: "stream-result"; streamId: string; result: JobResult }
  | { screen: "note-setup"; jobId: string; result: JobResult; transcript: string; source?: "jobs" | "stream" }
  | { screen: "note-stream"; jobId: string; result: JobResult; transcript: string; noteId: string; source?: "jobs" | "stream" }
  | { screen: "note-source" }
  | { screen: "note-stream-fresh"; noteId: string }
  | { screen: "note-saved"; noteId: string };

function transcriptToText(result: JobResult): string {
  return (result.turns ?? []).map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

function viewToPersisted(view: View, fileName: string | null): PersistedView | null {
  switch (view.screen) {
    case "progress":
      return { screen: "progress", jobId: view.jobId, fileName };
    case "result":
      return { screen: "result", jobId: view.jobId, fileName };
    case "note-stream":
      return { screen: "note-stream", jobId: view.jobId, fileName, noteId: view.noteId, source: view.source };
    case "note-source":
      return { screen: "note-source" };
    case "note-stream-fresh":
      return { screen: "note-stream-fresh", noteId: view.noteId };
    case "note-saved":
      return { screen: "note-saved", noteId: view.noteId };
    default:
      return null;
  }
}

/** Read a one-shot open-intent from the URL query (set by the shared sidebar when
 *  it navigates here from another route), then strip it so a refresh is clean. */
function consumeOpenIntent(): View | null {
  const q = new URLSearchParams(window.location.search);
  const clear = () => window.history.replaceState({}, "", "/yeni");
  if (q.get("new") === "1") {
    clear();
    return { screen: "upload" };
  }
  const note = q.get("note");
  if (note) {
    clear();
    return { screen: "note-saved", noteId: note };
  }
  const activeNote = q.get("activeNote");
  if (activeNote) {
    clear();
    return { screen: "note-stream-fresh", noteId: activeNote };
  }
  const job = q.get("job");
  if (job) {
    clear();
    return { screen: "progress", jobId: job };
  }
  return null;
}

export default function WorkspaceView() {
  const [view, setView] = useState<View>({ screen: "upload" });
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [notesRefresh, setNotesRefresh] = useState(0);
  const bumpNotes = useCallback(() => setNotesRefresh((n) => n + 1), []);

  const activeId =
    view.screen === "note-saved" || view.screen === "note-stream" || view.screen === "note-stream-fresh"
      ? view.noteId
      : view.screen === "progress" || view.screen === "result"
        ? view.jobId
        : null;

  // --- Restore session on first load; a URL open-intent takes precedence. ----
  useEffect(() => {
    let cancelled = false;
    const intent = consumeOpenIntent();
    if (intent) {
      setView(intent);
      setRestoring(false);
      return;
    }
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
            setView(saved);
            return;
          case "progress":
            setFileName(saved.fileName);
            setView({ screen: "progress", jobId: saved.jobId });
            return;
          case "result":
          case "note-stream": {
            if (saved.screen === "note-stream" && saved.source === "stream") {
              setView({ screen: "note-stream-fresh", noteId: saved.noteId });
              return;
            }
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
              setView({ screen: "progress", jobId: saved.jobId });
            }
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

  useEffect(() => {
    if (restoring) return;
    saveSession(viewToPersisted(view, fileName));
  }, [view, fileName, restoring]);

  // While already mounted at "/", react to a sidebar open-intent (the sidebar
  // sets ?note=/?job=/… and navigates; on same-route navigation the component
  // doesn't remount, so we listen for the navigate event and consume the intent).
  useEffect(() => {
    const onNav = () => {
      if (window.location.pathname !== "/yeni") return;
      const intent = consumeOpenIntent();
      if (intent) setView(intent);
    };
    window.addEventListener("vtt:navigate", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("vtt:navigate", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);

  const handleSubmit = useCallback(
    async (uploaded: File, options: JobOptions) => {
      setSubmitting(true);
      setSubmitError(null);
      setFile(uploaded);
      setFileName(uploaded.name);
      try {
        const { job_id } = await createJob(uploaded, options);
        setView({ screen: "progress", jobId: job_id });
        bumpNotes();
      } catch (e) {
        setSubmitError(
          e instanceof Error ? e.message : "Deşifre servisine ulaşılamadı. Çalışıyor mu?",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [bumpNotes],
  );

  const handleDone = useCallback((result: JobResult) => {
    setView((v) => (v.screen === "progress" ? { screen: "result", jobId: v.jobId, result } : v));
    bumpNotes();
  }, [bumpNotes]);

  const handleReset = useCallback(() => {
    setFile(null);
    setFileName(null);
    setSubmitError(null);
    setView({ screen: "upload" });
  }, []);

  const handleStreamComplete = useCallback(
    (streamId: string, result: JobResult, name: string) => {
      setFile(null);
      setFileName(name);
      setView({ screen: "stream-result", streamId, result });
      bumpNotes();
    },
    [bumpNotes],
  );

  const handleNewNote = useCallback(() => setView({ screen: "note-source" }), []);

  const handleGenerateNote = useCallback(() => {
    setView((v) => {
      if (v.screen === "result") {
        return { screen: "note-setup", jobId: v.jobId, result: v.result, transcript: transcriptToText(v.result), source: "jobs" };
      }
      if (v.screen === "stream-result") {
        return { screen: "note-setup", jobId: v.streamId, result: v.result, transcript: transcriptToText(v.result), source: "stream" };
      }
      return v;
    });
  }, []);

  const handleNoteStarted = useCallback((noteId: string) => {
    setView((v) =>
      v.screen === "note-setup"
        ? { screen: "note-stream", jobId: v.jobId, result: v.result, transcript: v.transcript, noteId, source: v.source }
        : v,
    );
    bumpNotes();
  }, [bumpNotes]);

  const handleFreshNoteStarted = useCallback((noteId: string) => {
    setView({ screen: "note-stream-fresh", noteId });
    bumpNotes();
  }, [bumpNotes]);

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
        ? { screen: "note-setup", jobId: v.jobId, result: v.result, transcript: v.transcript, source: v.source }
        : v,
    );
  }, []);

  return (
    <AppShell activeId={activeId} refreshToken={notesRefresh}>
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
              <NoteViewer noteId={view.noteId} live={false} onBack={handleReset} onReset={handleReset} />
            )}
          </>
        )}
      </Container>
    </AppShell>
  );
}
