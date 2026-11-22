import { z } from "zod";
import { type Db, selectAll } from "../db";
import type { LeagueName } from "../domain/leagues";
import { renamedTeams } from "./understand";

type Tiers = { top: LeagueName[]; lower: LeagueName[]; second: LeagueName[] };

export const LEAGUE_TIERS = {
  LEC: {
    top: ["Europe League Championship Series", "LoL EMEA Championship"],
    lower: [
      "La Ligue Française",
      "La Ligue Française Division 2",
      "LVP SuperLiga Orange",
      "LVP SuperLiga",
      "Liga Española de League of Legends",
      "LVP SuperLiga 2nd Division",
      "European Masters",
      "EMEA Masters",
    ],
    second: ["La Ligue Française Division 2", "LVP SuperLiga 2nd Division"],
  },
  LCK: {
    top: ["LoL The Champions", "LoL Champions Korea"],
    lower: ["LCK Challengers League", "Challengers Korea", "LCK Academy Series"],
    second: ["LCK Challengers League", "Challengers Korea"],
  },
} as const satisfies Record<string, Tiers>;

export type TopLeague = keyof typeof LEAGUE_TIERS;

export type PathScope = "lower" | "second";

export type LeaguePath = { team: string; before: { league: string; year: number }[]; arrived: number; topGames: number };

const Appearance = z.object({ team: z.string(), league: z.string(), first_year: z.number(), games: z.number() });

export async function leaguePaths(db: Db, top: TopLeague, scope: PathScope): Promise<LeaguePath[]> {
  const tiers: Tiers = LEAGUE_TIERS[top];
  const counted = scope === "second" ? tiers.second : tiers.lower;
  const leagues = [...tiers.top, ...tiers.lower];
  const marks = leagues.map(() => "?").join(", ");

  const rows = await selectAll(
    db,
    Appearance,
    `SELECT team, league, MIN(year) AS first_year, COUNT(*) AS games
     FROM (SELECT blue_team AS team, league, year FROM v_games WHERE league IN (${marks})
           UNION ALL SELECT red_team AS team, league, year FROM v_games WHERE league IN (${marks})) played
     GROUP BY team, league`,
    [...leagues, ...leagues],
  );

  const currentName = new Map((await renamedTeams(db)).flatMap((r) => r.members.map((member) => [member, r.team] as const)));
  const byTeam = new Map<string, { top: number | null; topGames: number; lower: Map<string, number> }>();

  for (const row of rows) {
    const team = currentName.get(row.team) ?? row.team;
    const seen = byTeam.get(team) ?? { top: null, topGames: 0, lower: new Map<string, number>() };

    if (tiers.top.some((league) => league === row.league)) {
      seen.top = Math.min(seen.top ?? row.first_year, row.first_year);
      seen.topGames += row.games;
    } else {
      seen.lower.set(row.league, Math.min(seen.lower.get(row.league) ?? row.first_year, row.first_year));
    }

    byTeam.set(team, seen);
  }

  return [...byTeam]
    .flatMap(([team, seen]) => {
      const arrived = seen.top;

      if (arrived == null) return [];

      const earlier = [...seen.lower].flatMap(([league, year]) => (year < arrived ? [{ league, year }] : []));

      if (!earlier.some((e) => counted.some((league) => league === e.league))) return [];

      return [{ team, before: earlier.toSorted((a, b) => a.year - b.year), arrived, topGames: seen.topGames }];
    })
    .toSorted((a, b) => a.arrived - b.arrived || a.team.localeCompare(b.team));
}
