"use client";

import { type ReactNode, useState } from "react";
import type { TeamHeadToHead as View, TeamSeries } from "@/lib/agent/types";
import { dateFormat } from "@/lib/locale";
import { useLocale, useUi } from "./i18n/locale-context";
import { EntityIcon } from "./entity-icon";

/** Team name → logo, for the names the answer has one for. */
type Logos = Record<string, string>;

type Tones = Record<string, "dark" | "light">;

/** Series listed before "show all". */
const FIRST_SERIES = 10;

/**
 * Two teams' meetings: their record in series and in games, then every series with its date, competition,
 * score, winner and Leaguepedia page. The per-tournament table stays below, sortable.
 */
export function TeamHeadToHead({ v, logos, tones, byTournament }: { v: View; logos: Logos; tones: Tones; byTournament: ReactNode }) {
  const ui = useUi();
  const [all, setAll] = useState(false);
  const list = all ? v.series : v.series.slice(0, FIRST_SERIES);
  const lead = v.seriesA === v.seriesB ? null : v.seriesA > v.seriesB ? 0 : 1;

  return (
    <div className="mt-4">
      <div className="border border-line">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-3">
          <Side name={v.teamA} logo={logos[v.teamA]} tone={tones[v.teamA]} series={v.seriesA} games={v.gamesA} lead={lead === 0} align="right" />
          <span className="text-xs text-muted">vs</span>
          <Side name={v.teamB} logo={logos[v.teamB]} tone={tones[v.teamB]} series={v.seriesB} games={v.gamesB} lead={lead === 1} align="left" />
        </div>
        <p className="border-t border-dashed border-line px-3 py-2 text-xs text-muted">
          {ui.teams.summary(v.seriesCount, v.scope || ui.allCompetitions)}
        </p>
      </div>

      <h3 className="mt-6 text-xs uppercase tracking-widest text-muted">── {ui.teams.meetings}</h3>
      {/* relative: the sr-only header is absolutely positioned and would widen the page from outside the scroller. */}
      <div className="relative mt-2 overflow-x-auto border border-line">
        <table className="w-full min-w-[560px] border-collapse text-left text-xs">
          <thead className="border-b border-line text-[11px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.date}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.competition}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.teams.score}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.winner}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                <span className="sr-only">source</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((s, i) => (
              <SeriesRow key={`${s.source.url}-${s.playedAt}-${i}`} s={s} logos={logos} tones={tones} />
            ))}
          </tbody>
        </table>
      </div>
      {v.series.length > FIRST_SERIES && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="tap mt-2 border border-dashed border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          {all ? ui.showLast(FIRST_SERIES) : ui.teams.showAll(v.series.length)}
        </button>
      )}
      {v.seriesCount > v.series.length && (
        <p className="mt-2 text-[11px] text-muted">{ui.teams.listed(v.series.length, v.seriesCount)}</p>
      )}

      <h3 className="mt-6 text-xs uppercase tracking-widest text-muted">── {ui.teams.byTournament}</h3>
      {byTournament}
    </div>
  );
}

function Side({ name, logo, tone, series, games, lead, align }: { name: string; logo?: string; tone?: "dark" | "light"; series: number; games: number; lead: boolean; align: "left" | "right" }) {
  const ui = useUi();

  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : ""}`}>
      {/* The logo sits on the outer side of the name, so the two names stay next to the "vs". */}
      <div className={`flex items-center gap-2 text-sm font-semibold ${align === "right" ? "justify-end" : "flex-row-reverse justify-end"}`}>
        {logo && <EntityIcon src={logo} size={32} tone={tone} />}
        <span className="truncate" translate="no">
          {name}
        </span>
      </div>
      <div className={`text-2xl tabular-nums ${lead ? "text-accent" : ""}`}>{series}</div>
      <div className="text-[11px] text-muted tabular-nums">{ui.games(games)}</div>
    </div>
  );
}

function SeriesRow({ s, logos, tones }: { s: TeamSeries; logos: Logos; tones: Tones }) {
  const ui = useUi();
  const date = dateFormat(useLocale(), { day: "2-digit", month: "short", year: "numeric" });
  const winner = s.winsA === s.winsB ? null : s.winsA > s.winsB ? s.teamA : s.teamB;

  return (
    <tr className="border-b border-dashed border-line align-middle last:border-0">
      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted">{s.playedAt ? date.format(new Date(s.playedAt * 1000)) : ui.noData}</td>
      <td className="px-3 py-1.5">{s.label}</td>
      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
        <span translate="no">{s.teamA}</span> <span className={s.winsA > s.winsB ? "text-accent" : ""}>{s.winsA}</span>–
        <span className={s.winsB > s.winsA ? "text-accent" : ""}>{s.winsB}</span> <span translate="no">{s.teamB}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-1.5">{winner ? (
          <span className="inline-flex items-center gap-2 align-middle text-accent">
            {logos[winner] && <EntityIcon src={logos[winner]} tone={tones[winner]} />}
            {winner}
          </span>
        ) : (
          <span className="text-muted">{ui.noData}</span>
        )}</td>
      <td className="px-3 py-1.5">
        <a href={s.source.url} target="_blank" rel="noreferrer" title={s.source.label} className="tap underline decoration-line underline-offset-2 hover:text-accent">
          source
        </a>
      </td>
    </tr>
  );
}
