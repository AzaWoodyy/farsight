"use client";

import { useSyncExternalStore } from "react";
import { THEMES } from "./site";

const noop = () => () => {};

const LABEL = { minimap: "Minimap (rivière)", ambre: "Ambre (terminal)", baron: "Baron (violet)" } as const;

/**
 * Links between the identity directions, shown only on a URL that already
 * carries ?theme= (the review preview), so visitors never see it.
 */
export function ThemeSwitcher() {
  const active = useSyncExternalStore(noop, () => document.documentElement.dataset.theme ?? null, () => null);

  if (!active) return null;

  return (
    <nav aria-label="Direction visuelle" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>Direction :</span>
      {THEMES.map((t) => (
        <a key={t} href={`?theme=${t}`} aria-current={t === active ? "true" : undefined} className={`inline-flex min-h-11 items-center underline-offset-2 sm:min-h-6 ${t === active ? "text-accent" : "underline decoration-line hover:text-accent"}`}>
          {LABEL[t]}
        </a>
      ))}
    </nav>
  );
}
