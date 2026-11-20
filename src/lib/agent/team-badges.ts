import { z } from "zod";
import { type Db, selectAll } from "../db";
import { CUP_LEAGUES } from "../domain/leagues";
import { teamLogo } from "../domain/team-logos";
import type { ToolOutput } from "./tools";

/**
 * What the views put beside a team's name: its logo (Leaguepedia, by the name shown) and the league it played
 * in over the answer's period, read from the database.
 */

/** Headers of the table columns that hold a team name (as the tools write them, and a generated query's `team` columns). */
const TEAM_COLUMN = /^(équipe|team|vainqueur|finaliste|adversaire|bleu|rouge|winner|runner-up|opponent|blue|red)\b|(^|_)team(_name)?$/i;

/**
 * Every team the question or the answer names (the two sides of a confrontation and of its series, a roster's
 * team, the team columns of a table), by the name shown: the views put its logo and its league beside that name.
 */
export function teamNames(out: Pick<ToolOutput, "teams" | "roster" | "table">, asked: string[]): string[] {
  const columns = out.table?.columns.flatMap((c, i) => (TEAM_COLUMN.test(c) ? [i] : [])) ?? [];

  return [
    ...new Set([
      // The teams the question names: an answer about one team shows its logo even when no cell holds its name.
      ...asked,
      ...(out.teams ? [out.teams.teamA, out.teams.teamB, ...out.teams.series.flatMap((s) => [s.teamA, s.teamB])] : []),
      ...(out.roster ? [out.roster.team, ...out.roster.names] : []),
      ...(out.table?.rows.flatMap((r) => columns.flatMap((i) => z.string().safeParse(r[i]).data ?? [])) ?? []),
    ]),
  ];
}

/** A league below this share of a team's games over the period (a few games as a stand-in) does not name its league. */
const LEAGUE_SHARE = 0.1;

/** Leagues shown for a team that moved over the period: the last ones it played in. */
const LEAGUES_SHOWN = 2;

/**
 * Logo, logo tone and league of each team name. `aliases`: the other names a shown name stands for (a roster's
 * team counts every name it played under), whose games count for its league.
 */
export async function teamBadges(db: Db, names: string[], period: Period, aliases: Record<string, string[]> = {}) {
  const logos = names.flatMap((name) => {
    const logo = teamLogo(name);

    return logo ? [{ name, ...logo }] : [];
  });

  return {
    icons: Object.fromEntries(logos.map((l) => [l.name, l.url])),
    tones: Object.fromEntries(logos.flatMap((l) => (l.tone ? [[l.name, l.tone]] : []))),
    leagues: await teamLeagues(db, names, period, aliases),
  };
}

type Period = { yearFrom: number | null; yearTo: number | null };

/**
 * The league each team played in over the period: its own leagues (neither international nor cross-league),
 * each with at least LEAGUE_SHARE of all its games of the period, oldest first, the last LEAGUES_SHOWN of them.
 * A team without one in the period under that name (a name taken later, "Movistar KOI" at MSI 2023) gets the
 * league it last played in, from its latest season that has one. A name is matched as stored or as displayed,
 * without Leaguepedia's disambiguation ("Griffin (Korean Team)").
 */
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

/** The own leagues of these games that hold at least LEAGUE_SHARE of them (internationals and cups count in the total). */
function ownLeagues(rows: SeasonGames[]): LeagueGames[] {
  const total = rows.reduce((n, r) => n + r.games, 0);
  const leagues = new Map<string, LeagueGames>();

  for (const r of rows.filter((x) => x.own)) {
    const l = leagues.get(r.league);
    leagues.set(r.league, { league: r.league, games: (l?.games ?? 0) + r.games, first: Math.min(l?.first ?? r.first, r.first), last: Math.max(l?.last ?? r.last, r.last) });
  }

  return [...leagues.values()].filter((l) => l.games >= total * LEAGUE_SHARE);
}

/** Games of each team over the period, by season and competition. */
async function seasonGames(db: Db, names: string[], { yearFrom, yearTo }: Period, aliases: Record<string, string[]>): Promise<Map<string, SeasonGames[]>> {
  if (!names.length) return new Map();

  const asked = names.flatMap((team) => [...new Set([team, ...(aliases[team] ?? [])])].map((name) => [team, name]));

  // Two queries: given the shown names as a joined list, SQLite walks it again for every game.
  const ids = await selectAll(
    db,
    z.object({ team: z.string(), id: z.number() }),
    `WITH asked(team, name) AS (SELECT value ->> 0, value ->> 1 FROM json_each(?))
     SELECT DISTINCT a.team, tm.id FROM asked a JOIN teams tm
       ON tm.name = a.name OR (tm.name LIKE a.name || ' (%)' AND NOT EXISTS (SELECT 1 FROM teams x WHERE x.name = a.name))`,
    [JSON.stringify(asked)],
  );

  if (!ids.length) return new Map();

  const rows = await selectAll(
    db,
    z.object({ id: z.number(), year: z.number(), league: z.string(), own: z.number(), games: z.number(), first: z.number(), last: z.number() }),
    `WITH ids(id) AS (SELECT value FROM json_each(?)),
       sides AS (
         SELECT blue_team_id AS id, tournament_id, played_at FROM games WHERE blue_team_id IN ids
         UNION ALL SELECT red_team_id, tournament_id, played_at FROM games WHERE red_team_id IN ids)
     SELECT s.id, t.year, l.short_name AS league, (l.is_international = 0 AND l.name NOT IN (SELECT value FROM json_each(?))) AS own,
            COUNT(*) AS games, MIN(s.played_at) AS first, MAX(s.played_at) AS last
     FROM sides s JOIN tournaments t ON t.id = s.tournament_id JOIN leagues l ON l.id = t.league_id
     WHERE t.year IS NOT NULL AND (? IS NULL OR t.year >= ?) AND (? IS NULL OR t.year <= ?)
     GROUP BY s.id, t.year, l.id`,
    [JSON.stringify([...new Set(ids.map((i) => i.id))]), JSON.stringify([...CUP_LEAGUES]), yearFrom, yearFrom, yearTo, yearTo],
  );

  const byId = Map.groupBy(rows, (r) => r.id);

  return new Map([...Map.groupBy(ids, (i) => i.team)].map(([team, mine]) => [team, mine.flatMap((i) => byId.get(i.id) ?? [])]));
}
