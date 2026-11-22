"use client";

import type { ReactNode } from "react";

export function FullNavigation({ children }: { children: ReactNode }) {
  return (
    <div
      className="contents"
      onClickCapture={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;

        if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.origin !== window.location.origin) return;

        if (link.pathname === window.location.pathname && link.hash) return;

        event.preventDefault();
        event.stopPropagation();
        window.location.assign(link.href);
      }}
    >
      {children}
    </div>
  );
}
