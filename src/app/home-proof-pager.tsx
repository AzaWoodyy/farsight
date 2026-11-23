"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "./i18n/locale-context";

const ATTR = "data-proof";
const PROGRESS = "proof-progress";

export function HomeProofPager({ label, titles }: { label: string; titles: string[] }) {
  const ui = useUi();
  const pager = useRef<HTMLDivElement>(null);
  const advances = useRef(0);
  const [running, setRunning] = useState(true);
  const count = titles.length;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const stack = pager.current?.closest("[data-proofs]");

      if (!stack) return () => {};

      if (!stack.hasAttribute(ATTR)) stack.setAttribute(ATTR, String(Math.floor(Math.random() * count)));
      const observer = new MutationObserver(onChange);

      observer.observe(stack, { attributes: true, attributeFilter: [ATTR] });

      return () => observer.disconnect();
    },
    [count],
  );

  const shown = useSyncExternalStore(
    subscribe,
    () => pager.current?.closest("[data-proofs]")?.getAttribute(ATTR) ?? null,
    () => null,
  );

  const show = (i: number) => pager.current?.closest("[data-proofs]")?.setAttribute(ATTR, String(i));

  return (
    <div
      ref={pager}
      role="group"
      aria-label={label}
      data-stopped={running ? undefined : ""}
      className="proof-pager flex items-center justify-end gap-3"
      onAnimationEnd={(e) => {
        if (e.animationName !== PROGRESS) return;

        show((Number(shown ?? 0) + 1) % count);
        advances.current += 1;

        if (advances.current >= count) setRunning(false);
      }}
    >
      <button
        type="button"
        onClick={() => {
          advances.current = 0;
          setRunning((now) => !now);
        }}
        className="proof-toggle press tap text-xs text-muted hover:text-accent"
      >
        {running ? ui.examples.pause : ui.examples.resume}
      </button>
      <div className="flex items-center">
        {titles.map((title, i) => (
          <button
            key={title}
            type="button"
            data-proof-pick={i}
            aria-label={title}
            aria-pressed={shown === String(i)}
            title={title}
            onClick={() => {
              setRunning(false);
              show(i);
            }}
            className="flex h-11 items-center px-0.5 pointer-coarse:px-2.5 sm:pointer-fine:h-6"
          >
            <span className="block h-1 w-6 overflow-hidden bg-line">
              <span className="proof-progress block h-full bg-accent" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
