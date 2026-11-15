"use client";

import { useState, useSyncExternalStore } from "react";

/**
 * Home examples, grouped by what the question is about. Each one is answered by a typed tool without the
 * LLM (checked with `bun run ask`); `display` names the layout the question opens.
 */
const CATEGORIES = ["joueurs", "équipes", "champions", "parties"] as const;

type Category = (typeof CATEGORIES)[number];

type Example = { question: string; display: string; category: Category };

const EXAMPLES: Example[] = [
  { category: "joueurs", question: "Résultats de Chovy à tous les Worlds", display: "palmarès" },
  { category: "joueurs", question: "Faker contre Chovy", display: "duel de joueurs" },
  { category: "joueurs", question: "Champion pool de Faker", display: "champion pool" },
  { category: "joueurs", question: "Meilleurs mids aux Worlds 2026", display: "classement de joueurs" },
  { category: "équipes", question: "KC contre MKOI", display: "confrontation d'équipes" },
  { category: "équipes", question: "Samsung White roster 2014", display: "roster" },
  { category: "équipes", question: "ADC de T1", display: "joueur d'un poste" },
  { category: "équipes", question: "Champion pool de T1 aux Worlds 2025", display: "champion pool d'équipe" },
  { category: "champions", question: "Stats d'Azir aux Worlds 2025", display: "fiche champion" },
  { category: "champions", question: "Champions les plus bannis en LCK 2025", display: "classement de champions" },
  { category: "champions", question: "Champions les plus joués aux Worlds 2024", display: "méta d'un tournoi" },
  { category: "parties", question: "Finale des Worlds 2025", display: "série en BO, game par game" },
  { category: "parties", question: "Récap de la game 5 de la finale des Worlds 2024", display: "récap de partie" },
  { category: "parties", question: "Classement des Worlds 2023", display: "classement de tournoi" },
];

const byCategory = (c: Category) => EXAMPLES.filter((e) => e.category === c);

type AskProps = { onAsk: (question: string) => void };

const HEADING = "text-xs text-muted";

function ExampleRow({ example, onAsk }: AskProps & { example: Example }) {
  return (
    <button
      type="button"
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

// The static page ships the first example of each category, readable while the scripts load. On hydration
// they are replaced by one random example per category (a refresh draws again), unless the page took long
// enough to hydrate that the visitor may already be reading them, or about to tap one.
const FIRST = CATEGORIES.map(() => 0);

const SWAP_BEFORE_MS = 1500;

let loadPicks: number[] | null = null;

const randomPicks = () =>
  (loadPicks ??=
    performance.now() < SWAP_BEFORE_MS ? CATEGORIES.map((c) => Math.floor(Math.random() * byCategory(c).length)) : FIRST);

const staticPicks = () => FIRST;

/** One example per category, drawn at random on each load and again on demand; the full list stays one click away. */
export function HomeExamples({ onAsk }: AskProps) {
  const loaded = useSyncExternalStore(noSubscribe, randomPicks, staticPicks);
  const [drawn, setDrawn] = useState<number[] | null>(null);
  const [draw, setDraw] = useState(0);
  const [all, setAll] = useState(false);
  const picks = drawn ?? loaded;

  function reshuffle() {
    setDrawn(
      CATEGORIES.map((c, i) => {
        const n = byCategory(c).length;
        const shown = picks[i];

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
          <li
            key={`${c}-${draw}`}
            className={draw ? "ex-in pt-3" : "pt-3"}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <p className={HEADING}>
              <span aria-hidden>── </span>
              {c}
            </p>
            <ExampleRow example={byCategory(c)[picks[i]]} onAsk={onAsk} />
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
