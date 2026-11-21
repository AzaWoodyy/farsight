import { z } from "zod";
import { type Db, selectAll } from "../db";
import { CUP_LEAGUES } from "../domain/leagues";
import { teamLogo } from "../domain/team-logos";
import type { ToolOutput } from "./tools";

const TEAM_COLUMN = /^(équipe|team|vainqueur|finaliste|adversaire|bleu|rouge|winner|runner-up|opponent|blue|red)\b|(^|_)team(_name)?$/i;

export function teamNames(out: Pick<ToolOutput, "teams" | "roster" | "table">, asked: string[]): string[] {
  const columns = out.table?.columns.flatMap((c, i) => (TEAM_COLUMN.test(c) ? [i] : [])) ?? [];

  return [
    ...new Set([
      ...asked,
      ...(out.teams ? [out.teams.teamA, out.teams.teamB, ...out.teams.series.flatMap((s) => [s.teamA, s.teamB])] : []),
      ...(out.roster ? [out.roster.team, ...out.roster.names] : []),
      ...(out.table?.rows.flatMap((r) => columns.flatMap((i) => z.string().safeParse(r[i]).data ?? [])) ?? []),
    ]),
  ];
}

const LEAGUE_SHARE = 0.1;

const LEAGUES_SHOWN = 2;

export async function teamBadges(db: Db, names: string[], period: Period, aliases: Record<string, string[]> = {}) {
  const files = await teamLogoFiles(db, names);

  const logos = names.flatMap((name) => {
    const file = files.get(name);

    return file ? [{ name, ...teamLogo(file) }] : [];
  });

  return {
    icons: Object.fromEntries(logos.map((l) => [l.name, l.url])),
    tones: Object.fromEntries(logos.flatMap((l) => (l.tone ? [[l.name, l.tone]] : []))),
    leagues: await teamLeagues(db, names, period, aliases),
  };
}

type Period = { yearFrom: number | null; yearTo: number | null };

export async function teamLogoFiles(db: Db, names: string[]): Promise<Map<string, string>> {
  if (!names.length) return new Map();

  const rows = await selectAll(
    db,
    z.object({ team: z.string(), logo: z.string().nullable() }),
    `WITH asked(team) AS (VALUES ${names.map(() => "(?)").join(", ")}),
     matched AS (
       SELECT a.team, to_jsonb(tm) ->> 'logo' AS logo FROM asked a
       JOIN teams tm ON tm.name = a.team OR (starts_with(tm.name, a.team || ' (') AND right(tm.name, 1) = ')'))
     SELECT team, MIN(logo) AS logo FROM matched GROUP BY team HAVING COUNT(*) = 1`,
    names,
  );

  return new Map(rows.flatMap((r) => (r.logo ? [[r.team, r.logo]] : [])));
}

export async function teamLeagues(db: Db, names: string[], period: Period, aliases: Record<string, string[]>): Promise<Record<string, string[]>> {
  const inPeriod = new Map([...(await seasonGames(db, names, period, aliases))].flatMap(([team, rows]) => {
    const leagues = ownLeagues(rows);

    return leagues.length ? [[team, leagues.toSorted((a, b) => a.first - b.first).slice(-LEAGUES_SHOWN).map((l) => l.league)]] : [];
  }));

  const missing = names.filter((n) => !inPeriod.has(n));

  const latest = [...(await seasonGames(db, missing, { yearFrom: null, yearTo: null }, aliases))].flatMap(([team, rows]) => {
    const years = [...new Set(rows.map((r) => r.year))].toSorted((a, b) => b - a);

    for (const year of years) {
      const leagues = ownLeagues(rows.filter((r) => r.year === year));

      if (leagues.length) return [[team, [leagues.reduce((a, b) => (b.last > a.last ? b : a)).league]] as const];
    }

    return [];
  });

  return Object.fromEntries([...inPeriod, ...latest]);
}

type SeasonGames = { year: number; league: string; own: number; games: number; first: number; last: number };

type LeagueGames = { league: string; games: number; first: number; last: number };

function ownLeagues(rows: SeasonGames[]): LeagueGames[] {
  const total = rows.reduce((n, r) => n + r.games, 0);
  const leagues = new Map<string, LeagueGames>();

  for (const r of rows.filter((x) => x.own)) {
    const l = leagues.get(r.league);
    leagues.set(r.league, { league: r.league, games: (l?.games ?? 0) + r.games, first: Math.min(l?.first ?? r.first, r.first), last: Math.max(l?.last ?? r.last, r.last) });
  }

  return [...leagues.values()].filter((l) => l.games >= total * LEAGUE_SHARE);
}

async function seasonGames(db: Db, names: string[], { yearFrom, yearTo }: Period, aliases: Record<string, string[]>): Promise<Map<string, SeasonGames[]>> {
  if (!names.length) return new Map();

  const asked = names.flatMap((team) => [...new Set([team, ...(aliases[team] ?? [])])].map((name) => [team, name]));

  const ids = await selectAll(
    db,
    z.object({ team: z.string(), id: z.number() }),
    `WITH asked(team, name) AS (VALUES ${asked.map(() => "(?, ?)").join(", ")})
     SELECT DISTINCT a.team, tm.id FROM asked a JOIN teams tm
       ON tm.name = a.name OR (tm.name ILIKE a.name || ' (%)' AND NOT EXISTS (SELECT 1 FROM teams x WHERE x.name = a.name))`,
    asked.flat(),
  );

  if (!ids.length) return new Map();

  const teamIds = [...new Set(ids.map((i) => i.id))];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

  const rows = await selectAll(
    db,
    z.object({ id: z.number(), year: z.number(), league: z.string(), own: z.number(), games: z.number(), first: z.number(), last: z.number() }),
    `WITH sides AS (
         SELECT blue_team_id AS id, tournament_id, played_at FROM games WHERE blue_team_id IN (${marks(teamIds.length)})
         UNION ALL SELECT red_team_id, tournament_id, played_at FROM games WHERE red_team_id IN (${marks(teamIds.length)}))
     SELECT s.id, t.year, l.short_name AS league, (l.is_international = 0 AND l.name NOT IN (${marks(CUP_LEAGUES.size)}))::integer AS own,
            COUNT(*) AS games, MIN(s.played_at) AS first, MAX(s.played_at) AS last
     FROM sides s JOIN tournaments t ON t.id = s.tournament_id JOIN leagues l ON l.id = t.league_id
     WHERE t.year IS NOT NULL AND (CAST(? AS integer) IS NULL OR t.year >= ?) AND (CAST(? AS integer) IS NULL OR t.year <= ?)
     GROUP BY s.id, t.year, l.id`,
    [...teamIds, ...teamIds, ...CUP_LEAGUES, yearFrom, yearFrom, yearTo, yearTo],
  );

  const byId = Map.groupBy(rows, (r) => r.id);

  return new Map([...Map.groupBy(ids, (i) => i.team)].map(([team, mine]) => [team, mine.flatMap((i) => byId.get(i.id) ?? [])]));
}
