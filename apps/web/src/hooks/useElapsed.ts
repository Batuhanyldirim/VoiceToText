import { useEffect, useRef, useState } from "react";

/**
 * Live elapsed-seconds counter for a running process.
 *
 * While `running` is true it ticks once per second from a monotonic start
 * captured on the running→true transition (so it survives re-renders without
 * drifting). When `running` flips to false it FREEZES at the last value — the
 * caller then shows the backend's authoritative duration instead. Resets to 0
 * when `running` goes true again.
 */
export function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      startRef.current = null;
      return;
    }
    startRef.current = performance.now();
    setElapsed(0);
    const tick = () => {
      if (startRef.current != null) {
        setElapsed((performance.now() - startRef.current) / 1000);
      }
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  return elapsed;
}
