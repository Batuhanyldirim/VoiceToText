// Small pure helpers for formatting and speaker color mapping.

/** Format a number of seconds as mm:ss (or hh:mm:ss when >= 1 hour). */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Human-friendly duration in Turkish: "42 sn" under a minute, "2 dk 18 sn"
 *  above. Shared by the live process timers and the saved-note timing chips. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.round(seconds);
  if (total < 60) return `${total} sn`;
  const m = Math.floor(total / 60);
  const rem = total % 60;
  return rem ? `${m} dk ${rem} sn` : `${m} dk`;
}

// A distinct, pleasant palette. Speakers map into this deterministically so a
// given speaker string always gets the same color across renders.
const SPEAKER_PALETTE = [
  { main: "#5b5bd6", bg: "#ecebfb" }, // indigo
  { main: "#0ea5a4", bg: "#e2f6f5" }, // teal
  { main: "#e8590c", bg: "#fdece2" }, // orange
  { main: "#c2255c", bg: "#fce4ee" }, // pink
  { main: "#2f9e44", bg: "#e6f5ea" }, // green
  { main: "#7048e8", bg: "#efeafd" }, // violet
  { main: "#1971c2", bg: "#e3f0fb" }, // blue
  { main: "#e67700", bg: "#fdf1de" }, // amber
  { main: "#0c8599", bg: "#e0f3f6" }, // cyan
  { main: "#9c36b5", bg: "#f6e8fa" }, // grape
];

export interface SpeakerColor {
  main: string;
  bg: string;
}

/**
 * Derive a stable color from a speaker label. If the label ends in a number
 * (e.g. "Speaker 1"), that index drives the palette so the ordering is
 * predictable; otherwise we hash the whole string.
 */
export function speakerColor(speaker: string): SpeakerColor {
  const numMatch = speaker.match(/(\d+)\s*$/);
  let index: number;
  if (numMatch) {
    index = (parseInt(numMatch[1], 10) - 1) % SPEAKER_PALETTE.length;
    if (index < 0) index += SPEAKER_PALETTE.length;
  } else {
    let hash = 0;
    for (let i = 0; i < speaker.length; i++) {
      hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
    }
    index = hash % SPEAKER_PALETTE.length;
  }
  return SPEAKER_PALETTE[index];
}

/** Human-friendly language label from an ISO-ish code. Falls back to the raw value. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return "Unknown";
  const map: Record<string, string> = {
    en: "English",
    tr: "Turkish",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    nl: "Dutch",
    ru: "Russian",
    ja: "Japanese",
    zh: "Chinese",
    ko: "Korean",
    ar: "Arabic",
    hi: "Hindi",
  };
  const key = code.toLowerCase();
  return map[key] ?? code.toUpperCase();
}

/** File extensions we treat as audio (safe to wire click-to-seek playback). */
const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "flac", "ogg", "aac"];

export function isAudioFile(file: File | null): boolean {
  if (!file) return false;
  if (file.type.startsWith("audio/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? AUDIO_EXTENSIONS.includes(ext) : false;
}
