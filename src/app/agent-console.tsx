"use client";

import { useMemo, useRef, useState } from "react";
import type { Answer, ResultRow, TraceEntry } from "@/lib/agent/types";

const EXAMPLES = [
  "résultats de Chovy à tous les Worlds",
  "bilan de 정지훈 aux mondiaux",
  "Chovy aux Worlds 2017",
];

const STATUS: Record<TraceEntry["status"], { mark: string; cls: string }> = {
  ok: { mark: "ok", cls: "text-ok" },
  warn: { mark: "!!", cls: "text-warn" },
  error: { mark: "xx", cls: "text-error" },
  fix: { mark: "~>", cls: "text-fix" },
};

type SortKey = "year" | "team" | "place" | "record" | "winrate";

const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

export function AgentConsole() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAsked(text);
    setQuestion("");
    setTrace([]);
    setAnswer(null);
    setRunning(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const update = JSON.parse(line) as { trace: TraceEntry[]; answer: Answer | null };
          setTrace((prev) => [...prev, ...update.trace]);
          if (update.answer) setAnswer(update.answer);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setTrace((prev) => [
          ...prev,
          { node: "format", status: "error", title: `Requête échouée : ${(err as Error).message}`, at: new Date().toISOString() },
        ]);
    } finally {
      setRunning(false);
    }
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
          <p className="text-sm">
            <span className="text-muted">?</span> {asked}
          </p>
          <Trace trace={trace} running={running} />
          {answer && <AnswerView answer={answer} onAsk={ask} />}
        </div>
      )}
    </section>
  );
}

function Trace({ trace, running }: { trace: TraceEntry[]; running: boolean }) {
  return (
    <div className="mt-4">
      <h2 className="text-xs uppercase tracking-widest text-muted">── trace du graphe</h2>
      <ol className="mt-2 space-y-1 text-xs" aria-live="polite">
        {trace.map((e, i) => {
          const s = STATUS[e.status];
          const last = i === trace.length - 1 && !running;
          return (
            <li key={`${e.at}-${i}`}>
              <details className="group">
                <summary className="flex cursor-pointer list-none gap-2 marker:hidden">
                  <span aria-hidden className="text-muted">
                    {last ? "└─" : "├─"}
                  </span>
                  <span className={`${s.cls} w-5 shrink-0`}>{s.mark}</span>
                  <span className="w-24 shrink-0 text-muted">{e.node}</span>
                  <span className="min-w-0">
                    {e.title}
                    {e.detail && <span className="ml-2 text-muted group-open:hidden">[+]</span>}
                  </span>
                </summary>
                {e.detail && (
                  <pre className="mt-1 mb-2 ml-8 overflow-x-auto border-l border-line pl-3 text-[11px] leading-relaxed text-muted">
                    {e.detail}
                  </pre>
                )}
              </details>
            </li>
          );
        })}
        {running && (
          <li className="flex gap-2 text-muted">
            <span aria-hidden>└─</span>
            <span className="animate-pulse">…</span>
          </li>
        )}
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
                        // eslint-disable-next-line @next/next/no-img-element
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
