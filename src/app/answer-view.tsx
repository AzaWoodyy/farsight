"use client";

import { displayTeam } from "@/lib/domain/teams";

import "./zod-client";
import { Fragment, useMemo, useState } from "react";
import type { Answer, ResultRow, TableCell } from "@/lib/agent/types";
import { z } from "zod";
import { championSortKey, detectChampionRanking } from "@/lib/champions";
import { detectComparison } from "@/lib/comparison";
import { compareText, numberFormat } from "@/lib/locale";
import { ChampionPoolView, ChampionProfileView, ChampionRankingView } from "./champion-view";
import { EntityIcon } from "./entity-icon";
import { GameScoreboard } from "./game-scoreboard";
import { GameTimeline } from "./game-timeline";
import { useLocale, useUi } from "./i18n/locale-context";
import { SeriesView } from "./series-view";
import { PlayerComparison } from "./player-comparison";
import { PlayerHeader } from "./player-header";
import { PlayerRunesView } from "./player-runes-view";
import { TeamHeadToHead } from "./team-h2h";
import { TeamRoster } from "./team-roster";
import { LeagueTag } from "./league-tag";
import { Versus } from "./versus";

const CHIP =
  "press inline-flex min-h-11 items-center border border-dashed border-line px-3 text-left text-muted hover:border-accent hover:text-accent disabled:opacity-40 sm:pointer-fine:min-h-8";

type SortKey = "year" | "team" | "place" | "record" | "winrate";

export function AnswerView({ answer, onAsk }: { answer: Answer; onAsk: (q: string) => void }) {
  const ui = useUi();

  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold">
        <span className="text-accent">#</span> {answer.title}
      </h2>
      {answer.profiles.length === 1 && answer.profiles[0].teams.length > 0 && <PlayerHeader p={answer.profiles[0]} />}
      {answer.rows.length > 0 && <ResultsTable rows={answer.rows} />}
      {answer.champion && <ChampionProfileView p={answer.champion} />}
      {answer.series ? (
        <SeriesView list={answer.series} table={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.pool ? (
        <ChampionPoolView pool={answer.pool} fallback={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.runes ? (
        <PlayerRunesView r={answer.runes} fallback={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.versus ? (
        <Versus v={answer.versus} profiles={answer.profiles} fallback={answer.table && <GenericTable table={answer.table} />} />
      ) : answer.teams ? (
        <TeamHeadToHead v={answer.teams} logos={answer.icons} tones={answer.iconTones} leagues={answer.teamLeagues} byTournament={answer.table && <GenericTable table={answer.table} icons={answer.icons} tones={answer.iconTones} leagues={answer.teamLeagues} />} />
      ) : answer.roster ? (
        <TeamRoster r={answer.roster} logos={answer.icons} tones={answer.iconTones} leagues={answer.teamLeagues} />
      ) : (
        answer.table && <TableAnswer answer={answer} table={answer.table} />
      )}
      {answer.scoreboard && <GameScoreboard scoreboard={answer.scoreboard} />}
      {answer.timeline && <GameTimeline timeline={answer.timeline} />}
      <p className="mt-4 max-w-3xl text-sm leading-relaxed">{answer.summary}</p>
      {answer.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-warn">
          {ui.answer.note} {n}
        </p>
      ))}
      <div className="mt-6">
        <h3 className="text-xs text-muted">── {ui.answer.followUps}</h3>
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

function Sources({ sources }: { sources: Answer["sources"] }) {
  const ui = useUi();
  const leaguepedia = sources.every((s) => s.label.startsWith(SOURCE_PREFIX));

  return (
    <div className="mt-6 text-xs text-muted">
      <h3>
        ── {ui.answer.sources}
        {leaguepedia && " · Leaguepedia"}
      </h3>
      <ul className="mt-1 max-w-[100ch] leading-6">
        {sources.map((s, i) => (
          <li key={`${s.label}|${s.url}`} className="inline">
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

const RATINGS: { rating: Rating; label: "yes" | "no" }[] = [
  { rating: "up", label: "yes" },
  { rating: "down", label: "no" },
];

type FeedbackState =
  | { kind: "idle"; recorded: Rating | null }
  | { kind: "sending"; recorded: Rating | null; rating: Rating }
  | { kind: "failed"; recorded: Rating | null };

export function Feedback({ traceId, token }: { traceId: string; token: string }) {
  const ui = useUi();
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
      <span className="text-muted">── {ui.answer.correct}</span>
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
          {ui.answer[label]}
        </button>
      ))}
      <span role="status" className={state.kind === "failed" ? "text-error" : "text-muted"}>
        {state.kind === "failed" ? ui.answer.feedbackFailed : state.recorded ? ui.answer.feedbackSaved : ""}
      </span>
    </div>
  );
}

function ResultsTable({ rows }: { rows: ResultRow[] }) {
  const ui = useUi();
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
      <table className="w-full border-collapse text-left text-xs sm:min-w-[720px]">
        <thead className="border-b border-line">
          <tr>
            {header("year", ui.answer.year)}
            {header("team", ui.answer.team)}
            {header("place", ui.answer.place)}
            {header("record", ui.record, "text-right")}
            {header("winrate", "%", "hidden text-right sm:table-cell")}
            <th scope="col" className="hidden px-3 py-2 font-normal uppercase tracking-wider text-muted sm:table-cell">
              {ui.answer.champions}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Fragment key={`${r.event}-${r.team}`}>
              <tr className="border-t border-dashed border-line align-top first:border-0">
                <td className="px-2 py-2 tabular-nums sm:px-3">{r.year}</td>
                <td className="px-2 py-2 sm:px-3 sm:whitespace-nowrap">{displayTeam(r.team)}</td>
                <td className="px-2 py-2 sm:px-3 sm:whitespace-nowrap">
                  <span className={r.place === "1" ? "text-accent" : ""}>{r.placeLabel}</span>
                  {r.place && <span className="ml-1 whitespace-nowrap text-muted">({r.place})</span>}
                </td>
                <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums sm:px-3">
                  {r.wins}-{r.losses}
                  <div className="text-muted sm:hidden">{ui.percent(winRate(r))}</div>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-muted sm:table-cell">{winRate(r)}</td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <ResultChampions champions={r.champions} />
                </td>
              </tr>
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

function ResultChampions({ champions }: { champions: ResultRow["champions"] }) {
  const ui = useUi();

  return (
    <ul className="flex flex-wrap gap-1.5">
      {champions.map((c) => (
        <li key={c.name} title={ui.answer.played(c.name, c.games, c.wins)} className="flex items-center gap-1">
          {c.imageUrl ? (
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

function TableAnswer({ answer, table }: { answer: Answer; table: NonNullable<Answer["table"]> }) {
  const locale = useLocale();
  const comparison = useMemo(() => detectComparison(table, answer.profiles, null, locale), [table, answer.profiles, locale]);
  const champions = useMemo(() => detectChampionRanking(table, answer.icons, championSortKey(answer.meta.input), locale), [table, answer, locale]);

  if (comparison) return <PlayerComparison comparison={comparison} />;

  if (champions) return <ChampionRankingView ranking={champions} fallback={<GenericTable table={table} />} />;

  const card = table.rows.length === 1 && !answer.champion && table.rows[0].some((v, i) => asNumber(v) != null && !YEAR_COLUMN.test(table.columns[i]));
  const body = card ? <RowCard table={table} icons={answer.icons} tones={answer.iconTones} leagues={answer.teamLeagues} /> : <GenericTable table={table} icons={answer.icons} tones={answer.iconTones} leagues={answer.teamLeagues} />;
  const [team] = answer.meta.teams.length === 1 && answer.profiles.length !== 1 ? answer.meta.teams : [];
  const logo = team ? answer.icons[team] : undefined;

  if (!team || !logo) return body;

  return (
    <>
      <p className="mt-4 flex items-center gap-2 text-sm font-semibold" translate="no">
        <EntityIcon src={logo} size={32} tone={answer.iconTones[team]} />
        {team}
        <LeagueTag leagues={answer.teamLeagues[team]} />
      </p>
      <div className="[&>div]:mt-2">{body}</div>
    </>
  );
}

const asNumber = (v: TableCell) => z.number().safeParse(v).data ?? null;

const YEAR_COLUMN = /^(ann[ée]e|year|saison|season)$/i;

const DIFF_COLUMN = /^[ée]cart\b|diff|\bgap\b/i;

function useCells() {
  const locale = useLocale();
  const ui = useUi();
  const labels = new Map(Object.entries(ui.answer.columns));

  const cellText = (v: TableCell, column: string) => {
    const n = asNumber(v);

    if (v == null) return ui.noData;

    if (n == null || YEAR_COLUMN.test(column)) return String(v);

    return `${n > 0 && DIFF_COLUMN.test(column) ? "+" : ""}${numberFormat(locale, 2).format(n)}`;
  };

  return { cellText, labels };
}

const SHORT_CELL = 24;

type Table = NonNullable<Answer["table"]>;

const TOGGLE =
  "tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]";

function RowCard({ table, icons, tones, leagues }: { table: Table; icons: Answer["icons"]; tones: Answer["iconTones"]; leagues: Answer["teamLeagues"] }) {
  const ui = useUi();
  const { cellText, labels } = useCells();
  const [asTable, setAsTable] = useState(false);
  const row = table.rows[0];
  const firstFigure = table.columns.findIndex((c, i) => asNumber(row[i]) != null && !YEAR_COLUMN.test(c));
  const lead = firstFigure < 0 ? table.columns.length : firstFigure;
  const context = row.slice(0, lead).filter((v) => v != null).map(String);
  const hero = table.focus ? table.columns.indexOf(table.focus) : table.columns.length - lead === 1 ? lead : -1;
  const tiles = table.columns.map((c, i) => ({ c, i })).filter(({ i }) => i >= lead && i !== hero);

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <p className="text-muted">{context.join(" · ")}</p>
        <button type="button" onClick={() => setAsTable(!asTable)} aria-pressed={asTable} className={TOGGLE}>
          {asTable ? ui.answer.cardView : ui.champion.tableView}
        </button>
      </div>
      {asTable ? (
        <div className="[&>div]:mt-0">
          <GenericTable table={table} icons={icons} tones={tones} leagues={leagues} />
        </div>
      ) : (
        <div className="overflow-hidden border border-line">
          {hero >= 0 && (
            <div className="border-b border-line px-3 py-4">
              <p className="text-xs tracking-wider text-muted uppercase">{labels.get(table.columns[hero]) ?? table.columns[hero]}</p>
              <p className={`mt-1 text-3xl font-semibold tabular-nums ${row[hero] == null ? "text-muted" : "text-accent"}`}>
                {cellText(row[hero], table.columns[hero])}
              </p>
            </div>
          )}
          <dl className="-mr-px -mb-px grid grid-cols-2 text-xs sm:grid-cols-4">
            {tiles.map(({ c, i }) => (
              <div key={c} className="border-r border-b border-dashed border-line px-3 py-2">
                <dt className="text-[11px] text-muted">{labels.get(c) ?? c}</dt>
                <dd className={`whitespace-nowrap tabular-nums ${row[i] == null ? "text-muted" : ""}`}>{cellText(row[i], c)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function GenericTable({ table, icons, tones, leagues }: { table: Table; icons?: Answer["icons"]; tones?: Answer["iconTones"]; leagues?: Answer["teamLeagues"] }) {
  const locale = useLocale();
  const { cellText, labels } = useCells();
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return table.rows;

    return [...table.rows].sort((a, b) => {
      const [x, y] = [a[sort.col], b[sort.col]];

      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;

      const [nx, ny] = [asNumber(x), asNumber(y)];

      if (nx != null && ny != null) return (nx - ny) * sort.dir;

      return compareText(locale, String(x), String(y)) * sort.dir;
    });
  }, [table.rows, sort, locale]);

  return (
    <div className="relative mt-4 overflow-x-auto border border-line">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="border-b border-line">
          <tr>
            {table.columns.map((c, i) => {
              const active = sort?.col === i;
              const focus = c === table.focus;

              return (
                <th key={c} scope="col" className="px-3 py-2 font-normal" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    onClick={() => setSort({ col: i, dir: active ? (sort.dir === 1 ? -1 : 1) : asNumber(table.rows[0]?.[i] ?? null) != null ? -1 : 1 })}
                    className={`tap whitespace-nowrap uppercase tracking-wider hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${focus ? "text-accent" : active ? "text-foreground" : "text-muted"}`}
                  >
                    {labels.get(c) ?? c}
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
              {r.map((v, j) => {
                const text = cellText(v, table.columns[j]);
                const name = z.string().safeParse(v).data ?? "";
                const icon = icons?.[name];
                const league = leagues?.[name];
                const tone = v == null ? "text-muted" : table.columns[j] === table.focus ? "font-semibold text-accent" : "";

                return (
                  <td key={j} className={`px-3 py-2 tabular-nums ${text.length <= SHORT_CELL ? "whitespace-nowrap" : ""} ${tone}`}>
                    {icon || league ? (
                      <span className="inline-flex items-center gap-2 align-middle">
                        {icon && <EntityIcon src={icon} tone={tones?.[name]} />}
                        {text}
                        <LeagueTag leagues={league} />
                      </span>
                    ) : (
                      text
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
