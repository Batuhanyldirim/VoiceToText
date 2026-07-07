import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import type { CreateNoteBody, NoteTemplate } from "../types";
import { createNote, getNoteTemplates } from "../config/api";

// The synthetic "paste your own format" choice. The server accepts template
// "free" with a `template_text` sample; we surface it as a normal picker row.
const FREE_TEMPLATE: NoteTemplate = {
  key: "free",
  label: "Free-text / paste your own format",
  description:
    "Paste an example note in the layout you want. The model mirrors that structure.",
};

interface NoteGeneratorProps {
  transcript: string;
  onGenerating: (noteId: string) => void;
  onBack: () => void;
}

export default function NoteGenerator({
  transcript,
  onGenerating,
  onBack,
}: NoteGeneratorProps) {
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [provider, setProvider] = useState<string>("ollama");
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [template, setTemplate] = useState<string>("soap");
  const [templateText, setTemplateText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const res = await getNoteTemplates(abort.signal);
        if (cancelled) return;
        setTemplates(res.templates ?? []);
        setProvider(res.provider);
        setCloudEnabled(res.cloud_enabled);
        if (res.templates?.length) setTemplate(res.templates[0].key);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error
              ? e.message
              : "Could not load note templates. Is the service running?",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, []);

  // The picker lists the fetched templates plus the free-paste option. The API
  // already appends a "free" entry, so dedupe by key to avoid a duplicate row
  // (and duplicate React keys) if it does; fall back to FREE_TEMPLATE otherwise.
  const choices = useMemo<NoteTemplate[]>(() => {
    const byKey = new Map<string, NoteTemplate>();
    for (const t of [...templates, FREE_TEMPLATE]) {
      if (!byKey.has(t.key)) byKey.set(t.key, t);
    }
    return [...byKey.values()];
  }, [templates]);

  const activeChoice = useMemo(
    () => choices.find((c) => c.key === template) ?? null,
    [choices, template],
  );

  const isFree = template === "free";
  const isCloud = cloudEnabled || provider === "claude";

  const handleGenerate = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    const body: CreateNoteBody = { transcript, template };
    if (isFree) body.template_text = templateText;
    try {
      const { note_id } = await createNote(body);
      onGenerating(note_id);
    } catch (e) {
      setSubmitError(
        e instanceof Error
          ? e.message
          : "Could not start note generation. Is the service running?",
      );
    } finally {
      setSubmitting(false);
    }
  }, [transcript, template, isFree, templateText, onGenerating]);

  const generateDisabled =
    loading || submitting || (isFree && templateText.trim().length === 0);

  return (
    <Stack spacing={2.5}>
      <Box>
        <Button
          startIcon={<ArrowBackRoundedIcon />}
          onClick={onBack}
          color="inherit"
          sx={{ color: "text.secondary", mb: 1 }}
        >
          Back to transcript
        </Button>
        <Typography variant="h4" gutterBottom>
          Generate a clinical note
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Turn this transcript into a structured, review-ready clinical note.
        </Typography>
      </Box>

      <Card>
        <CardContent sx={{ p: { xs: 2.5, sm: 3 } }}>
          {loadError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {loadError}
            </Alert>
          )}

          {isCloud ? (
            <Alert severity="warning" icon={false} sx={{ mb: 2 }}>
              ⚠️ Cloud provider enabled — the transcript will be sent to
              Anthropic. Only use with authorization (BAA / de-identified /
              consented data).
            </Alert>
          ) : (
            <Alert
              severity="success"
              icon={<LockRoundedIcon fontSize="inherit" />}
              sx={{ mb: 2 }}
            >
              Generation runs locally ({provider}) — the transcript stays on
              this machine.
            </Alert>
          )}

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: isFree ? 12 : 6 }}>
              <TextField
                select
                label="Note format"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                fullWidth
                size="small"
                disabled={loading}
                helperText={activeChoice?.description ?? " "}
              >
                {choices.map((c) => (
                  <MenuItem key={c.key} value={c.key}>
                    {c.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>

            {isFree && (
              <Grid size={12}>
                <TextField
                  label="Sample format to mirror"
                  placeholder={
                    "Paste an example note here. The model will follow this layout, e.g.\n\nCHIEF COMPLAINT:\nHISTORY:\nASSESSMENT:\nPLAN:"
                  }
                  value={templateText}
                  onChange={(e) => setTemplateText(e.target.value)}
                  fullWidth
                  multiline
                  minRows={6}
                  size="small"
                  helperText="Required for the free-text format."
                />
              </Grid>
            )}
          </Grid>

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
            disabled={generateDisabled}
            onClick={handleGenerate}
            startIcon={
              submitting ? (
                <AutoAwesomeRoundedIcon />
              ) : (
                <DescriptionRoundedIcon />
              )
            }
          >
            {submitting ? "Starting…" : "Generate clinical note"}
          </Button>

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 1.5, display: "block", textAlign: "center" }}
          >
            The note is a draft for clinician review — always verify before use.
          </Typography>
        </CardContent>
      </Card>
    </Stack>
  );
}
