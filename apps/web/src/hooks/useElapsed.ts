import { useEffect, useState } from "react";

/**
 * Live elapsed-seconds counter for a running process.
 *
 * While `running` is true it ticks once per second and freezes when `running`
 * flips to false (the caller then shows the backend's authoritative duration).
 *
 * `startedAtMs` (optional) anchors the count to the process's REAL start time
 * (epoch ms from the server) — so a page refresh mid-run shows the true elapsed
 * time instead of resetting to 0. When omitted, it counts from when `running`
 * first became true (mount-relative).
 */
export function useElapsed(running: boolean, startedAtMs?: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    // Prefer the server-provided real start; fall back to now.
    const anchor =
      typeof startedAtMs === "number" && startedAtMs > 0
        ? startedAtMs
        : Date.now();
    const compute = () => setElapsed(Math.max(0, (Date.now() - anchor) / 1000));
    compute(); // immediate, so a refresh doesn't flash 0 for a second
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [running, startedAtMs]);

  return elapsed;
}
