"use client";

import type { ReactNode } from "react";
import type { SeriesDetail, SeriesGame, SeriesList, SeriesPick, Side } from "@/lib/agent/types";

/** Up to this many series, every one opens on its games; a longer phase (Swiss rounds) lists them closed. */
const OPEN_UP_TO = 4;

const DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const SIDE_TEXT: Record<Side, string> = { blue: "text-blue", red: "text-red" };

const SIDE_LABEL: Record<Side, string> = { blue: "bleu", red: "rouge" };

const ROLE_SHORT = new Map([
  ["Top", "TOP"],
  ["Jungle", "JGL"],
  ["Mid", "MID"],
  ["Bot", "BOT"],
  ["Support", "SUP"],
]);

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const winnerName = (g: SeriesGame) => (g.winner === "blue" ? g.blue : g.winner === "red" ? g.red : null);

/**
 * Series as best-of units: the score and the format first, then every game with its sides, winner, running
 * score, duration, picks and bans, and its Leaguepedia page. The games stay below in the sortable table.
 */
export function SeriesView({ list, table }: { list: SeriesList; table: ReactNode }) {
  const open = list.series.length <= OPEN_UP_TO;

  return (
    <div className="mt-4">
      <p className="text-xs text-muted">
        <span aria-hidden>── </span>
        {list.scope} · {list.count} série{list.count > 1 ? "s" : ""}
      </p>
      <ol className="mt-2 grid gap-3">
        {list.series.map((s) => (
          <li key={`${s.tournamentPage}-${s.label}-${s.playedAt}-${s.teamA}`}>
            <SeriesBlock s={s} open={open} />
          </li>
        ))}
      </ol>
      {table && (
        <>
          <h3 className="mt-6 text-xs uppercase tracking-widest text-muted">── toutes les games</h3>
          {table}
        </>
      )}
    </div>
  );
}

function SeriesBlock({ s, open }: { s: SeriesDetail; open: boolean }) {
  const lead = s.winsA === s.winsB ? null : s.winsA > s.winsB ? "a" : "b";

  const header = (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-3">
      <span className={`truncate text-right text-sm font-semibold ${lead === "a" ? "text-accent" : ""}`} translate="no">
        {s.teamA}
      </span>
      <span className="text-2xl tabular-nums">
        <span className={lead === "a" ? "text-accent" : ""}>{s.winsA}</span>
        <span className="px-1 text-muted">–</span>
        <span className={lead === "b" ? "text-accent" : ""}>{s.winsB}</span>
      </span>
      <span className={`truncate text-sm font-semibold ${lead === "b" ? "text-accent" : ""}`} translate="no">
        {s.teamB}
      </span>
    </div>
  );

  const meta = (
    <p className="flex flex-wrap items-center gap-x-2 border-t border-dashed border-line px-3 py-2 text-xs text-muted">
      <span>{s.label}</span>
      <span aria-hidden>·</span>
      <span>{s.bestOf ? `BO${s.bestOf}` : "format n/d"}</span>
      {s.playedAt != null && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{DATE.format(new Date(s.playedAt * 1000))}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <a href={s.source.url} target="_blank" rel="noreferrer" title={s.source.label} className="tap underline decoration-line underline-offset-2 hover:text-accent">
        source
      </a>
    </p>
  );

  if (!s.games)
    return (
      <section aria-label={`${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`} className="border border-line">
        {header}
        {meta}
      </section>
    );

  // Header and meta stay outside the summary: a link inside a summary (a button) is unreliable for assistive
  // technology, so only the games line folds the series.
  return (
    <section aria-label={`${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`} className="border border-line">
      {header}
      {meta}
      <details open={open} className="group">
        <summary className="block cursor-pointer list-none border-t border-dashed border-line px-3 py-1.5 text-[11px] text-muted pointer-coarse:min-h-11 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block w-3 group-open:rotate-90">
            ›
          </span>
          {s.games.length} game{s.games.length > 1 ? "s" : ""} · picks, bans et durée
        </summary>
        <ol className="border-t border-line">
          {s.games.map((g, i) => (
            <GameRow key={`${g.n}-${g.playedAt}-${i}`} g={g} s={s} before={s.games!.slice(0, i)} />
          ))}
        </ol>
      </details>
    </section>
  );
}

/** One game: sides, winner, running score, duration, patch, then each side's picks (Top → Support) and bans. */
function GameRow({ g, s, before }: { g: SeriesGame; s: SeriesDetail; before: SeriesGame[] }) {
  const won = (team: string) => [...before, g].filter((x) => winnerName(x) === team).length;
  const winner = winnerName(g);

  return (
    <li className="border-b border-dashed border-line px-3 py-2.5 text-xs last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pointer-coarse:items-center">
        <span className="w-14 shrink-0 font-semibold">game {g.n ?? "?"}</span>
        <span>
          <span className={SIDE_TEXT.blue} translate="no">
            {g.blue}
          </span>{" "}
          <span className="text-muted">vs</span>{" "}
          <span className={SIDE_TEXT.red} translate="no">
            {g.red}
          </span>
        </span>
        <span>
          <span aria-hidden className="text-muted">
            →{" "}
          </span>
          {winner && g.winner ? (
            <>
              <span className="text-accent" translate="no">
                {winner}
              </span>{" "}
              <span className="text-muted">({SIDE_LABEL[g.winner]})</span>
            </>
          ) : (
            <span className="text-muted">vainqueur n/d</span>
          )}
        </span>
        <span className="tabular-nums text-muted" title={`Score après la game ${g.n ?? "?"}`}>
          [{won(s.teamA)}-{won(s.teamB)}]
        </span>
        <span className="tabular-nums text-muted">{g.durationS ? clock(g.durationS) : "durée n/d"}</span>
        {g.patch && <span className="text-muted">patch {g.patch}</span>}
        <a href={g.source.url} target="_blank" rel="noreferrer" title={g.source.label} className="tap text-muted underline decoration-line underline-offset-2 hover:text-accent">
          source
        </a>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(["blue", "red"] as const).map((side) => (
          <Draft key={side} side={side} team={side === "blue" ? g.blue : g.red} picks={g.picks[side]} bans={g.bans[side]} />
        ))}
      </div>
    </li>
  );
}

function Draft({ side, team, picks, bans }: { side: Side; team: string; picks: SeriesPick[]; bans: { champion: string; icon: string | null }[] }) {
  return (
    <div className="min-w-0">
      <p className="sr-only">
        {team}, côté {SIDE_LABEL[side]}
      </p>
      {picks.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Picks de ${team}`}>
          {picks.map((p) => (
            <li key={`${p.player}-${p.champion}`} className="flex items-center gap-1" title={`${p.role ?? ""} ${p.player} · ${p.champion ?? "n/d"}`.trim()}>
              <ChampionIcon name={p.champion} icon={p.icon} size={24} side={side} />
              <span className="hidden flex-col leading-tight lg:flex">
                <span className="text-[10px] text-muted">{p.role ? (ROLE_SHORT.get(p.role) ?? p.role) : ""}</span>
                <span className="max-w-16 truncate text-[11px]" translate="no">
                  {p.player}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">picks n/d</p>
      )}
      {bans.length > 0 && (
        <ul className="mt-1 flex flex-wrap items-center gap-1" aria-label={`Bans de ${team}`}>
          <li aria-hidden className="text-[10px] text-muted">
            bans
          </li>
          {bans.map((b, i) => (
            <li key={`${b.champion}-${i}`} className="opacity-60 grayscale">
              <ChampionIcon name={b.champion} icon={b.icon} size={18} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChampionIcon({ name, icon, size, side }: { name: string | null; icon: string | null; size: number; side?: Side }): ReactNode {
  const border = side === "blue" ? "border-blue" : side === "red" ? "border-red" : "border-line";

  if (!icon || !name)
    return (
      <span className={`flex shrink-0 items-center justify-center border ${border} text-[9px] text-muted`} style={{ width: size, height: size }} title={name ?? "n/d"}>
        {name?.slice(0, 3) ?? "?"}
      </span>
    );

  // Data Dragon icons: next/image would spend the Vercel Hobby image-optimization quota without any LCP gain.
  // oxlint-disable-next-line nextjs/no-img-element
  return <img src={icon} alt={name} title={name} width={size} height={size} loading="lazy" className={`shrink-0 border ${border}`} style={{ width: size, height: size }} />;
}
