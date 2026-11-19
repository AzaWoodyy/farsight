import { z } from "zod";
import { openDb, selectAll } from "@/lib/db";
import { dataReleaseDay } from "@/lib/db/release";
import { LEAGUES } from "@/lib/domain/leagues";

const Row = z.object({ league: z.string(), games: z.number(), ingame: z.number(), first_ingame: z.number().nullable() });

export type LeagueCoverage = { name: string; short: string; games: number; ingame: number };

/** What the page states in figures, read from the database the build ships so no count is typed in the text. */
export type Facts = {
  /** Day (UTC, `YYYY-MM-DD`) of the data release, null when the file records none. */
  releaseDay: string | null;
  games: number;
  ingame: number;
  /** First season with a Riot game file, null when there is none at all. */
  firstIngameYear: number | null;
  /** Every competition of the scope, in the order of `LEAGUES`. */
  leagues: LeagueCoverage[];
};

/** Read during prerendering: synchronous, so the page stays static and carries the figures of its own build. */
export function readFacts(db = openDb()): Facts {
  const rows = selectAll(
    db,
    Row,
    "SELECT league, SUM(games) AS games, SUM(ingame_games) AS ingame, MIN(CASE WHEN ingame_games > 0 THEN year END) AS first_ingame FROM v_ingame_coverage GROUP BY league",
  );

  const byName = new Map(rows.map((r) => [r.league, r]));
  const leagues = LEAGUES.map((l) => ({ name: l.name, short: l.short, games: byName.get(l.name)?.games ?? 0, ingame: byName.get(l.name)?.ingame ?? 0 }));
  const years = rows.flatMap((r) => r.first_ingame ?? []);

  return {
    releaseDay: dataReleaseDay(db),
    games: leagues.reduce((n, l) => n + l.games, 0),
    ingame: leagues.reduce((n, l) => n + l.ingame, 0),
    firstIngameYear: years.length ? Math.min(...years) : null,
    leagues,
  };
}
