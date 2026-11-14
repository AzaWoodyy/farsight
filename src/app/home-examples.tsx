"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { SITE } from "./brand/site";

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
  { category: "parties", question: "Récap de la game 5 de la finale des Worlds 2024", display: "récap de partie" },
  { category: "parties", question: "Classement des Worlds 2023", display: "classement de tournoi" },
];

const byCategory = (c: Category) => EXAMPLES.filter((e) => e.category === c);

/** The layouts under comparison, picked with `?examples=`. The first is the default. */
const VARIANTS = [
  { id: "groups", label: "Groupes" },
  { id: "tabs", label: "Onglets" },
  { id: "shuffle", label: "Aléatoire" },
  { id: "terminal", label: "Terminal" },
] as const;

type VariantId = (typeof VARIANTS)[number]["id"];

type AskProps = { onAsk: (question: string) => void };

const HEADING = "text-xs text-muted";

function ExampleRow({ example, onAsk, stacked = false }: AskProps & { example: Example; stacked?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onAsk(example.question)}
      className="press group flex min-h-11 w-full flex-wrap items-baseline gap-x-2 border-b border-dashed border-line py-2.5 text-left sm:min-h-10"
    >
      <span aria-hidden className="text-accent">
        &gt;
      </span>
      <span className="min-w-0 flex-1 group-hover:text-accent">{example.question}</span>
      <span className={stacked ? "w-full pl-4 text-xs text-muted" : "w-full pl-4 text-xs text-muted sm:w-auto sm:pl-0"}>
        <span aria-hidden># </span>
        {example.display}
      </span>
    </button>
  );
}

/** Everything visible, one block per category: two columns from tablet up. */
function GroupsVariant({ onAsk }: AskProps) {
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
                <ExampleRow example={e} onAsk={onAsk} stacked />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One category at a time behind tabs (arrow keys move between them, as in the ARIA tabs pattern). */
function TabsVariant({ onAsk }: AskProps) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  function move(to: number) {
    const next = (to + CATEGORIES.length) % CATEGORIES.length;

    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <div className="mt-3">
      <div
        role="tablist"
        aria-label="Catégories d'exemples"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") move(active + 1);
          else if (e.key === "ArrowLeft") move(active - 1);
          else if (e.key === "Home") move(0);
          else if (e.key === "End") move(CATEGORIES.length - 1);
          else return;
          e.preventDefault();
        }}
      >
        {CATEGORIES.map((c, i) => (
          <button
            key={c}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            id={`${id}-tab-${i}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls={`${id}-panel`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`press inline-flex min-h-11 shrink-0 items-center gap-2 border px-3 text-sm sm:min-h-9 ${
              i === active ? "border-accent text-accent" : "border-dashed border-line text-muted hover:text-foreground"
            }`}
          >
            {c}
            <span className="text-xs opacity-70">{byCategory(c).length}</span>
          </button>
        ))}
      </div>
      <ul id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} className="mt-2 text-sm">
        {byCategory(CATEGORIES[active]).map((e) => (
          <li key={e.question}>
            <ExampleRow example={e} onAsk={onAsk} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One example per category, drawn again on demand; the full list stays one click away. */
function ShuffleVariant({ onAsk }: AskProps) {
  // Starts on the first example of each category, so the server and the browser render the same thing.
  const [picks, setPicks] = useState<number[]>(() => CATEGORIES.map(() => 0));
  const [draw, setDraw] = useState(0);
  const [all, setAll] = useState(false);

  function reshuffle() {
    setPicks((prev) =>
      CATEGORIES.map((c, i) => {
        const n = byCategory(c).length;

        // Another example than the one shown, when the category has more than one.
        return n < 2 ? 0 : (prev[i] + 1 + Math.floor(Math.random() * (n - 1))) % n;
      }),
    );
    setDraw((d) => d + 1);
  }

  return (
    <div className="mt-2">
      <ul className="grid gap-x-10 text-sm md:grid-cols-2">
        {CATEGORIES.map((c, i) => {
          const e = byCategory(c)[picks[i]];

          return (
            <li key={`${c}-${draw}`} className="ex-in pt-3" style={{ animationDelay: `${i * 40}ms` }}>
              <p className={HEADING}>
                <span aria-hidden>── </span>
                {c}
              </p>
              <ExampleRow example={e} onAsk={onAsk} stacked />
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={reshuffle}
          className="press inline-flex min-h-11 items-center gap-2 border border-line px-3 hover:border-accent hover:text-accent sm:min-h-9"
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
          className="press inline-flex min-h-11 items-center border border-dashed border-line px-3 text-muted hover:border-accent hover:text-accent sm:min-h-9"
        >
          {all ? "Masquer la liste" : `Tous les exemples (${EXAMPLES.length})`}
        </button>
      </div>
      {all && <GroupsVariant onAsk={onAsk} />}
    </div>
  );
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** A command palette: type to filter, arrows to move, Enter to run, in a bounded scrolling list. */
function TerminalVariant({ onAsk }: AskProps) {
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const words = fold(filter).split(/\s+/).filter(Boolean);

  const shown = EXAMPLES.filter((e) => {
    const text = fold(`${e.question} ${e.display} ${e.category}`);

    return words.every((w) => text.includes(w));
  });

  const current = Math.min(active, Math.max(shown.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className="mt-3 border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-dashed border-line px-3 py-2 text-xs text-muted">
        <span>$ minimap exemples</span>
        <span aria-live="polite">
          {shown.length}/{EXAMPLES.length}
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-dashed border-line px-3 has-[input:focus]:shadow-[inset_0_0_0_1px_var(--accent)]">
        <span aria-hidden className="text-accent">
          /
        </span>
        <label htmlFor={`${id}-filter`} className="sr-only">
          Filtrer les exemples
        </label>
        <input
          id={`${id}-filter`}
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={shown.length ? `${id}-opt-${current}` : undefined}
          aria-autocomplete="list"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((current + 1) % Math.max(shown.length, 1));
            else if (e.key === "ArrowUp") setActive((current - 1 + shown.length) % Math.max(shown.length, 1));
            else if (e.key === "Enter") {
              const pick = shown[current];

              if (pick) onAsk(pick.question);
              else if (filter.trim()) onAsk(filter);
            } else if (e.key === "Escape") {
              setFilter("");
              setActive(0);
            } else return;
            e.preventDefault();
          }}
          placeholder="filtrer : faker, roster…"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 min-w-0 flex-1 bg-transparent text-base caret-accent outline-none placeholder:text-muted sm:text-sm"
        />
      </div>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Exemples" className="max-h-80 overflow-y-auto text-sm">
        {shown.map((e, i) => (
          <li
            key={e.question}
            id={`${id}-opt-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === current}
            onMouseMove={() => i !== current && setActive(i)}
            onClick={() => onAsk(e.question)}
            className={`flex min-h-11 cursor-pointer flex-wrap items-baseline gap-x-3 px-3 py-2.5 sm:min-h-10 ${
              i === current ? "bg-accent/10 text-accent" : ""
            }`}
          >
            <span aria-hidden className={i === current ? "text-accent" : "text-transparent"}>
              ▸
            </span>
            <span className="min-w-0 flex-1">{e.question}</span>
            <span className="w-full pl-6 text-xs text-muted sm:w-auto sm:pl-0">
              [{e.category}] {e.display}
            </span>
          </li>
        ))}
        {!shown.length && (
          <li className="px-3 py-3 text-xs text-muted">
            Aucun exemple ne correspond. Entrée pour poser « {filter.trim()} » telle quelle.
          </li>
        )}
      </ul>
      <p className="hidden border-t border-dashed border-line px-3 py-2 text-xs text-muted sm:block">
        ↑↓ naviguer · entrée lancer · échap effacer
      </p>
    </div>
  );
}

const RENDER: Record<VariantId, (props: AskProps) => React.ReactNode> = {
  groups: GroupsVariant,
  tabs: TabsVariant,
  shuffle: ShuffleVariant,
  terminal: TerminalVariant,
};

/**
 * Prototype harness: the floating picker (fixed spec from the prototype skill, deliberately not on the
 * site's tokens), shown off production or with `?examples=`. Removed once a variant is chosen.
 */
function ProtoPicker({ current, onChange, onReplay }: { current: number; onChange: (i: number) => void; onReplay: () => void }) {
  const highlight = useRef<HTMLSpanElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const place = () => {
      const el = items.current[current];

      if (!el || !highlight.current) return;
      highlight.current.style.width = `${el.offsetWidth}px`;
      highlight.current.style.transform = `translateX(${el.offsetLeft}px)`;
    };

    place();
    window.addEventListener("resize", place);

    return () => window.removeEventListener("resize", place);
  }, [current]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));

    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target instanceof HTMLElement ? e.target : null;

      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest('[role="tablist"]')))
        return;

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const num = Number.parseInt(e.key, 10);

      if (num >= 1 && num <= VARIANTS.length) onChange(num - 1);
      else if (e.key === "ArrowRight") onChange((current + 1) % VARIANTS.length);
      else if (e.key === "ArrowLeft") onChange((current - 1 + VARIANTS.length) % VARIANTS.length);
      else if (e.key === "r" || e.key === "R") onReplay();
    }

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [current, onChange, onReplay]);

  return (
    <nav className="proto-picker" aria-label="Prototype variants" data-ready={ready ? "" : undefined}>
      <span ref={highlight} className="proto-picker-highlight" aria-hidden="true" />
      {VARIANTS.map((v, i) => (
        <button
          key={v.id}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          className="proto-picker-item"
          data-active={i === current ? "" : undefined}
          aria-current={i === current ? "true" : undefined}
          onClick={() => onChange(i)}
        >
          {v.label}
        </button>
      ))}
      <span className="proto-picker-divider" aria-hidden="true" />
      <button type="button" className="proto-picker-item proto-picker-replay" aria-label="Replay animation (R)" onClick={onReplay}>
        ↻
      </button>
    </nav>
  );
}

const noSubscribe = () => () => {};

/** The picker shows on every host but production (previews, local), and in production with `?examples=`. */
const offProduction = () => window.location.origin !== SITE.url;

function ExamplesFromUrl({ onAsk }: AskProps) {
  const requested = useSearchParams().get("examples");
  const picker = useSyncExternalStore(noSubscribe, offProduction, () => false) || requested !== null;
  const found = VARIANTS.findIndex((v) => v.id === requested);
  const [current, setCurrent] = useState(Math.max(found, 0));
  const [mount, setMount] = useState(0);
  const Variant = RENDER[VARIANTS[current].id];

  function change(i: number) {
    setCurrent(i);
    setMount((m) => m + 1);
    const url = new URL(window.location.href);

    url.searchParams.set("examples", VARIANTS[i].id);
    window.history.replaceState(null, "", url);
  }

  return (
    <>
      <Variant key={mount} onAsk={onAsk} />
      {picker && <ProtoPicker current={current} onChange={change} onReplay={() => setMount((m) => m + 1)} />}
    </>
  );
}

export function HomeExamples({ onAsk }: AskProps) {
  return (
    <>
      <h2 className={HEADING}>── Essaie par exemple</h2>
      {/* The query string is only known in the browser: the static page ships the default layout. */}
      <Suspense fallback={<GroupsVariant onAsk={onAsk} />}>
        <ExamplesFromUrl onAsk={onAsk} />
      </Suspense>
    </>
  );
}
