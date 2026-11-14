"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type AgentUIMessage,
  type Answer,
  type ResultRow,
  STEPS,
  type StepName,
  type StepPart,
  type TableCell,
  type TraceStatus,
} from "@/lib/agent/types";
import { z } from "zod";
import { detectChampionRanking } from "@/lib/champions";
import { detectComparison } from "@/lib/comparison";
import { ChampionPoolView, ChampionProfileView, ChampionRankingView } from "./champion-view";
import { GameScoreboard } from "./game-scoreboard";
import { GameTimeline } from "./game-timeline";
import { PlayerComparison } from "./player-comparison";
import { TeamHeadToHead } from "./team-h2h";
import { TeamRoster } from "./team-roster";
import { Versus } from "./versus";

/**
 * Home examples, one per answer layout, each answered by a typed tool without the LLM (checked with
 * `bun run ask`). The label names the layout the question opens.
 */
const EXAMPLES = [
  { question: "Résultats de Chovy à tous les Worlds", display: "palmarès" },
  { question: "Faker contre Chovy", display: "duel de joueurs" },
  { question: "KC contre MKOI", display: "confrontation d'équipes" },
  { question: "Stats d'Azir aux Worlds 2025", display: "fiche champion" },
  { question: "Champions les plus bannis en LCK 2025", display: "classement de champions" },
  { question: "Champion pool de Caps en LEC 2025", display: "champion pool" },
  { question: "Meilleurs mids aux Worlds 2026", display: "tableau de joueurs" },
  { question: "Récap de la game 5 de la finale des Worlds 2024", display: "récap de partie" },
];

/** What the visitor reads while a step runs: what the agent is doing, in plain words. */
const PROGRESS: Record<StepName, string> = {
  understand: "Je repère les joueurs, équipes et compétitions…",
  build: "Je prépare la recherche…",
  execute: "Je cherche dans les matchs…",
  format: "Je mets la réponse en forme…",
};

const CHIP =
  "press inline-flex min-h-11 items-center border border-dashed border-line px-3 text-left text-muted hover:border-accent hover:text-accent disabled:opacity-40 sm:min-h-8";

const STATUS: Record<TraceStatus, { mark: string; cls: string }> = {
  ok: { mark: "ok", cls: "text-ok" },
  warn: { mark: "!!", cls: "text-warn" },
  error: { mark: "xx", cls: "text-error" },
  fix: { mark: "~>", cls: "text-fix" },
};

const STEP_LABEL: Record<StepName, string> = {
  understand: "1 comprendre",
  build: "2 construire",
  execute: "3 exécuter",
  format: "4 mettre en forme",
};

type SortKey = "year" | "team" | "place" | "record" | "winrate";

const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

/** What the chat shows for a failed POST /api/ask, by HTTP status. */
function httpErrorMessage(status: number): string {
  if (status === 429) return "Trop de questions, réessaie dans quelques minutes.";

  if (status === 403) return "Requête refusée par la protection anti-robots. Recharge la page, puis réessaie.";

  if (status === 400) return "Question invalide : écris une question, puis réessaie.";

  if (status === 504) return "L'agent a mis trop de temps à répondre. Réessaie, ou pose une question plus simple.";

  if (status >= 500) return `Le serveur n'a pas pu répondre (HTTP ${status}). Réessaie dans un instant.`;

  return `La requête a échoué (HTTP ${status}).`;
}

/**
 * fetch for the chat transport: a non-2xx answer (a 429 from the firewall
 * rate limit, a 403 from BotID…) becomes a readable error instead of the
 * raw response body the transport would show.
 */
async function askFetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let res: Response;

  try {
    res = await fetch(input, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error("Connexion impossible : vérifie ta connexion, puis réessaie.");
  }

  if (!res.ok) throw new Error(httpErrorMessage(res.status));

  return res;
}

// The transport wants `typeof fetch`, which also carries `preconnect`.
const askFetch: typeof fetch = Object.assign(askFetchImpl, { preconnect: fetch.preconnect });

export function AgentConsole() {
  const [question, setQuestion] = useState("");
  // Anonymous id of this conversation: a random UUID made up at its first question and kept in the page,
  // so a reload or "nouvelle conversation" starts another. It groups the traces of the conversation, and
  // says nothing of the visitor.
  const sessionId = useRef<string | null>(null);

  const { messages, sendMessage, setMessages, status, error, stop } = useChat<AgentUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/ask", fetch: askFetch }),
  });

  const running = status === "submitted" || status === "streaming";

  function ask(q: string) {
    const text = q.trim();

    if (!text) return;

    if (running) stop();
    // One question at a time: the agent does not use the chat history.
    setMessages([]);
    setQuestion("");
    sessionId.current ??= crypto.randomUUID();
    sendMessage({ text }, { body: { sessionId: sessionId.current } });
  }

  function restart() {
    if (running) stop();
    setMessages([]);
    setQuestion("");
    sessionId.current = null;
  }

  const asked = messages.findLast((m) => m.role === "user");
  const reply = messages.findLast((m) => m.role === "assistant");
  const steps = new Map<StepName, StepPart>();
  let answer: Answer | null = null;
  let trace: { traceId: string; token: string } | null = null;

  for (const part of reply?.parts ?? []) {
    if (part.type === "data-step") steps.set(part.data.step, part.data);

    if (part.type === "data-answer") answer = part.data;

    if (part.type === "data-trace") trace = part.data;
  }

  const askedText = asked?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");

  return (
    <section>
      {asked ? (
        <h1 className="sr-only">{askedText}</h1>
      ) : (
        <div className="mt-10 sm:mt-16">
          <h1 className="max-w-3xl text-xl leading-snug font-semibold text-balance sm:text-3xl">
            <span aria-hidden className="text-accent">
              &gt;{" "}
            </span>
            Pose une question sur l&apos;esport League of Legends.
            <span aria-hidden className="cursor ml-1 inline-block h-[1em] w-[0.55em] translate-y-[0.15em] bg-accent" />
          </h1>
          <p className="mt-4 max-w-[68ch] border-l border-dashed border-line pl-3 text-sm leading-relaxed text-pretty text-muted">
            Minimap cherche dans les résultats et les matchs pros (Worlds, MSI, LCK, LPL, LEC, LCS…) et répond
            avec un tableau, une phrase de résumé et les pages d&apos;où viennent les chiffres.
          </p>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className={`${asked ? "mt-6" : "mt-8"} flex items-center gap-2 border border-line bg-background py-1 pr-1 pl-3 has-[input:focus]:border-accent has-[input:focus]:shadow-[0_0_0_1px_var(--accent)]`}
      >
        <span aria-hidden className="text-accent">
          &gt;
        </span>
        <label htmlFor="question" className="sr-only">
          Ta question
        </label>
        <input
          id="question"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Faker contre Chovy"
          autoComplete="off"
          enterKeyHint="search"
          className="min-h-11 min-w-0 flex-1 bg-transparent text-base caret-accent outline-none placeholder:text-muted sm:text-sm"
        />
        <button
          type="submit"
          disabled={running || !question.trim()}
          className="press min-h-11 shrink-0 border border-line px-4 text-xs tracking-wider uppercase hover:border-accent hover:text-accent disabled:opacity-40 sm:min-h-9"
        >
          {running ? "…" : "Demander"}
        </button>
      </form>

      {!asked && (
        <div className="mt-8">
          <h2 className="text-xs text-muted">── Essaie par exemple</h2>
          <ul className="mt-2 text-sm">
            {EXAMPLES.map(({ question: ex, display }) => (
              <li key={ex}>
                <button
                  type="button"
                  onClick={() => ask(ex)}
                  className="press group flex min-h-11 w-full flex-wrap items-baseline gap-x-2 border-b border-dashed border-line py-2.5 text-left sm:min-h-10"
                >
                  <span aria-hidden className="text-accent">
                    &gt;
                  </span>
                  <span className="min-w-0 flex-1 group-hover:text-accent">{ex}</span>
                  <span className="w-full pl-4 text-xs text-muted sm:w-auto sm:pl-0">
                    <span aria-hidden># </span>
                    {display}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-[70ch] text-xs leading-relaxed text-muted">
            Résultats, compositions et stats de partie :{" "}
            <a className="underline decoration-line underline-offset-2 hover:text-accent" href="https://lol.fandom.com" target="_blank" rel="noreferrer">
              Leaguepedia
            </a>{" "}
            (CC BY-SA 3.0). Noms et icônes des champions, objets et runes :{" "}
            <a
              className="underline decoration-line underline-offset-2 hover:text-accent"
              href="https://developer.riotgames.com/docs/lol#data-dragon"
              target="_blank"
              rel="noreferrer"
            >
              Riot Data Dragon
            </a>
            . Chaque réponse cite ses pages.
          </p>
        </div>
      )}

      {asked && (
        <div className="mt-8">
          <div className="flex items-start justify-between gap-4">
            <p className="min-w-0 pt-2.5 text-sm sm:pt-1">
              <span aria-hidden className="text-muted">
                ?
              </span>{" "}
              {askedText}
            </p>
            <button
              type="button"
              onClick={restart}
              className="press inline-flex min-h-11 shrink-0 items-center text-xs text-muted underline decoration-line underline-offset-2 hover:text-accent sm:min-h-8"
            >
              Nouvelle conversation
            </button>
          </div>
          {running && <Progress steps={steps} />}
          {error && !answer && (
            <p role="alert" className="mt-4 text-sm text-error">
              <span aria-hidden>xx</span> {error.message}
            </p>
          )}
          {answer && <AnswerView answer={answer} onAsk={ask} />}
          {answer && trace && <Feedback key={trace.traceId} traceId={trace.traceId} token={trace.token} />}
          {steps.size > 0 && <HowIFoundIt steps={steps} running={running} />}
        </div>
      )}
    </section>
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A braille spinner, fast so the wait feels short; a still dot when the visitor asks for reduced motion. */
function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);

    return () => window.clearInterval(id);
  }, []);

  return (
    <span aria-hidden className="inline-block w-4 text-accent">
      {SPINNER[frame]}
    </span>
  );
}

/** The one line shown while the agent works, read from the step that is running. */
function Progress({ steps }: { steps: Map<StepName, StepPart> }) {
  // The latest step started; once it is done and before the next one streams, the next one is what comes.
  const lastIndex = STEPS.findLastIndex((name) => steps.has(name));
  const last = lastIndex < 0 ? undefined : STEPS[lastIndex];
  const current = last && steps.get(last)?.state === "done" ? (STEPS[lastIndex + 1] ?? last) : last;
  const retrying = current === "execute" && steps.get("execute")?.entries.some((e) => e.status === "fix");
  const label = !current ? "Je lis ta question…" : retrying ? "Je réessaie autrement…" : PROGRESS[current];

  return (
    <p className="mt-6 flex items-center gap-2 text-sm">
      <Spinner />
      <span role="status">{label}</span>
    </p>
  );
}

/**
 * The technical trace (steps, decisions, SQL, retries): open while the agent works, so the visitor sees it
 * progress, folded once the answer is in. The visitor can still open or close it by hand.
 */
function HowIFoundIt({ steps, running }: { steps: Map<StepName, StepPart>; running: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);

  // A run starting opens the trace, a run ending folds it. Set on the element after commit and left
  // uncontrolled otherwise: mirroring the toggle event into state raced with the fold (the browser's
  // toggle for the opening could land after it and reopen the trace).
  useLayoutEffect(() => {
    if (ref.current) ref.current.open = running;
  }, [running]);

  return (
    <details ref={ref} data-how className={`${running ? "mt-4" : "mt-8"} border-t border-dashed border-line pt-4`}>
      <summary className="press inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-muted hover:text-accent sm:min-h-8">
        <span aria-hidden data-chevron className="inline-block">
          ›
        </span>
        {running ? "Comment je cherche" : "Voir comment j\u2019ai trouvé"}
      </summary>
      <Steps steps={steps} running={running} />
    </details>
  );
}

function Steps({ steps, running }: { steps: Map<StepName, StepPart>; running: boolean }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <ol className="space-y-2 text-xs">
        {STEPS.map((name, i) => {
          const part = steps.get(name);
          const branch = i === STEPS.length - 1 ? "└─" : "├─";

          if (!part)
            return (
              <li key={name} className="flex gap-2 text-muted/60">
                <span aria-hidden>{branch}</span>
                <span className="w-5 shrink-0">··</span>
                <span className="w-32 shrink-0">{STEP_LABEL[name]}</span>
                <span>{running ? "en attente" : "non exécutée"}</span>
              </li>
            );
          const interrupted = part.state === "running" && !running;
          const active = part.state === "running" && running;
          const s = STATUS[interrupted ? "error" : part.status];

          return (
            <li key={name}>
              <div className="flex gap-2">
                <span aria-hidden className="text-muted">
                  {branch}
                </span>
                <span className={`${active ? "animate-pulse text-muted" : s.cls} w-5 shrink-0`}>
                  {active ? ".." : s.mark}
                </span>
                <span className="w-32 shrink-0 text-muted">{STEP_LABEL[name]}</span>
                <span className="min-w-0">{interrupted ? "interrompue" : part.title}</span>
              </div>
              <ul className="mt-1 ml-[4.5rem] space-y-0.5 border-l border-line pl-3">
                {part.entries.map((e, j) => (
                  <li key={`${e.at}-${j}`}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none gap-2 marker:hidden">
                        <span className={`${STATUS[e.status].cls} w-5 shrink-0`}>{STATUS[e.status].mark}</span>
                        <span className="min-w-0">
                          {e.title}
                          {e.level && (
                            <span className="ml-2 text-muted">
                              [{e.level}
                              {e.confidence != null && ` ${e.confidence.toFixed(2)}`}]
                            </span>
                          )}
                          {e.detail && <span className="ml-2 text-muted group-open:hidden">[+]</span>}
                        </span>
                      </summary>
                      {e.detail && (
                        <pre className="mt-1 mb-2 ml-7 overflow-x-auto text-[11px] leading-relaxed text-muted">
                          {e.detail}
                        </pre>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AnswerView({ answer, onAsk }: { answer: Answer; onAsk: (q: string) => void }) {
  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold">
        <span className="text-accent">#</span> {answer.title}
      </h2>
      {answer.rows.length > 0 && <ResultsTable rows={answer.rows} />}
      {answer.champion && <ChampionProfileView p={answer.champion} />}
      {answer.pool ? (
        <ChampionPoolView pool={answer.pool} fallback={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.versus ? (
        <Versus v={answer.versus} profiles={answer.profiles} fallback={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.teams ? (
        <TeamHeadToHead v={answer.teams} byTournament={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.roster ? (
        <TeamRoster r={answer.roster} />
      ) : (
        answer.table && <TableAnswer answer={answer} table={answer.table} />
      )}
      {answer.scoreboard && <GameScoreboard scoreboard={answer.scoreboard} />}
      {answer.timeline && <GameTimeline timeline={answer.timeline} />}
      <p className="mt-4 max-w-3xl text-sm leading-relaxed">{answer.summary}</p>
      {answer.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-warn">
          note : {n}
        </p>
      ))}
      {answer.sources.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs text-muted">── Sources</h3>
          <ul className="mt-2 space-y-1 text-xs leading-6">
            {answer.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-accent">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6">
        <h3 className="text-xs text-muted">── Questions de suivi</h3>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {answer.followUps.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onAsk(f)}
              className={CHIP}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type Rating = "up" | "down";

const RATINGS: { rating: Rating; label: string }[] = [
  { rating: "up", label: "[+] oui" },
  { rating: "down", label: "[-] non" },
];

/**
 * Thumbs up / down on the answer, shown only when the question was traced.
 * The rating goes to /api/feedback with the trace id and nothing else; a
 * second click replaces the first.
 */
type FeedbackState =
  | { kind: "idle"; recorded: Rating | null }
  | { kind: "sending"; recorded: Rating | null; rating: Rating }
  | { kind: "failed"; recorded: Rating | null };

function Feedback({ traceId, token }: { traceId: string; token: string }) {
  const [state, setState] = useState<FeedbackState>({ kind: "idle", recorded: null });

  async function rate(rating: Rating) {
    setState({ kind: "sending", rating, recorded: state.recorded });

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId, token, rating }),
      });

      setState({ kind: res.ok ? "idle" : "failed", recorded: res.ok ? rating : state.recorded });
    } catch {
      setState({ kind: "failed", recorded: state.recorded });
    }
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">── Réponse correcte ?</span>
      {RATINGS.map(({ rating, label }) => (
        <button
          key={rating}
          type="button"
          onClick={() => rate(rating)}
          disabled={state.kind === "sending"}
          aria-pressed={state.recorded === rating}
          className={`press inline-flex min-h-11 items-center border px-3 hover:border-accent hover:text-accent disabled:opacity-40 sm:min-h-8 ${
            state.recorded === rating ? "border-accent text-accent" : "border-dashed border-line text-muted"
          }`}
        >
          {label}
        </button>
      ))}
      <span role="status" className={state.kind === "failed" ? "text-error" : "text-muted"}>
        {state.kind === "failed" ? "avis non enregistré, réessaie" : state.recorded ? "merci, avis enregistré" : ""}
      </span>
    </div>
  );
}

function ResultsTable({ rows }: { rows: ResultRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "year", dir: 1 });

  const sorted = useMemo(() => {
    const value = (r: ResultRow): number | string => {
      switch (sort.key) {
        case "year":
          return r.year;
        case "team":
          return displayTeam(r.team).toLowerCase();
        case "place":
          return r.placeNumber ?? Number.POSITIVE_INFINITY;
        case "record":
          return r.wins - r.losses;
        case "winrate":
          return r.wins / Math.max(1, r.wins + r.losses);
      }
    };

    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);

      return (va < vb ? -1 : va > vb ? 1 : a.year - b.year) * sort.dir;
    });
  }, [rows, sort]);

  const header = (key: SortKey, label: string, className = "") => {
    const active = sort.key === key;

    return (
      <th scope="col" className={`px-3 py-2 font-normal ${className}`} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}
          className={`uppercase tracking-wider hover:text-accent ${active ? "text-foreground" : "text-muted"}`}
        >
          {label}
          <span aria-hidden className="ml-1 inline-block w-2">
            {active ? (sort.dir === 1 ? "↑" : "↓") : ""}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className="mt-4 overflow-x-auto border border-line">
      <table className="w-full min-w-[720px] border-collapse text-left text-xs">
        <thead className="border-b border-line">
          <tr>
            {header("year", "Année")}
            {header("team", "Équipe")}
            {header("place", "Place")}
            {header("record", "V-D", "text-right")}
            {header("winrate", "%", "text-right")}
            <th scope="col" className="px-3 py-2 font-normal uppercase tracking-wider text-muted">
              Champions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={`${r.event}-${r.team}`} className="border-b border-dashed border-line last:border-0 align-top">
              <td className="px-3 py-2 tabular-nums">{r.year}</td>
              <td className="px-3 py-2 whitespace-nowrap">{displayTeam(r.team)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <span className={r.place === "1" ? "text-accent" : ""}>{r.placeLabel}</span>
                {r.place && <span className="ml-1 text-muted">({r.place})</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.wins}-{r.losses}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">
                {Math.round((100 * r.wins) / Math.max(1, r.wins + r.losses))}
              </td>
              <td className="px-3 py-2">
                <ul className="flex flex-wrap gap-1.5">
                  {r.champions.map((c) => (
                    <li key={c.name} title={`${c.name} : ${c.games} partie(s), ${c.wins} victoire(s)`} className="flex items-center gap-1">
                      {c.imageUrl ? (
                        // 20 px Data Dragon icons: next/image would spend the Vercel Hobby image-optimization quota
                        // (shared with the portfolio) without any LCP gain.
                        // oxlint-disable-next-line nextjs/no-img-element
                        <img src={c.imageUrl} alt={c.name} width={20} height={20} className="h-5 w-5" loading="lazy" />
                      ) : (
                        <span>{c.name}</span>
                      )}
                      <span className="text-muted tabular-nums">×{c.games}</span>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ranking order a tool was asked for, when it has one (champion_ranking): the champion layout's bar. */
const sortHint = (answer: Answer) => {
  const input = answer.meta.input;

  return input && "sort" in input ? input.sort : undefined;
};

/**
 * A two-player comparison or a champion ranking gets its own layout, detected from the table itself (typed
 * tool or generated SQL); any other table stays the sortable generic one.
 */
function TableAnswer({ answer, table }: { answer: Answer; table: NonNullable<Answer["table"]> }) {
  const comparison = useMemo(() => detectComparison(table, answer.profiles), [table, answer.profiles]);
  const champions = useMemo(() => detectChampionRanking(table, answer.icons, sortHint(answer)), [table, answer]);

  if (comparison) return <PlayerComparison comparison={comparison} />;

  if (champions) return <ChampionRankingView ranking={champions} fallback={<GenericTable table={table} />} />;

  return <GenericTable table={table} />;
}

const NUMBER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

const asNumber = (v: TableCell) => z.number().safeParse(v).data ?? null;

/** Headers of the machine-named columns the champion and comparison layouts read, when shown as a plain table. */
const COLUMN_LABEL = new Map([
  ["rank", "rang"],
  ["presence", "présence %"],
  ["winrate", "% victoires"],
  ["player", "joueur"],
  ["games", "parties"],
  ["wins", "victoires"],
  ["losses", "défaites"],
  ["share", "part %"],
  ["players", "joueurs"],
]);

const YEAR_COLUMN = /^(ann[ée]e|year|saison|season)$/i;

/** A cell as shown: numbers in French notation (years as written), a missing figure as n/d. */
const cellText = (v: TableCell, column: string) => {
  const n = asNumber(v);

  return v == null ? "n/d" : n != null && !YEAR_COLUMN.test(column) ? NUMBER.format(n) : String(v);
};

/** Any table, sortable by each column (numbers before text, missing figures last). */
function GenericTable({ table }: { table: NonNullable<Answer["table"]> }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return table.rows;

    return [...table.rows].sort((a, b) => {
      const [x, y] = [a[sort.col], b[sort.col]];

      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;

      const [nx, ny] = [asNumber(x), asNumber(y)];

      if (nx != null && ny != null) return (nx - ny) * sort.dir;

      return String(x).localeCompare(String(y), "fr", { numeric: true }) * sort.dir;
    });
  }, [table.rows, sort]);

  return (
    <div className="mt-4 overflow-x-auto border border-line">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="border-b border-line">
          <tr>
            {table.columns.map((c, i) => {
              const active = sort?.col === i;

              return (
                <th key={c} scope="col" className="px-3 py-2 font-normal" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    // Numbers sort high to low first: a ranking reads from the top.
                    onClick={() => setSort({ col: i, dir: active ? (sort.dir === 1 ? -1 : 1) : asNumber(table.rows[0]?.[i] ?? null) != null ? -1 : 1 })}
                    className={`whitespace-nowrap uppercase tracking-wider hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${active ? "text-foreground" : "text-muted"}`}
                  >
                    {COLUMN_LABEL.get(c) ?? c}
                    <span aria-hidden className="ml-1 inline-block w-2">
                      {active ? (sort.dir === 1 ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-dashed border-line last:border-0">
              {r.map((v, j) => (
                <td key={j} className={`px-3 py-2 tabular-nums ${v == null ? "text-muted" : ""}`}>
                  {cellText(v, table.columns[j])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
