"use client";

import "./zod-client";
import { Fragment, useMemo, useState } from "react";
import type { Answer, ResultRow, TableCell } from "@/lib/agent/types";
import { z } from "zod";
import { detectChampionRanking } from "@/lib/champions";
import { detectComparison } from "@/lib/comparison";
import { ChampionPoolView, ChampionProfileView, ChampionRankingView } from "./champion-view";
import { GameScoreboard } from "./game-scoreboard";
import { GameTimeline } from "./game-timeline";
import { SeriesView } from "./series-view";
import { PlayerComparison } from "./player-comparison";
import { TeamHeadToHead } from "./team-h2h";
import { TeamRoster } from "./team-roster";
import { Versus } from "./versus";

/**
 * The answer and everything it can show (tables, champion, comparison, roster, scoreboard, timeline...).
 * Loaded on demand by the console: the home page does not ship it.
 */

const CHIP =
  "press inline-flex min-h-11 items-center border border-dashed border-line px-3 text-left text-muted hover:border-accent hover:text-accent disabled:opacity-40 sm:pointer-fine:min-h-8";

type SortKey = "year" | "team" | "place" | "record" | "winrate";

const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

export function AnswerView({ answer, onAsk }: { answer: Answer; onAsk: (q: string) => void }) {
  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold">
        <span className="text-accent">#</span> {answer.title}
      </h2>
      {answer.rows.length > 0 && <ResultsTable rows={answer.rows} />}
      {answer.champion && <ChampionProfileView p={answer.champion} />}
      {answer.series ? (
        <SeriesView list={answer.series} table={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.pool ? (
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
      {answer.sources.length > 0 && <Sources sources={answer.sources} />}
    </div>
  );
}

const SOURCE_PREFIX = "Leaguepedia — ";

/**
 * Where the figures come from: every page is cited and linked, as one quiet paragraph under the answer. The
 * site they all come from is said once, in the heading, instead of on every link.
 */
function Sources({ sources }: { sources: Answer["sources"] }) {
  const leaguepedia = sources.every((s) => s.label.startsWith(SOURCE_PREFIX));

  return (
    <div className="mt-6 text-xs text-muted">
      <h3>── Sources{leaguepedia && " · Leaguepedia"}</h3>
      <ul className="mt-1 max-w-[100ch] leading-6">
        {sources.map((s, i) => (
          <li key={`${s.label}|${s.url}`} className="inline">
            {/* A page name stays whole on a line, except on a phone where a long one would overflow. */}
            <a href={s.url} target="_blank" rel="noreferrer" className="decoration-line underline-offset-2 hover:text-accent hover:underline sm:whitespace-nowrap">
              {leaguepedia ? s.label.slice(SOURCE_PREFIX.length) : s.label}
            </a>
            {i < sources.length - 1 && <span aria-hidden> · </span>}
          </li>
        ))}
      </ul>
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

export function Feedback({ traceId, token }: { traceId: string; token: string }) {
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
          className={`press inline-flex min-h-11 items-center border px-3 hover:border-accent hover:text-accent disabled:opacity-40 sm:pointer-fine:min-h-8 ${
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
      <th scope="col" className={`px-1 py-2 font-normal sm:px-3 ${className}`} aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}
          // One line: a label that wraps its sort arrow under it sits higher than its neighbours.
          className={`tap whitespace-nowrap uppercase hover:text-accent sm:tracking-wider ${active ? "text-foreground" : "text-muted"}`}
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
      {/* Phone width: no champions column (it was off screen, behind a horizontal scroll); each result's
          champions get a row of their own under it, and the table fits the screen. */}
      <table className="w-full border-collapse text-left text-xs sm:min-w-[720px]">
        <thead className="border-b border-line">
          <tr>
            {header("year", "Année")}
            {header("team", "Équipe")}
            {header("place", "Place")}
            {header("record", "V-D", "text-right")}
            {header("winrate", "%", "hidden text-right sm:table-cell")}
            <th scope="col" className="hidden px-3 py-2 font-normal uppercase tracking-wider text-muted sm:table-cell">
              Champions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Fragment key={`${r.event}-${r.team}`}>
              {/* The separator sits on top of each result: the phone-only champions row below it would otherwise
                  stay the tbody's last child at every width and keep a border against the frame. */}
              <tr className="border-t border-dashed border-line align-top first:border-0">
                <td className="px-2 py-2 tabular-nums sm:px-3">{r.year}</td>
                <td className="px-2 py-2 sm:px-3 sm:whitespace-nowrap">{displayTeam(r.team)}</td>
                <td className="px-2 py-2 sm:px-3 sm:whitespace-nowrap">
                  <span className={r.place === "1" ? "text-accent" : ""}>{r.placeLabel}</span>
                  {r.place && <span className="ml-1 whitespace-nowrap text-muted">({r.place})</span>}
                </td>
                <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums sm:px-3">
                  {r.wins}-{r.losses}
                  {/* Phone width: the win rate under the record, the % column would not fit at 320 px. */}
                  <div className="text-muted sm:hidden">{winRate(r)} %</div>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-muted sm:table-cell">{winRate(r)}</td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <ResultChampions champions={r.champions} />
                </td>
              </tr>
              {/* Phone width: the champions take a row of their own, the table's whole width. */}
              {r.champions.length > 0 && (
                <tr className="sm:hidden">
                  <td colSpan={4} className="px-2 pb-2">
                    <ResultChampions champions={r.champions} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const winRate = (r: ResultRow) => Math.round((100 * r.wins) / Math.max(1, r.wins + r.losses));

/** The champions a player played in one result line: icon and games, the name in the alt text and tooltip. */
function ResultChampions({ champions }: { champions: ResultRow["champions"] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {champions.map((c) => (
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
  );
}

/** The ranking order a tool was asked for, when it has one (champion_ranking): the champion layout's bar. */
const sortHint = (answer: Answer) => {
  const input = answer.meta.input;

  if (!input || !("sort" in input)) return undefined;

  // A total is its own column ("total_deaths"), beside the per-game figures of the same name.
  return "total" in input && input.total ? `total_${input.sort}` : input.sort;
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
                    className={`tap whitespace-nowrap uppercase tracking-wider hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${active ? "text-foreground" : "text-muted"}`}
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
