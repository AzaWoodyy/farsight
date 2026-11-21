import type { CargoQuery } from "../../src/lib/sources/leaguepedia";

export const SCHEDULE_FIELDS = [
  "MS.MatchId=MatchId", "MS.OverviewPage=Page", "MS.Tab=Tab", "MS.N_MatchInTab=N",
  "MS.Team1=Team1", "MS.Team2=Team2", "MS.Winner=Winner", "MS.Team1Score=S1", "MS.Team2Score=S2",
  "MS.FF=FF", "MS.DateTime_UTC=Date", "MS.IsNullified=Nullified",
];

export function scheduleQuery(where: string, joinTournaments: boolean): CargoQuery {
  return {
    tables: joinTournaments ? "MatchSchedule=MS,Tournaments=T" : "MatchSchedule=MS",
    joinOn: joinTournaments ? "MS.OverviewPage=T.OverviewPage" : undefined,
    fields: SCHEDULE_FIELDS,
    where,
    orderBy: "MS.MatchId",
  };
}

export type ScheduledSeries = {
  page: string;
  tab: string | null;
  n: number | null;
  team1: string;
  team2: string;
  winner: 1 | 2 | null;
  score1: number | null;
  score2: number | null;
  forfeit: 1 | 2 | null;
  playedAt: number | null;
};

type Value = string | number | boolean | null | (string | number)[] | undefined;

const text = (v: Value) => (v == null || v === "" ? null : String(v).trim() || null);

const int = (v: Value) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

const side = (v: Value) => {
  const n = int(v);

  return n === 1 || n === 2 ? n : null;
};

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

export type ScoreboardMatch = { page: string; tab: string | null; n: number | null; team1: string | null; team2: string | null; playedAt: number | null };

const SAME_DAY_S = 2 * 86400;

type Played = { page: string; tab: string | null; n: number | null; teams: Set<string>; dates: (number | null)[]; taken: boolean };

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
