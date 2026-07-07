import { useCallback, useState } from "react";
import {
  AppBar,
  Box,
  Container,
  CssBaseline,
  Toolbar,
  Typography,
} from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import theme from "./theme";
import type { JobOptions, JobResult } from "./types";
import { createJob } from "./config/api";
import UploadScreen from "./components/UploadScreen";
import ProgressScreen from "./components/ProgressScreen";
import TranscriptViewer from "./components/TranscriptViewer";

type View =
  | { screen: "upload" }
  | { screen: "progress"; jobId: string }
  | { screen: "result"; jobId: string; result: JobResult };

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
            : "Could not reach the transcription service. Is it running?",
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
          </Toolbar>
        </AppBar>

        <Container maxWidth="md" sx={{ py: { xs: 3, sm: 5 } }}>
          {view.screen === "upload" && (
            <UploadScreen
              onSubmit={handleSubmit}
              submitting={submitting}
              submitError={submitError}
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
            />
          )}
        </Container>
      </Box>
    </ThemeProvider>
  );
}
