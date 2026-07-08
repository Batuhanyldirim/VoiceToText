// Lightweight client-side session persistence so an in-progress transcription
// or note generation (and the screen you're on) survives a page refresh.
//
// We persist only what's needed to REHYDRATE from the backend, never heavy or
// unserializable data (File objects, full transcript results). On load, App
// reads the saved pointer and re-attaches: ProgressScreen re-opens the job's
// SSE stream, NoteViewer re-opens the note's stream (or reads it from history),
// and a "result" view re-fetches the finished transcript via getJob(jobId).

const KEY = "vtt.session.v1";

/** The minimal, serializable shape of the current screen. Mirrors App's View
 *  union but drops non-persistable fields (File, JobResult) — those are
 *  re-fetched from the backend by jobId/noteId on restore. */
export type PersistedView =
  | { screen: "upload" }
  | { screen: "progress"; jobId: string; fileName: string | null }
  // A finished transcript being viewed. Rehydrate result via getJob(jobId).
  | { screen: "result"; jobId: string; fileName: string | null }
  // Note generation started from a transcription job (result re-fetched). When
  // `source` is "stream" the jobId is a stream id (not a /jobs id), so restore
  // must NOT getJob() it — re-attach the note by noteId alone.
  | {
      screen: "note-stream";
      jobId: string;
      fileName: string | null;
      noteId: string;
      source?: "jobs" | "stream";
    }
  | { screen: "note-source" }
  | { screen: "note-stream-fresh"; noteId: string }
  | { screen: "note-saved"; noteId: string };

export function saveSession(view: PersistedView | null): void {
  try {
    if (!view || view.screen === "upload") {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    /* storage unavailable / quota — non-fatal, just lose persistence */
  }
}

export function loadSession(): PersistedView | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PersistedView;
    if (v && typeof v === "object" && typeof v.screen === "string") return v;
    return null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
