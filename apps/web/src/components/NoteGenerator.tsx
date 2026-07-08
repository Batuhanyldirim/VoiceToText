import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Grid,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  Typography,
} from "@mui/material";
import DescriptionRoundedIcon from "@mui/icons-material/DescriptionRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import type {
  CreateNoteBody,
  NoteTemplate,
  ProviderInfo,
  TranscriptInfo,
} from "../types";
import {
  createNote,
  getNoteTemplates,
  getProviders,
  getTranscript,
  getTranscripts,
} from "../config/api";
import { languageLabel } from "../utils/format";

// APPROACH (item 3): NoteGenerator focuses on the REUSE picker (option a).
//   - When `transcript` is passed in (the transcription flow: upload → progress
//     → result → "Klinik not oluştur"), the source is already known, so the
//     source selector is skipped and we go straight to the template picker.
//   - When no `transcript` is passed in (reuse mode: History → "Yeni not"), the
//     source selector is shown with two options:
//       (a) "Mevcut bir deşifreyi kullan" → getTranscripts() + a select; picking
//           one calls getTranscript(name) to load .text and sets source_name.
//       (b) "Yeni dosya yükle ve deşifre et" → onNeedTranscript() routes App to
//           the existing upload flow, which then leads back to note generation.
//   This wires BOTH paths to note generation while reusing the existing widgets.

// The synthetic "paste your own format" choice. The server accepts template
// "free" with a `template_text` sample; we surface it as a normal picker row.
const FREE_TEMPLATE: NoteTemplate = {
  key: "free",
  label: "Serbest metin / kendi biçiminizi yapıştırın",
  description:
    "İstediğiniz düzende örnek bir not yapıştırın. Model bu yapıyı taklit eder.",
};

type SourceMode = "reuse" | "upload";

interface NoteGeneratorProps {
  /** Pre-loaded transcript text from the transcription flow. When present, the
   *  source selector is skipped (we already know the source). */
  transcript?: string;
  /** Source name for the pre-loaded transcript (used to build the note title). */
  sourceName?: string;
  /** How long the pre-loaded transcript took to transcribe (fresh-transcription
   *  flow), carried into the note so it can show both timings. */
  transcribeSeconds?: number | null;
  onGenerating: (noteId: string) => void;
  onBack: () => void;
  /** Route back to the upload flow (for the "new file" source option). */
  onNeedTranscript?: () => void;
}

export default function NoteGenerator({
  transcript,
  sourceName,
  transcribeSeconds,
  onGenerating,
  onBack,
  onNeedTranscript,
}: NoteGeneratorProps) {
  // When a transcript is supplied, we are in "preloaded" mode (transcription
  // flow); otherwise we are in "reuse" mode and must pick a source first.
  const preloaded = typeof transcript === "string";

  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Providers (Ollama, and any enabled local plugin like Opus 4.8). The selected
  // provider + model are sent to POST /notes; `off_device` drives the PHI warning.
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>("ollama");
  const [model, setModel] = useState<string>("");

  const [template, setTemplate] = useState<string>("soap");
  const [templateText, setTemplateText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Source-picker state (reuse mode only).
  const [sourceMode, setSourceMode] = useState<SourceMode>("reuse");
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const [transcriptsError, setTranscriptsError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [loadedText, setLoadedText] = useState<string | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [loadedSeconds, setLoadedSeconds] = useState<number | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  // The transcript text + source name + transcription time used for generation.
  const effectiveTranscript = preloaded ? transcript! : loadedText ?? "";
  const effectiveSource = preloaded ? sourceName ?? null : loadedName;
  const effectiveSeconds = preloaded ? transcribeSeconds ?? null : loadedSeconds;

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const [tpl, prov] = await Promise.all([
          getNoteTemplates(abort.signal),
          getProviders(abort.signal),
        ]);
        if (cancelled) return;
        setTemplates(tpl.templates ?? []);
        if (tpl.templates?.length) setTemplate(tpl.templates[0].key);
        setProviders(prov.providers ?? []);
        // Default to the server's default provider (falls back to the first).
        const def =
          prov.providers.find((p) => p.key === prov.default_provider) ??
          prov.providers[0];
        if (def) {
          setProvider(def.key);
          setModel(def.default_model ?? def.models[0]?.id ?? "");
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error
              ? e.message
              : "Not seçenekleri yüklenemedi. Servis çalışıyor mu?",
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

  // The currently-selected provider descriptor + its cloud/off-device flag.
  const activeProvider = useMemo(
    () => providers.find((p) => p.key === provider) ?? null,
    [providers, provider],
  );
  const isCloud = activeProvider?.off_device ?? false;
  // Keep the model valid when the provider changes.
  const handleProviderChange = useCallback(
    (key: string) => {
      setProvider(key);
      const p = providers.find((x) => x.key === key);
      setModel(p?.default_model ?? p?.models[0]?.id ?? "");
    },
    [providers],
  );

  // In reuse mode, load the list of existing transcripts up front.
  useEffect(() => {
    if (preloaded) return;
    const abort = new AbortController();
    let cancelled = false;
    setTranscriptsLoading(true);
    (async () => {
      try {
        const res = await getTranscripts(abort.signal);
        if (cancelled) return;
        setTranscripts(res);
      } catch (e) {
        if (!cancelled) {
          setTranscriptsError(
            e instanceof Error
              ? e.message
              : "Deşifreler yüklenemedi. Servis çalışıyor mu?",
          );
        }
      } finally {
        if (!cancelled) setTranscriptsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [preloaded]);

  const handlePickTranscript = useCallback(async (name: string) => {
    setSelectedName(name);
    setLoadedText(null);
    setLoadedName(null);
    setLoadedSeconds(null);
    if (!name) return;
    setTranscriptLoading(true);
    setTranscriptsError(null);
    try {
      const t = await getTranscript(name);
      setLoadedText(t.text);
      setLoadedName(t.name);
      setLoadedSeconds(t.transcribe_seconds ?? null);
    } catch (e) {
      setTranscriptsError(
        e instanceof Error
          ? e.message
          : "Seçilen deşifre yüklenemedi.",
      );
    } finally {
      setTranscriptLoading(false);
    }
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

  const handleGenerate = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    const label = activeChoice?.label ?? template;
    const title = effectiveSource ? `${effectiveSource} — ${label}` : label;
    const body: CreateNoteBody = {
      transcript: effectiveTranscript,
      template,
      title,
      provider,
    };
    if (model) body.model = model;
    if (effectiveSource) body.source_name = effectiveSource;
    if (typeof effectiveSeconds === "number") body.transcribe_seconds = effectiveSeconds;
    if (isFree) body.template_text = templateText;
    try {
      const { note_id } = await createNote(body);
      onGenerating(note_id);
    } catch (e) {
      setSubmitError(
        e instanceof Error
          ? e.message
          : "Not üretimi başlatılamadı. Servis çalışıyor mu?",
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    effectiveTranscript,
    effectiveSource,
    effectiveSeconds,
    template,
    activeChoice,
    isFree,
    templateText,
    provider,
    model,
    onGenerating,
  ]);

  const hasTranscript = effectiveTranscript.trim().length > 0;
  const generateDisabled =
    loading ||
    submitting ||
    !hasTranscript ||
    (isFree && templateText.trim().length === 0);

  return (
    <Stack spacing={2.5}>
      <Box>
        <Button
          startIcon={<ArrowBackRoundedIcon />}
          onClick={onBack}
          color="inherit"
          sx={{ color: "text.secondary", mb: 1 }}
        >
          Geri
        </Button>
        <Typography variant="h4" gutterBottom>
          Klinik not oluştur
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Bu deşifreyi yapılandırılmış, incelemeye hazır bir klinik nota
          dönüştürün.
        </Typography>
      </Box>

      {/* Source picker — reuse mode only. */}
      {!preloaded && (
        <Card>
          <CardContent sx={{ p: { xs: 2.5, sm: 3 } }}>
            <Typography variant="h6" gutterBottom>
              Kaynak
            </Typography>
            <ToggleButtonGroup
              value={sourceMode}
              exclusive
              onChange={(_e, v) => {
                if (v) setSourceMode(v as SourceMode);
              }}
              size="small"
              sx={{ mb: 2, flexWrap: "wrap" }}
            >
              <ToggleButton value="reuse">
                Mevcut bir deşifreyi kullan
              </ToggleButton>
              <ToggleButton value="upload">
                Yeni dosya yükle ve deşifre et
              </ToggleButton>
            </ToggleButtonGroup>

            {sourceMode === "reuse" ? (
              <>
                {transcriptsError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {transcriptsError}
                  </Alert>
                )}
                <TextField
                  select
                  label="Deşifre seç"
                  value={selectedName}
                  onChange={(e) => void handlePickTranscript(e.target.value)}
                  fullWidth
                  size="small"
                  disabled={transcriptsLoading}
                  helperText={
                    transcriptsLoading
                      ? "Deşifreler yükleniyor…"
                      : transcripts.length === 0
                        ? "Henüz kullanılabilir deşifre yok."
                        : "Bir deşifre seçin."
                  }
                >
                  {transcripts.map((t) => (
                    <MenuItem key={t.name} value={t.name}>
                      {`${t.name} · ${t.turns} konuşma · ${languageLabel(
                        t.language,
                      )}`}
                    </MenuItem>
                  ))}
                </TextField>
                {transcriptLoading && (
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 1.5, alignItems: "center" }}
                  >
                    <CircularProgress size={16} />
                    <Typography variant="body2" color="text.secondary">
                      Deşifre yükleniyor…
                    </Typography>
                  </Stack>
                )}
                {hasTranscript && !transcriptLoading && (
                  <Alert severity="success" sx={{ mt: 1.5 }}>
                    Deşifre yüklendi: {effectiveSource}
                  </Alert>
                )}
              </>
            ) : (
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Yeni bir ses veya video dosyasını yükleyip deşifre edin;
                  ardından deşifre ekranından "Klinik not oluştur" ile buraya
                  dönebilirsiniz.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<CloudUploadOutlinedIcon />}
                  onClick={() => onNeedTranscript?.()}
                  disabled={!onNeedTranscript}
                >
                  Dosya yükle ve deşifre et
                </Button>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      {/* Template picker + generate — only relevant once we have a transcript. */}
      {(preloaded || (sourceMode === "reuse" && hasTranscript)) && (
        <Card>
          <CardContent sx={{ p: { xs: 2.5, sm: 3 } }}>
            {loadError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {loadError}
              </Alert>
            )}

            {isCloud ? (
              <Alert severity="warning" icon={false} sx={{ mb: 2 }}>
                ⚠️ Cihaz dışı sağlayıcı seçili — deşifre metni bu makineden
                ayrılıp modele (Bedrock/Anthropic) gönderilecek. Yalnızca
                yetkilendirilmiş (BAA / kimliksizleştirilmiş / onamlı) veriyle
                kullanın.
              </Alert>
            ) : (
              <Alert
                severity="success"
                icon={<LockRoundedIcon fontSize="inherit" />}
                sx={{ mb: 2 }}
              >
                Not üretimi yerel olarak çalışıyor ({activeProvider?.label ??
                provider}) — deşifre metni bu makinede kalır.
              </Alert>
            )}

            <Grid container spacing={2}>
              {/* Provider selector — hidden when only one provider is offered
                  (committed default → just Ollama, UI unchanged). */}
              {providers.length > 1 && (
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    select
                    label="Sağlayıcı"
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    fullWidth
                    size="small"
                    disabled={loading}
                    helperText={
                      isCloud ? "Cihaz dışı" : "Yerel — makinede kalır"
                    }
                  >
                    {providers.map((p) => (
                      <MenuItem key={p.key} value={p.key}>
                        {p.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
              )}

              {/* Model selector — only when the chosen provider offers >1 model. */}
              {(activeProvider?.models.length ?? 0) > 1 && (
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    select
                    label="Model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    fullWidth
                    size="small"
                    disabled={loading}
                  >
                    {activeProvider?.models.map((m) => (
                      <MenuItem key={m.id} value={m.id}>
                        {m.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
              )}

              <Grid size={{ xs: 12, sm: isFree ? 12 : 6 }}>
                <TextField
                  select
                  label="Not biçimi"
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
                    label="Taklit edilecek örnek biçim"
                    placeholder={
                      "Buraya örnek bir not yapıştırın. Model bu düzeni izler, örn.\n\nBAŞVURU ŞİKAYETİ:\nÖYKÜ:\nDEĞERLENDİRME:\nPLAN:"
                    }
                    value={templateText}
                    onChange={(e) => setTemplateText(e.target.value)}
                    fullWidth
                    multiline
                    minRows={6}
                    size="small"
                    helperText="Serbest metin biçimi için gereklidir."
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
              {submitting ? "Başlatılıyor…" : "Klinik not oluştur"}
            </Button>

            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 1.5, display: "block", textAlign: "center" }}
            >
              Bu not hekim incelemesi için bir taslaktır — kullanmadan önce daima
              doğrulayın.
            </Typography>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
