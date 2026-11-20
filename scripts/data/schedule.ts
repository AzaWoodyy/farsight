/**
 * Series results from Leaguepedia's match schedule (`MatchSchedule`): teams, score, winner, date, tab.
 *
 * Scoreboards (`ScoreboardGames`) are the source of every game, but some matches are only on the schedule:
 * a qualifier, an academy league or an old season whose games were never written up. `data:fetch` saves the
 * whole schedule of the scope (`schedule.json`), and `data:build` keeps, as `series_results`, the decided
 * matches that have no scoreboard game (`scheduleOnly`): a series result, without any game statistic.
 */
import type { CargoQuery } from "../../src/lib/sources/leaguepedia";

export const SCHEDULE_FIELDS = [
  "MS.MatchId=MatchId", "MS.OverviewPage=Page", "MS.Tab=Tab", "MS.N_MatchInTab=N",
  "MS.Team1=Team1", "MS.Team2=Team2", "MS.Winner=Winner", "MS.Team1Score=S1", "MS.Team2Score=S2",
  "MS.FF=FF", "MS.DateTime_UTC=Date", "MS.IsNullified=Nullified",
];

/** The schedule of the tournaments a `where` selects (on `T`, Tournaments, or `MS`). */
export function scheduleQuery(where: string, joinTournaments: boolean): CargoQuery {
  return {
    tables: joinTournaments ? "MatchSchedule=MS,Tournaments=T" : "MatchSchedule=MS",
    joinOn: joinTournaments ? "MS.OverviewPage=T.OverviewPage" : undefined,
    fields: SCHEDULE_FIELDS,
    where,
    orderBy: "MS.MatchId",
  };
}

/** A schedule match between two named teams, as `data:build` reads it. */
export type ScheduledSeries = {
  page: string;
  tab: string | null;
  n: number | null;
  team1: string;
  team2: string;
  /** 1 or 2; null for a draw or a match not played yet, which only claims its scoreboards. */
  winner: 1 | 2 | null;
  score1: number | null;
  score2: number | null;
  /** The side that forfeited (1 or 2), null when the series was played. */
  forfeit: 1 | 2 | null;
  /** Unix seconds, null when the schedule has no date. */
  playedAt: number | null;
};

type Value = string | number | boolean | null | (string | number)[] | undefined;

const text = (v: Value) => (v == null || v === "" ? null : String(v).trim() || null);

const int = (v: Value) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

const side = (v: Value) => {
  const n = int(v);

  return n === 1 || n === 2 ? n : null;
};

/** A not nullified match between two named teams, decided or not; null for anything else (TBD, nullified). */
export function scheduledSeries(row: Record<string, Value>): ScheduledSeries | null {
  const page = text(row.Page);
  const team1 = text(row.Team1);
  const team2 = text(row.Team2);
  const winner = side(row.Winner);

  if (!page || !team1 || !team2 || team1 === team2 || int(row.Nullified) === 1) return null;

  if (/^TBD$/i.test(team1) || /^TBD$/i.test(team2)) return null;
  const date = text(row.Date);
  const playedAt = date ? Math.floor(Date.parse(`${date.replace(" ", "T")}Z`) / 1000) : null;

  return {
    page,
    tab: text(row.Tab),
    n: int(row.N),
    team1,
    team2,
    winner,
    score1: int(row.S1),
    score2: int(row.S2),
    forfeit: side(row.FF),
    playedAt: Number.isFinite(playedAt) ? playedAt : null,
  };
}

/** A scoreboard game, as `scheduleOnly` compares it with the schedule. */
export type ScoreboardMatch = { page: string; tab: string | null; n: number | null; team1: string | null; team2: string | null; playedAt: number | null };

/** Two days: a scoreboard's date and the schedule's can differ by the time zone or a late start. */
const SAME_DAY_S = 2 * 86400;

/** One scoreboard series: the games of one tab's match on one page (or a lone game without a slot). */
type Played = { page: string; tab: string | null; n: number | null; teams: Set<string>; dates: (number | null)[]; taken: boolean };

/**
 * The decided schedule matches no scoreboard series covers. Each scoreboard series covers one match at most, in this order:
 * the same tab and number on the same page (the scoreboard GameId "<page>_<tab>_<match>_<game>" mirrors the
 * MatchId), then the same two teams on the same page within two days. On a page whose scoreboards name their tabs
 * otherwise ("Scoreboards" for the schedule's "Quarterfinals"), a team can also be named otherwise ("ALTERNATE aTTaX"
 * for "Team ALTERNATE"): a scoreboard series no match claimed covers a match of that tab with one team in common
 * within two days, so that no series is counted twice. A draw (a best-of-two at 1-1) claims its scoreboards too, but
 * is never kept: a series without a winner is no result.
 */
export function scheduleOnly(schedule: ScheduledSeries[], games: ScoreboardMatch[]): ScheduledSeries[] {
  const series = new Map<string, Played>();
  const tabs = new Set<string>();

  games.forEach((g, i) => {
    const key = g.tab != null && g.n != null ? `${g.page}\u0000${g.tab}\u0000${g.n}` : `${g.page}\u0000#${i}`;
    const played = series.get(key) ?? { page: g.page, tab: g.tab, n: g.n, teams: new Set<string>(), dates: [], taken: false };

    for (const t of [g.team1, g.team2]) if (t) played.teams.add(t.toLowerCase());
    played.dates.push(g.playedAt);
    series.set(key, played);

    if (g.tab != null) tabs.add(`${g.page}\u0000${g.tab}`);
  });

  const byPage = new Map<string, Played[]>();

  for (const p of series.values()) byPage.set(p.page, [...(byPage.get(p.page) ?? []), p]);

  // Without a date on either side, a series of the same page counts as close.
  const near = (p: Played, at: number | null) => p.dates.some((d) => d == null || at == null || Math.abs(d - at) <= SAME_DAY_S);
  const teamsOf = (s: ScheduledSeries) => [s.team1.toLowerCase(), s.team2.toLowerCase()];
  const decided = schedule.filter((s) => !(s.tab && /showmatch/i.test(s.tab)));
  const covered = new Set<ScheduledSeries>();

  const claim = (s: ScheduledSeries, p: Played | undefined) => {
    if (!p) return;
    p.taken = true;
    covered.add(s);
  };

  for (const s of decided) if (s.tab != null && s.n != null) claim(s, series.get(`${s.page}\u0000${s.tab}\u0000${s.n}`));

  for (const s of decided)
    if (!covered.has(s)) claim(s, byPage.get(s.page)?.find((p) => !p.taken && teamsOf(s).every((t) => p.teams.has(t)) && near(p, s.playedAt)));

  for (const s of decided)
    if (!covered.has(s) && !(s.tab != null && tabs.has(`${s.page}\u0000${s.tab}`)))
      claim(s, byPage.get(s.page)?.find((p) => !p.taken && teamsOf(s).some((t) => p.teams.has(t)) && near(p, s.playedAt)));

  return decided.filter((s) => s.winner != null && !covered.has(s));
}
