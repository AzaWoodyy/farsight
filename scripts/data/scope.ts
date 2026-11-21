import { resolve } from "node:path";
import { z } from "zod";

export { SCHEMA_VERSION } from "../../src/lib/db/schema";

const ROOT = resolve(import.meta.dirname, "../..");
export const RAW_DIR = resolve(ROOT, "data/raw");

export const CARGO_CACHE_DIR = resolve(RAW_DIR, "cargo");

export const RIOT_CACHE_DIR = resolve(RAW_DIR, "riot");

export const INGAME_FILE = resolve(RAW_DIR, "ingame.jsonl");

export const DDRAGON_CACHE_DIR = resolve(RAW_DIR, "ddragon");

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
  "team_logo_files",
  "schedule",
  "ddragon",
  "riot_games",
  "runs",
] as const;

export type Dataset = (typeof DATASETS)[number];

export const datasetFile = (name: Dataset) => resolve(RAW_DIR, `${name}.json`);

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
  name: string;
  short: string;
  region: string;
  international: boolean;
};

export { LEAGUES } from "../../src/lib/domain/leagues";

export type Stage = "event" | "main_event" | "play_in" | "qualifier" | "season" | "playoffs";

export type Classification = {
  stage: Stage;
  eventPage: string;
};

const INTERNATIONAL_EVENT =
  /^(?:\d{4} Season World Championship|Season \d World Championship|\d{4} Mid-Season Invitational|\d{4} First Stand|Esports World Cup \d{4})$/;

const QUALIFIER = /Regional Finals|Qualif|Promotion|Relegation|LCQ|Placements|Road to /i;

export function classifyTournament(page: string, league: League): Classification | null {
  if (/Showmatch/i.test(page)) return null;

  if (league.international) {
    if (QUALIFIER.test(page)) return { stage: "qualifier", eventPage: page };
    const sub = /^(.*)\/(Main Event|Play-In)$/.exec(page);

    if (sub && INTERNATIONAL_EVENT.test(sub[1]))
      return { stage: sub[2] === "Play-In" ? "play_in" : "main_event", eventPage: sub[1] };

    if (INTERNATIONAL_EVENT.test(page)) return { stage: "main_event", eventPage: page };

    return { stage: "qualifier", eventPage: page };
  }

  const split = page.split("/").slice(1).join("/") || page;

  if (QUALIFIER.test(split)) return { stage: "qualifier", eventPage: page };

  if (/Play-In/i.test(split)) return { stage: "play_in", eventPage: page };

  if (/Main Event/i.test(split)) return { stage: "main_event", eventPage: page };

  if (/Playoffs|Finals|Regional Championship/i.test(split)) return { stage: "playoffs", eventPage: page };

  return { stage: "season", eventPage: page };
}
