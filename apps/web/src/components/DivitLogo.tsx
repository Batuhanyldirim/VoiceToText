// The Divit brand mark (ADR: branding). An Ottoman scribe's inkwell + reed pen —
// the ink ripples double as an audio waveform, the reed tip is a record dot. One
// self-contained SVG so it stays crisp at any size and needs no external asset.
interface DivitLogoProps {
  size?: number;
  title?: string;
}

export default function DivitLogo({ size = 36, title = "Divit" }: DivitLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <path
        d="M40 74 h48 a6 6 0 0 1 6 6 l-5 26 a10 10 0 0 1 -10 8 H49 a10 10 0 0 1 -10 -8 l-5 -26 a6 6 0 0 1 6 -6 Z"
        fill="#17414E"
      />
      <ellipse cx="64" cy="79" rx="24" ry="4.5" fill="#2C7C8C" opacity="0.55" />
      <g stroke="#17414E" strokeWidth="6.5" strokeLinecap="round">
        <path d="M50 66 V52" />
        <path d="M64 66 V34" />
        <path d="M78 66 V46" />
      </g>
      <path d="M104 22 L74 60" stroke="#C6963F" strokeWidth="7" strokeLinecap="round" />
      <path d="M104 22 l6 -6 6 8 -8 6 z" fill="#C6963F" />
      <circle cx="74" cy="60" r="6.5" fill="#C6963F" />
    </svg>
  );
}
