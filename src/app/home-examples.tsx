"use client";

import { type FocusEvent, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { byCategory, CATEGORIES, EXAMPLES, type Example, nextPicks, readPicks, ROTATE_MS } from "./home-examples-data";

type AskProps = { onAsk: (question: string) => void };

const HEADING = "text-xs text-muted";

function ExampleRow({ example, onAsk, option, stacked, hidden }: AskProps & { example: Example; option?: number; stacked?: boolean; hidden?: boolean }) {
  return (
    <button
      type="button"
      data-i={option}
      onClick={() => onAsk(example.question)}
      className={`${stacked ? "[grid-area:1/1] " : ""}${hidden ? "invisible " : ""}press group flex min-h-11 w-full flex-wrap content-start items-baseline gap-x-2 border-b border-dashed border-line py-2.5 text-left sm:pointer-fine:min-h-10`}
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

// The draw is made before the first paint by PICK_SCRIPT (see home-examples-data). The static page holds every
// example, the undrawn ones hidden by PICK_CSS; once hydrated, React hides them itself and draws again.
let loadPicks: number[] | null = null;

const drawnPicks = () => (loadPicks ??= readPicks(document.documentElement));

const staticPicks = () => null;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
}

const reducedMotion = () => matchMedia(REDUCED_MOTION).matches;

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);

  return () => document.removeEventListener("visibilitychange", onChange);
}

const pageHidden = () => document.hidden;

// Before hydration nothing rotates.
const serverTrue = () => true;

// Exit: a 150 ms fade, 40 ms later per category (globals.css); the new draw enters once the last one has left.
const STAGGER_MS = 40;
const LEAVE_MS = 150 + (CATEGORIES.length - 1) * STAGGER_MS;

function keyboardFocus(event: FocusEvent) {
  try {
    return event.target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * One example per category, drawn at random on each load, again every ROTATE_MS and on demand; the full list
 * stays one click away. The rotation pauses under the pointer, under keyboard focus, in a hidden tab, and does
 * not run with reduced motion.
 */
export function HomeExamples({ onAsk }: AskProps) {
  const loaded = useSyncExternalStore(noSubscribe, drawnPicks, staticPicks);
  const reduced = useSyncExternalStore(subscribeReducedMotion, reducedMotion, serverTrue);
  const hidden = useSyncExternalStore(subscribeVisibility, pageHidden, serverTrue);
  const [drawn, setDrawn] = useState<number[] | null>(null);
  const [draw, setDraw] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [all, setAll] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoLeave = useRef(false);
  const picks = drawn ?? loaded;

  function reshuffle(automatic = false) {
    if (leave.current) return;

    const swap = () => {
      leave.current = undefined;
      autoLeave.current = false;
      setDrawn((shown) => nextPicks(shown ?? drawnPicks()));
      setDraw((d) => d + 1);
      setLeaving(false);
    };

    if (reduced) return swap();
    setLeaving(true);
    autoLeave.current = automatic;
    leave.current = setTimeout(swap, LEAVE_MS);
  }

  // A pause that starts during an automatic exit keeps the examples shown (and the focus on them).
  function pause(set: (paused: boolean) => void) {
    set(true);

    if (!autoLeave.current) return;
    clearTimeout(leave.current);
    leave.current = undefined;
    autoLeave.current = false;
    setLeaving(false);
  }

  const rotate = useEffectEvent(() => reshuffle(true));
  const paused = !picks || reduced || hidden || hovered || focused;

  // A new countdown after each draw (automatic or asked) and on each resume.
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(rotate, ROTATE_MS);

    return () => clearTimeout(timer);
  }, [paused, draw]);

  useEffect(() => () => clearTimeout(leave.current), []);

  return (
    <div
      onPointerEnter={(e) => e.pointerType === "mouse" && pause(setHovered)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(e) => (keyboardFocus(e) ? pause(setFocused) : setFocused(false))}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
    >
      <h2 className={HEADING}>── Essaie par exemple</h2>
      <ul className="mt-2 grid gap-x-10 text-sm md:grid-cols-2">
        {CATEGORIES.map((c, i) => (
          // The entrance plays from the static HTML (CSS only, so on a slow connection too) and again on each
          // new draw, after the exit of the previous one; hydration keeps the same <li>, so it does not replay.
          <li key={`${c}-${draw}`} className={`${leaving ? "ex-out" : "ex-in"} pt-3`} style={{ animationDelay: `${i * STAGGER_MS}ms` }}>
            <p className={HEADING}>
              <span aria-hidden>── </span>
              {c}
            </p>
            {/* Every example of the category in one grid cell, as tall as the longest: a draw moves nothing. */}
            <div data-c={i} className="grid">
              {byCategory(c).map((e, n) => (
                <ExampleRow key={e.question} example={e} option={picks ? undefined : n} stacked hidden={picks ? n !== picks[i] : undefined} onAsk={onAsk} />
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={() => reshuffle()}
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
    </div>
  );
}
