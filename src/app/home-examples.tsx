"use client";

import { useState, useSyncExternalStore } from "react";
import { byCategory, CATEGORIES, EXAMPLES, type Example, readPicks } from "./home-examples-data";

type AskProps = { onAsk: (question: string) => void };

const HEADING = "text-xs text-muted";

function ExampleRow({ example, onAsk, option }: AskProps & { example: Example; option?: number }) {
  return (
    <button
      type="button"
      data-i={option}
      onClick={() => onAsk(example.question)}
      className="press group flex min-h-11 w-full flex-wrap items-baseline gap-x-2 border-b border-dashed border-line py-2.5 text-left sm:pointer-fine:min-h-10"
    >
      <span aria-hidden className="text-accent">
        &gt;
      </span>
      <span className="min-w-0 flex-1 group-hover:text-accent">{example.question}</span>
      <span className="w-full pl-4 text-xs text-muted">
        <span aria-hidden># </span>
        {example.display}
      </span>
    </button>
  );
}

/** Every example, one block per category: two columns from tablet up. */
function AllExamples({ onAsk }: AskProps) {
  return (
    <div className="mt-2 grid gap-x-10 gap-y-6 md:grid-cols-2">
      {CATEGORIES.map((c) => (
        <section key={c} aria-labelledby={`ex-${c}`}>
          <h3 id={`ex-${c}`} className={HEADING}>
            <span aria-hidden>── </span>
            {c}
          </h3>
          <ul className="mt-1 text-sm">
            {byCategory(c).map((e) => (
              <li key={e.question}>
                <ExampleRow example={e} onAsk={onAsk} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const noSubscribe = () => () => {};

// The draw is made before the first paint by PICK_SCRIPT (see home-examples-data). The static page holds
// every example, the undrawn ones hidden by PICK_CSS; once hydrated, only the drawn ones stay in the DOM.
let loadPicks: number[] | null = null;

const drawnPicks = () => (loadPicks ??= readPicks(document.documentElement));

const staticPicks = () => null;

/** One example per category, drawn at random on each load and again on demand; the full list stays one click away. */
export function HomeExamples({ onAsk }: AskProps) {
  const loaded = useSyncExternalStore(noSubscribe, drawnPicks, staticPicks);
  const [drawn, setDrawn] = useState<number[] | null>(null);
  const [draw, setDraw] = useState(0);
  const [all, setAll] = useState(false);
  const picks = drawn ?? loaded;

  function reshuffle() {
    setDrawn(
      CATEGORIES.map((c, i) => {
        const n = byCategory(c).length;
        const shown = picks?.[i] ?? 0;

        // Another example than the one shown, when the category has more than one.
        return n < 2 ? 0 : (shown + 1 + Math.floor(Math.random() * (n - 1))) % n;
      }),
    );
    setDraw((d) => d + 1);
  }

  return (
    <>
      <h2 className={HEADING}>── Essaie par exemple</h2>
      <ul className="mt-2 grid gap-x-10 text-sm md:grid-cols-2">
        {CATEGORIES.map((c, i) => (
          // The entrance plays from the static HTML (CSS only, so on a slow connection too) and again on each
          // new draw; hydration keeps the same <li>, so it does not replay.
          <li key={`${c}-${draw}`} data-c={i} className="ex-in pt-3" style={{ animationDelay: `${i * 40}ms` }}>
            <p className={HEADING}>
              <span aria-hidden>── </span>
              {c}
            </p>
            {/* Keyed by question, so the drawn row keeps its node when the undrawn ones leave. */}
            {(picks ? [byCategory(c)[picks[i]]] : byCategory(c)).map((e, n) => (
              <ExampleRow key={e.question} example={e} option={picks ? undefined : n} onAsk={onAsk} />
            ))}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={reshuffle}
          className="press inline-flex min-h-11 items-center gap-2 border border-line px-3 hover:border-accent hover:text-accent sm:pointer-fine:min-h-9"
        >
          <span aria-hidden className="text-accent">
            ↻
          </span>
          Autres exemples
        </button>
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="press inline-flex min-h-11 items-center border border-dashed border-line px-3 text-muted hover:border-accent hover:text-accent sm:pointer-fine:min-h-9"
        >
          {all ? "Masquer la liste" : `Tous les exemples (${EXAMPLES.length})`}
        </button>
      </div>
      {all && <AllExamples onAsk={onAsk} />}
    </>
  );
}
