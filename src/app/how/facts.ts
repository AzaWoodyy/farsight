import { z } from "zod";
import { utcDay } from "@/lib/db/release";
import { LEAGUES } from "@/lib/domain/leagues";

/**
 * What `next.config.ts` reads from the database when the build starts and inlines as `process.env.HOW_FACTS`.
 * The page never opens the database itself: Next renders a prerendered page again, in its own function, for
 * the crawlers it does not stream to (Google's inspection tool, link previews), and that function does not
 * ship the database.
 */
const Inlined = z.object({
  built: z.string().nullable(),
  leagues: z.array(z.object({ league: z.string(), games: z.number(), ingame: z.number(), first_ingame: z.number().nullable() })),
});

export type LeagueCoverage = { name: string; short: string; games: number; ingame: number };

/** What the page states in figures, from the database the build ships so no count is typed in the text. */
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

export function readFacts(inlined = process.env.HOW_FACTS): Facts {
  if (!inlined) throw new Error("HOW_FACTS is empty: DATABASE_URL was not set when Next started. Set it (docs/postgres.md), then restart.");

  const { built, leagues: rows } = Inlined.parse(JSON.parse(inlined));
  const byName = new Map(rows.map((r) => [r.league, r]));
  const leagues = LEAGUES.map((l) => ({ name: l.name, short: l.short, games: byName.get(l.name)?.games ?? 0, ingame: byName.get(l.name)?.ingame ?? 0 }));
  const years = rows.flatMap((r) => r.first_ingame ?? []);

  return {
    releaseDay: utcDay(built),
    games: leagues.reduce((n, l) => n + l.games, 0),
    ingame: leagues.reduce((n, l) => n + l.ingame, 0),
    firstIngameYear: years.length ? Math.min(...years) : null,
    leagues,
  };
}
