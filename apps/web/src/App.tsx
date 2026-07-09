import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import theme from "./theme";
import WorkspaceView from "./components/WorkspaceView";
import HomePage from "./components/HomePage";
import PatientListPage from "./components/PatientListPage";
import PatientPage from "./components/PatientPage";
import TranscriptReviewPage from "./components/TranscriptReviewPage";
import AppShell from "./components/AppShell";
import { usePath, matchRoute } from "./utils/router";

// App shell + client-side routing (ADR-0024/0025).
//   /          → Home / "Bugün" dashboard
//   /yeni      → the capture/note workspace (wraps its own AppShell — it drives
//                the sidebar highlight/refresh from its state machine)
//   /patients, /patients/:id → patient pages (wrapped in a plain AppShell here)
export default function App() {
  const path = usePath();

  let content;
  const patientMatch = matchRoute("/patients/:id", path);
  const reviewMatch = matchRoute("/notes/:id/review", path);
  if (path === "/yeni") {
    content = <WorkspaceView />;
  } else if (reviewMatch) {
    // Raw-transcript review + STT-error correction page (ADR-0029).
    content = (
      <AppShell>
        <TranscriptReviewPage noteId={reviewMatch.id} />
      </AppShell>
    );
  } else if (path === "/patients") {
    content = (
      <AppShell>
        <PatientListPage />
      </AppShell>
    );
  } else if (patientMatch) {
    content = (
      <AppShell>
        <PatientPage patientId={patientMatch.id} />
      </AppShell>
    );
  } else {
    // "/" and anything unknown → Home.
    content = (
      <AppShell>
        <HomePage />
      </AppShell>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {content}
    </ThemeProvider>
  );
}
