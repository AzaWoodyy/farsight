import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { selectAll } from "../db";
import { CUP_LEAGUES } from "../domain/leagues";
import { teamLogo } from "../domain/team-logos";
import type { ToolOutput } from "./tools";

/**
 * What the views put beside a team's name: its logo (Leaguepedia, by the name shown) and the league it played
 * in over the answer's period, read from the database.
 */

/** Headers of the table columns that hold a team name (as the tools write them, and a generated query's `team` columns). */
const TEAM_COLUMN = /^(équipe|team|vainqueur|finaliste|adversaire|bleu|rouge)\b|(^|_)team(_name)?$/i;

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
export function teamBadges(db: DatabaseSync, names: string[], period: Period, aliases: Record<string, string[]> = {}) {
  const logos = names.flatMap((name) => {
    const logo = teamLogo(name);

    return logo ? [{ name, ...logo }] : [];
  });

  return {
    icons: Object.fromEntries(logos.map((l) => [l.name, l.url])),
    tones: Object.fromEntries(logos.flatMap((l) => (l.tone ? [[l.name, l.tone]] : []))),
    leagues: teamLeagues(db, names, period, aliases),
  };
}

type Period = { yearFrom: number | null; yearTo: number | null };

/**
 * The league each team played in over the period: its own leagues (neither international nor cross-league),
 * each with at least LEAGUE_SHARE of its games there, oldest first, the last LEAGUES_SHOWN of them. A team
 * without such a game in the period under that name (a name taken later, "Movistar KOI" at MSI 2023) gets the
 * last league it played in. A name is matched as stored or as displayed, without Leaguepedia's disambiguation
 * ("Griffin (Korean Team)").
 */
export function teamLeagues(db: DatabaseSync, names: string[], period: Period, aliases: Record<string, string[]>): Record<string, string[]> {
  const inPeriod = leagueGames(db, names, period, aliases);
  const missing = names.filter((n) => !inPeriod.has(n));
  const latest = missing.length ? leagueGames(db, missing, { yearFrom: null, yearTo: null }, aliases) : new Map<string, LeagueGames[]>();

  const shown = (leagues: LeagueGames[], count: number) => {
    const total = leagues.reduce((n, l) => n + l.games, 0);

    return leagues.filter((l) => l.games >= total * LEAGUE_SHARE).slice(-count).map((l) => l.league);
  };

  return Object.fromEntries([...[...inPeriod].map(([team, l]) => [team, shown(l, LEAGUES_SHOWN)]), ...[...latest].map(([team, l]) => [team, shown(l, 1)])]);
}

type LeagueGames = { league: string; games: number; first: number };

/** Games of each team per league of its own over the period, leagues by their first game. */
function leagueGames(db: DatabaseSync, names: string[], { yearFrom, yearTo }: Period, aliases: Record<string, string[]>): Map<string, LeagueGames[]> {
  if (!names.length) return new Map();

  const asked = names.flatMap((team) => [...new Set([team, ...(aliases[team] ?? [])])].map((name) => [team, name]));

  // Two queries: given the shown names as a joined list, SQLite walks it again for every game.
  const ids = selectAll(
    db,
    z.object({ team: z.string(), id: z.number() }),
    `WITH asked(team, name) AS (SELECT value ->> 0, value ->> 1 FROM json_each(?))
     SELECT DISTINCT a.team, tm.id FROM asked a JOIN teams tm
       ON tm.name = a.name OR (tm.name LIKE a.name || ' (%)' AND NOT EXISTS (SELECT 1 FROM teams x WHERE x.name = a.name))`,
    [JSON.stringify(asked)],
  );

  if (!ids.length) return new Map();

  const rows = selectAll(
    db,
    z.object({ id: z.number(), league: z.string(), games: z.number(), first: z.number() }),
    `WITH ids(id) AS (SELECT value FROM json_each(?)),
       sides AS (
         SELECT blue_team_id AS id, tournament_id, played_at FROM games WHERE blue_team_id IN ids
         UNION ALL SELECT red_team_id, tournament_id, played_at FROM games WHERE red_team_id IN ids)
     SELECT s.id, l.short_name AS league, COUNT(*) AS games, MIN(s.played_at) AS first
     FROM sides s JOIN tournaments t ON t.id = s.tournament_id JOIN leagues l ON l.id = t.league_id
     WHERE l.is_international = 0 AND l.name NOT IN (SELECT value FROM json_each(?))
       AND (? IS NULL OR t.year >= ?) AND (? IS NULL OR t.year <= ?)
     GROUP BY s.id, l.id`,
    [JSON.stringify([...new Set(ids.map((i) => i.id))]), JSON.stringify([...CUP_LEAGUES]), yearFrom, yearFrom, yearTo, yearTo],
  );

  const byId = Map.groupBy(rows, (r) => r.id);

  return new Map(
    [...Map.groupBy(ids, (i) => i.team)].flatMap(([team, own]) => {
      const leagues = new Map<string, LeagueGames>();

      for (const r of own.flatMap((i) => byId.get(i.id) ?? [])) {
        const l = leagues.get(r.league);
        leagues.set(r.league, l ? { league: r.league, games: l.games + r.games, first: Math.min(l.first, r.first) } : { league: r.league, games: r.games, first: r.first });
      }

      return leagues.size ? [[team, [...leagues.values()].sort((a, b) => a.first - b.first)]] : [];
    }),
  );
}
