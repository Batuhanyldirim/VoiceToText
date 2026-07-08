import { useEffect, useState } from "react";

// Minimal client-side router over the History API (ADR-0024). Real URLs,
// back/forward, deep links — no dependency (the npm registry was unauthenticated
// in this environment; react-router can replace this later). Non-component
// exports live here; the <Link> component is in Link.tsx (keeps fast-refresh
// happy: a module should export only components OR only helpers).

/** Subscribe to the current pathname; re-renders on navigate()/back/forward. */
export function usePath(): string {
  const [path, setPath] = useState<string>(() => window.location.pathname || "/");
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    // navigate() dispatches this custom event so pushes also update subscribers.
    window.addEventListener("vtt:navigate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("vtt:navigate", onPop);
    };
  }, []);
  return path;
}

/** Push a new path (no full reload) and notify subscribers. */
export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState({}, "", to);
  window.dispatchEvent(new Event("vtt:navigate"));
}

/** Match a route pattern like "/patients/:id" against a path. Returns the params
 *  object on match, or null. Only the simple ":param" segment form is supported. */
export function matchRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pp = pattern.split("/").filter(Boolean);
  const cp = path.split("/").filter(Boolean);
  if (pp.length !== cp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = decodeURIComponent(cp[i]);
    } else if (pp[i] !== cp[i]) {
      return null;
    }
  }
  return params;
}
