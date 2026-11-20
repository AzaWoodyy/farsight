/**
 * Shared configuration for `data:fetch` and `data:build`: paths, the fixed
 * league scope, and the tournament classifier.
 */
import { resolve } from "node:path";
import { z } from "zod";

export { SCHEMA_VERSION } from "../../src/lib/db/schema";

const ROOT = resolve(import.meta.dirname, "../..");
export const RAW_DIR = resolve(ROOT, "data/raw");

/** One JSON file per raw Leaguepedia response, keyed by URL hash. */
export const CARGO_CACHE_DIR = resolve(RAW_DIR, "cargo");

/** Riot game JSON (stats + timeline), one gzip object per game: the local object store. */
export const RIOT_CACHE_DIR = resolve(RAW_DIR, "riot");

/** One line per game with Riot JSON: its in-game summary, or why there is none (append-only). */
export const INGAME_FILE = resolve(RAW_DIR, "ingame.jsonl");

/** One JSON file per Data Dragon response. */
export const DDRAGON_CACHE_DIR = resolve(RAW_DIR, "ddragon");
export const DB_FILE = resolve(ROOT, process.env.DATABASE_PATH || "data/lol.sqlite");

/** Consolidated datasets written by `data:fetch`, read by `data:build`. */
export const DATASETS = [
  "tournaments",
  "results",
  "games",
  "lines",
  "players",
  "redirects",
  "player_images",
  "teams",
  "team_redirects",
  "ddragon",
  "riot_games",
  "runs",
] as const;

export type Dataset = (typeof DATASETS)[number];

export const datasetFile = (name: Dataset) => resolve(RAW_DIR, `${name}.json`);

/** One entry of runs.json: a data:fetch run and the row counts it saved. */
export const IngestRun = z.object({
  kind: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  requests: z.number(),
  cached_responses: z.number(),
  row_counts: z.record(z.string(), z.number()),
});

export type IngestRun = z.infer<typeof IngestRun>;

export type League = {
  /** Leaguepedia `League` value. */
  name: string;
  short: string;
  region: string;
  international: boolean;
};

export { LEAGUES } from "../../src/lib/domain/leagues";

/**
 * What a tournament page is, read from its Leaguepedia page name. The Cargo
 * `IsQualifier` flag is unreliable (Worlds Play-In is flagged as a qualifier,
 * early regional finals are not), and regional qualifiers share the
 * `World Championship` league label, so the page name is the source of truth.
 *
 * - `event`: an international event page whose games live on sub-stages
 *   (2017+ Worlds/MSI); it holds the final standings only. Set by the build.
 * - `main_event`, `play_in`: stages of the international event itself (and of
 *   European/EMEA Masters).
 * - `qualifier`: regional finals, qualifying series, promotion, LCQ.
 * - `season`, `playoffs`: domestic league splits.
 */
export type Stage = "event" | "main_event" | "play_in" | "qualifier" | "season" | "playoffs";

export type Classification = {
  stage: Stage;
  /** Page holding the final standings (`TournamentResults`) for this stage. */
  eventPage: string;
};

const INTERNATIONAL_EVENT =
  /^(?:\d{4} Season World Championship|Season \d World Championship|\d{4} Mid-Season Invitational)$/;

const QUALIFIER = /Regional Finals|Qualif|Promotion|Relegation|LCQ|Placements|Road to /i;

/** Returns null for pages that are not competitive (showmatches). */
export function classifyTournament(page: string, league: League): Classification | null {
  if (/Showmatch/i.test(page)) return null;

  if (league.international) {
    if (QUALIFIER.test(page)) return { stage: "qualifier", eventPage: page };
    const sub = /^(.*)\/(Main Event|Play-In)$/.exec(page);

    if (sub && INTERNATIONAL_EVENT.test(sub[1]))
      return { stage: sub[2] === "Play-In" ? "play_in" : "main_event", eventPage: sub[1] };

    if (INTERNATIONAL_EVENT.test(page)) return { stage: "main_event", eventPage: page };

    // Anything else under an international label is not the event itself.
    return { stage: "qualifier", eventPage: page };
  }

  const split = page.split("/").slice(1).join("/") || page;

  if (QUALIFIER.test(split)) return { stage: "qualifier", eventPage: page };

  if (/Play-In/i.test(split)) return { stage: "play_in", eventPage: page };

  // European Masters / EMEA Masters split into Play-In and Main Event.
  if (/Main Event/i.test(split)) return { stage: "main_event", eventPage: page };

  if (/Playoffs|Finals|Regional Championship/i.test(split)) return { stage: "playoffs", eventPage: page };

  return { stage: "season", eventPage: page };
}
