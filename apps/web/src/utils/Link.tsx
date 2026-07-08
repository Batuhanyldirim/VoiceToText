import { useCallback } from "react";
import { navigate } from "./router";

// A client-side navigating anchor (ADR-0024). Falls back to normal browser
// navigation on modifier clicks so cmd/ctrl-click opens a new tab as expected.
export function Link({
  to,
  children,
  onClick,
  ...rest
}: {
  to: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const handle = useCallback(
    (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      onClick?.(e);
      navigate(to);
    },
    [to, onClick],
  );
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
