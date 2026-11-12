/**
 * Shared configuration for `data:fetch` and `data:build`: paths, the fixed
 * league scope, and the tournament classifier.
 */
import { resolve } from "node:path";

export const SCHEMA_VERSION = 2;

const ROOT = resolve(import.meta.dirname, "../..");
export const RAW_DIR = resolve(ROOT, "data/raw");
/** One JSON file per raw Leaguepedia response, keyed by URL hash. */
export const CARGO_CACHE_DIR = resolve(RAW_DIR, "cargo");
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
  "ddragon",
  "runs",
] as const;
export type Dataset = (typeof DATASETS)[number];
export const datasetFile = (name: Dataset) => resolve(RAW_DIR, `${name}.json`);

export type League = {
  /** Leaguepedia `League` value. */
  name: string;
  short: string;
  region: string;
  international: boolean;
};

export const LEAGUES: League[] = [
  { name: "World Championship", short: "Worlds", region: "International", international: true },
  { name: "Mid-Season Invitational", short: "MSI", region: "International", international: true },
  { name: "LoL The Champions", short: "OGN Champions", region: "Korea", international: false },
  { name: "LoL Champions Korea", short: "LCK", region: "Korea", international: false },
  { name: "LCK Challengers League", short: "LCK CL", region: "Korea", international: false },
  { name: "Challengers Korea", short: "CK", region: "Korea", international: false },
  { name: "LCK Academy Series", short: "LCK AS", region: "Korea", international: false },
  { name: "Tencent LoL Pro League", short: "LPL", region: "China", international: false },
  { name: "Europe League Championship Series", short: "EU LCS", region: "Europe", international: false },
  { name: "LoL EMEA Championship", short: "LEC", region: "Europe", international: false },
  { name: "European Masters", short: "EU Masters", region: "Europe", international: false },
  { name: "EMEA Masters", short: "EMEA Masters", region: "Europe", international: false },
  { name: "North America League Championship Series", short: "NA LCS", region: "North America", international: false },
  { name: "League of Legends Championship Series", short: "LCS", region: "North America", international: false },
  { name: "League of Legends Championship of The Americas", short: "LTA", region: "Americas", international: false },
  { name: "League of Legends Championship of The Americas North", short: "LTA North", region: "North America", international: false },
  { name: "La Ligue Française", short: "LFL", region: "France", international: false },
  { name: "La Ligue Française Division 2", short: "LFL D2", region: "France", international: false },
  { name: "LVP SuperLiga 2nd Division", short: "SL 2nd Div", region: "Spain", international: false },
];

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
