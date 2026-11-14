"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useRef, useState } from "react";
import {
  type AgentUIMessage,
  type Answer,
  type ResultRow,
  STEPS,
  type StepName,
  type StepPart,
  type TraceStatus,
} from "@/lib/agent/types";
import { detectComparison } from "@/lib/comparison";
import { GameScoreboard } from "./game-scoreboard";
import { GameTimeline } from "./game-timeline";
import { PlayerComparison } from "./player-comparison";

const EXAMPLES = [
  "résultats de Chovy à tous les Worlds",
  "bilan de 정지훈 aux mondiaux",
  "Faker au MSI",
  "timeline de la game 5 de la finale des Worlds 2024",
];

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

  return (
    <section className="mt-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="flex items-center gap-2 border border-line bg-background px-3 py-2 focus-within:border-accent"
      >
        <span aria-hidden className="text-accent">
          &gt;
        </span>
        <label htmlFor="question" className="sr-only">
          Question
        </label>
        <input
          id="question"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="résultats de Chovy à tous les Worlds"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
        />
        <button
          type="submit"
          disabled={running || !question.trim()}
          className="border border-line px-3 py-1 text-xs uppercase tracking-wider hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {running ? "…" : "Demander"}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => ask(ex)}
            disabled={running}
            className="border border-dashed border-line px-2 py-1 text-muted hover:border-accent hover:text-accent"
          >
            {ex}
          </button>
        ))}
      </div>

      {asked && (
        <div className="mt-10">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm">
              <span className="text-muted">?</span>{" "}
              {asked.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")}
            </p>
            <button type="button" onClick={restart} className="shrink-0 text-xs text-muted underline decoration-line underline-offset-2 hover:text-accent">
              nouvelle conversation
            </button>
          </div>
          <Steps steps={steps} running={running} />
          {error && !answer && (
            <p role="alert" className="mt-4 text-xs text-error">
              <span aria-hidden>xx</span> {error.message}
            </p>
          )}
          {answer && <AnswerView answer={answer} onAsk={ask} />}
          {answer && trace && <Feedback key={trace.traceId} traceId={trace.traceId} token={trace.token} />}
        </div>
      )}
    </section>
  );
}

function Steps({ steps, running }: { steps: Map<StepName, StepPart>; running: boolean }) {
  return (
    <div className="mt-4">
      <h2 className="text-xs uppercase tracking-widest text-muted">── étapes de l&apos;agent</h2>
      <ol className="mt-2 space-y-2 text-xs" aria-live="polite">
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
      {answer.table && <TableAnswer table={answer.table} profiles={answer.profiles} />}
      {answer.timeline && <GameTimeline timeline={answer.timeline} />}
      {answer.scoreboard && <GameScoreboard scoreboard={answer.scoreboard} />}
      <p className="mt-4 max-w-3xl text-sm leading-relaxed">{answer.summary}</p>
      {answer.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-warn">
          note : {n}
        </p>
      ))}
      {answer.sources.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs uppercase tracking-widest text-muted">── sources</h3>
          <ul className="mt-2 space-y-1 text-xs">
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
        <h3 className="text-xs uppercase tracking-widest text-muted">── questions de suivi</h3>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {answer.followUps.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onAsk(f)}
              className="border border-dashed border-line px-2 py-1 text-muted hover:border-accent hover:text-accent"
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
      <span className="uppercase tracking-widest text-muted">── réponse correcte ?</span>
      {RATINGS.map(({ rating, label }) => (
        <button
          key={rating}
          type="button"
          onClick={() => rate(rating)}
          disabled={state.kind === "sending"}
          aria-pressed={state.recorded === rating}
          className={`border px-2 py-1 hover:border-accent hover:text-accent disabled:opacity-40 ${
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

/** A two-player comparison gets its own layouts; any other table stays the generic one. */
function TableAnswer({ table, profiles }: { table: NonNullable<Answer["table"]>; profiles: Answer["profiles"] }) {
  const comparison = useMemo(() => detectComparison(table, profiles), [table, profiles]);

  if (!comparison) return <GenericTable table={table} />;

  return <PlayerComparison comparison={comparison} table={<GenericTable table={table} />} />;
}

function GenericTable({ table }: { table: NonNullable<Answer["table"]> }) {
  return (
    <div className="mt-4 overflow-x-auto border border-line">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="border-b border-line">
          <tr>
            {table.columns.map((c) => (
              <th key={c} scope="col" className="px-3 py-2 font-normal uppercase tracking-wider text-muted">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-b border-dashed border-line last:border-0">
              {r.map((v, j) => (
                <td key={j} className="px-3 py-2 tabular-nums">
                  {v == null ? "—" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
