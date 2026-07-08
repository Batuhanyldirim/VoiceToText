import { CssBaseline } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import theme from "./theme";
import WorkspaceView from "./components/WorkspaceView";
import PatientListPage from "./components/PatientListPage";
import PatientPage from "./components/PatientPage";
import AppShell from "./components/AppShell";
import { usePath, matchRoute } from "./utils/router";

// App shell + client-side routing (ADR-0024). The capture/note workspace lives at
// "/" (WorkspaceView, which renders its own AppShell so it can drive the sidebar
// highlight/refresh from its state machine). The patient pages are routed here and
// wrapped in a plain AppShell for the shared chrome.
export default function App() {
  const path = usePath();

  let content;
  const patientMatch = matchRoute("/patients/:id", path);
  if (path === "/patients") {
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
    // "/" and anything else → the workspace (it wraps itself in AppShell).
    content = <WorkspaceView />;
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {content}
    </ThemeProvider>
  );
}
