import { ITEM_KINDS } from "../domain/items";
import { LEAGUES, leagueMembers } from "../domain/leagues";
import { YEAR_MIN } from "../domain/years";
import type { DatabaseSync } from "node:sqlite";
import { type StaticToolCall, tool } from "ai";
import { z } from "zod";
import { selectAll, selectOne, type SqlRow } from "../db";
import { DDRAGON_BASE, keystoneIcons } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { clock, type ParsedTimeline, type RiotTeam } from "../sources/timeline";
import { loadTimeline } from "../storage/timelines";
import { MAX_ROWS } from "./guard";
import {
  type ChampionItems,
  type ChampionPlayer,
  type ChampionPool,
  type ChampionPoolLine,
  type ChampionProfile,
  type Entities,
  type GameScoreboard,
  LEAGUE_NAMES,
  type PlayerProfile,
  type ResultRow,
  type ScoreboardPlayer,
  type ScoreboardTeam,
  type Side,
  type Source,
  type SeriesDetail,
  type SeriesList,
  type SeriesGame,
  type SeriesPick,
  type TableCell,
  type TeamHeadToHead,
  type TeamRoster,
  type RosterPlayer,
  type TeamSeries,
  type TimelineView,
  type TraceStatus,
  type VersusGame,
  type VersusView,
} from "./types";
import { renamedTeams, resolveChampion, resolvePlayer, resolveTeam } from "./understand";
import {
  PLAYER_METRIC_DEFS,
  PLAYER_METRICS,
  type PlayerMetric,
  TEAM_METRIC_DEFS,
  TEAM_METRICS,
  type TeamMetric,
  metricColumn,
  metricLabel,
} from "./metrics";

/**
 * Typed tools: one parameterized query per frequent intent, each with a zod
 * input schema (shared with the LLM router through AI SDK `tool()`), its own
 * deterministic corrections and its own formatting. Every query still goes
 * through the schema guard before it runs.
 */

/**
 * Stages that belong to the competition itself. Regional qualifiers share the
 * `World Championship` / `Mid-Season Invitational` league label on
 * Leaguepedia, and `event` pages only hold standings, so both are excluded.
 */
const COMPETITION_STAGES = "'main_event', 'play_in', 'season', 'playoffs'";

/** Pages that carry final standings. */
const STANDINGS_STAGES = "'event', 'main_event', 'season', 'playoffs'";

/**
 * A `season` page that crowns nobody (`t` is v_tournaments): no knockout tab, and either playoffs of the same split,
 * or week-by-week league play in a year where another page of the league holds the final.
 * "Rounds 1-2" of the LCK is one; the LCK Cup, stored as a season too, is not.
 */
const regularSeason = (t: string) =>
  `(${t}.stage = 'season'
    AND NOT EXISTS (SELECT 1 FROM v_games f WHERE f.tournament_page = ${t}.tournament_page AND f.tab LIKE '%final%')
    AND (EXISTS (SELECT 1 FROM v_tournaments p WHERE p.league = ${t}.league AND p.year = ${t}.year AND p.stage = 'playoffs' AND COALESCE(p.split, '') = COALESCE(${t}.split, ''))
      OR (EXISTS (SELECT 1 FROM v_games w WHERE w.tournament_page = ${t}.tournament_page AND w.tab LIKE 'Week %')
        AND EXISTS (SELECT 1 FROM v_tournaments p WHERE p.league = ${t}.league AND p.year = ${t}.year AND p.tournament_page <> ${t}.tournament_page
              AND (p.stage = 'playoffs' OR (p.stage = 'season' AND EXISTS (SELECT 1 FROM v_games f WHERE f.tournament_page = p.tournament_page AND f.tab LIKE '%final%')))))))`;

const League = z.enum(LEAGUE_NAMES).describe("Leaguepedia League value. Worlds = World Championship, LCK = LoL Champions Korea.");
const Year = z.number().int().min(YEAR_MIN).nullable();
const Period = { yearFrom: Year.describe("First season (inclusive), null for all"), yearTo: Year.describe("Last season (inclusive), null for all") };

export const MAP_SIDES = ["blue", "red"] as const;

export type MapSide = (typeof MAP_SIDES)[number];

const MapSideInput = z.enum(MAP_SIDES).nullable().describe("Only the games played on this side of the map ('côté bleu', 'red side'), null for both sides");

export const PlayerHistoryInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page (Chovy, Faker, 정지훈...)"),
  league: League,
  ...Period,
});

export const TeamHistoryInput = z.object({
  team: z.string().min(1).describe("Team name or shorthand (T1, Gen.G, G2...)"),
  league: League.nullable().describe("Restrict to one competition, null for all"),
  ...Period,
});

export const TeamRosterInput = z.object({
  team: z.string().min(1).describe("Team name or shorthand (Samsung White, SKT, G2...)"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable().describe("Restrict to one split of the season, null for the whole season"),
  role: z.enum(["Top", "Jungle", "Mid", "Bot", "Support"]).nullable().describe("The role the question asks about (an ADC is Bot), answered first; the whole roster is still shown. null when none"),
});

export const HeadToHeadInput = z.object({
  // Two players go to player_comparison, which also lists their games against each other.
  kind: z.enum(["team"]),
  sideA: z.string().min(1),
  sideB: z.string().min(1),
  league: League.nullable(),
  ...Period,
});

export const PlayerComparisonInput = z.object({
  playerA: z.string().min(1).describe("First player's handle or Leaguepedia page"),
  playerB: z.string().min(1).describe("Second player's handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
});

export const ChampionStatsInput = z.object({
  champion: z.string().min(1).describe("Champion name (Ahri, Lee Sin, Kai'Sa...)"),
  league: League,
  ...Period,
});

/** The per-game averages a champion ranking can sort by: end-of-game figures of v_game_players. */
export const CHAMPION_AVERAGE_SORTS = ["kills", "deaths", "assists", "gold", "cs", "damage", "vision"] as const;

export type ChampionAverageSort = (typeof CHAMPION_AVERAGE_SORTS)[number];

/**
 * Figures of the picks a champion ranking shows beside picks, bans, presence, win rate and KDA, and can sort by:
 * per-minute figures of the end-of-game stats, then lane figures from the Riot game data (absent in the LPL), then
 * how many different players picked the champion.
 */
export const CHAMPION_EXTRA_SORTS = ["dpm", "gpm", "cspm", "gold_diff_15", "cs_diff_15", "xp_diff_15", "first_blood", "solo_kills", "players"] as const;

export type ChampionExtraSort = (typeof CHAMPION_EXTRA_SORTS)[number];

/** Multikills of the Riot game data: rare enough that only their total over the scope means something. */
export const CHAMPION_MULTIKILL_SORTS = ["penta_kills", "quadra_kills", "triple_kills", "double_kills"] as const;

export type ChampionMultikillSort = (typeof CHAMPION_MULTIKILL_SORTS)[number];

export const CHAMPION_SORTS = ["picks", "bans", "presence", "winrate", "kda", ...CHAMPION_AVERAGE_SORTS, ...CHAMPION_EXTRA_SORTS, ...CHAMPION_MULTIKILL_SORTS] as const;

/** The sorts a ranking can order by their total over the scope instead of a per-game figure: the counts and sums of a pick. */
export const CHAMPION_TOTAL_SORTS = [...CHAMPION_AVERAGE_SORTS, "solo_kills", "first_blood", ...CHAMPION_MULTIKILL_SORTS] as const;

export type ChampionTotalSort = (typeof CHAMPION_TOTAL_SORTS)[number];

export type ChampionSort = (typeof CHAMPION_SORTS)[number];

export const ChampionRankingInput = z.object({
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  sort: z
    .enum(CHAMPION_SORTS)
    .describe(
      "Ranking order: picks (most played), bans (most banned), presence (picks + bans share of games), winrate, kda, " +
        "a per-game average (kills, deaths, assists, gold, cs, damage, vision), a per-minute figure (dpm damage, gpm gold, cspm CS), " +
        "a lane figure from the Riot game data (gold_diff_15, cs_diff_15, xp_diff_15 against the lane opponent at 15 min, first_blood share of games " +
        "with the first blood kill, solo_kills per game), a multikill count from the Riot game data (penta_kills, quadra_kills, triple_kills, " +
        "double_kills, always a total) or players (how many different players picked it), highest first; " +
        "all but picks, bans, presence and totals need a minimum of picks",
    ),
  total: z
    .boolean()
    .nullable()
    .describe(
      "true: order by the total over the scope instead of the per-game figure ('le plus de morts' without 'par partie', 'le plus de pentakills'), " +
        "for kills, deaths, assists, gold, cs, damage, vision, solo_kills, first_blood (number of first bloods) and the multikills; " +
        "null or false for the per-game figure",
    ),
  role: z.enum(["Top", "Jungle", "Mid", "Bot", "Support"]).nullable().describe("Only the picks played in this role, null for every role"),
  side: MapSideInput,
  minPicks: z
    .number()
    .int()
    .min(1)
    .max(200)
    .nullable()
    .describe("Minimum picks (games on the champion: 'plus de 4 parties' is 5) for winrate, kda, per-game and total rankings, null for the default (none for a total)"),
});

export type ChampionRankingInput = z.infer<typeof ChampionRankingInput>;

export const ChampionPoolInput = z.object({
  subject: z.enum(["player", "team"]).describe("Whose pool: one player's champions, or every champion a team's players picked"),
  name: z.string().min(1).describe("Player handle or Leaguepedia page (Faker, Chovy...), or team name (T1, G2...)"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable().describe("Restrict to one split of the season, null for the whole season"),
});

export type ChampionPoolInput = z.infer<typeof ChampionPoolInput>;

export const PLAYER_CRITERIA = ["kda", "winrate", "games", "kills", "assists", "kp", "dmg_share", "gold_share", "dpm", "cspm", "gpm", "vspm"] as const;

export type PlayerCriterion = (typeof PLAYER_CRITERIA)[number];

export const PlayerLeaderboardInput = z.object({
  role: z.enum(["Top", "Jungle", "Mid", "Bot", "Support"]).nullable().describe("Players of one role only (an ADC is Bot), null for every role"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  criterion: z
    .enum(PLAYER_CRITERIA)
    .describe(
      "What 'best' means: kda (default), winrate, games (most games), kills or assists (totals), kp (kill participation), " +
        "dmg_share (share of the team's damage to champions), gold_share (share of the team's gold), " +
        "dpm (damage per minute), cspm (CS per minute), gpm (gold per minute), vspm (vision score per minute)",
    ),
  minGames: z.number().int().min(1).max(200).nullable().describe("Minimum games to be ranked, null for the default"),
  side: MapSideInput,
});

export type PlayerLeaderboardInput = z.infer<typeof PlayerLeaderboardInput>;

export const StandingsInput = z.object({
  league: League,
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable(),
  full: z.boolean().describe("true: every placement of the event(s); false: champion and finalist of each event"),
});

const MinuteInput = z
  .union([z.literal(10), z.literal(15), z.literal(20)])
  .nullable()
  .describe("Minute of the snapshot for gold/CS/XP metrics (10, 15 or 20), null for 15");

const ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"] as const;

export const PlayerIngameInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition with in-game data"),
  ...Period,
  metric: z.enum(PLAYER_METRICS).nullable().describe("The metric the question is about, shown first; null for the overview"),
  minute: MinuteInput,
});

export const LeaderboardInput = z.object({
  subject: z.enum(["player", "team"]),
  metric: z.enum([...new Set([...PLAYER_METRICS, ...TEAM_METRICS])]).describe(
    "Player metrics: solo_kills, penta_kills, quadra_kills, triple_kills, double_kills, first_bloods, kills_before_10, gold_diff, cs_diff, xp_diff, gold, cs, xp, wards_placed, wards_killed, control_wards, plates. " +
      "Team metrics: first_blood, first_tower, first_dragon, first_herald, first_baron, gold_diff, kills_before_10, plates.",
  ),
  minute: MinuteInput,
  league: League.nullable(),
  ...Period,
  role: z.enum(ROLES).nullable().describe("Players of one role only"),
  minGames: z.number().int().min(1).max(200).nullable().describe("Minimum games for averages and rates, null for the default"),
  side: MapSideInput,
});

export const TEAM_CRITERIA = [
  "winrate", "games", "blue_winrate", "red_winrate", "kda", "kills", "deaths", "game_length", "champions",
  "dragons", "barons", "towers", "heralds", "void_grubs", "first_dragon", "first_herald", "first_baron", "gold_diff_15",
] as const;

export type TeamCriterion = (typeof TEAM_CRITERIA)[number];

export const TeamLeaderboardInput = z.object({
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  criterion: z
    .enum(TEAM_CRITERIA)
    .describe(
      "What the teams are ranked on: winrate (default), games, blue_winrate or red_winrate (win rate on one side), kda, kills or deaths per game, " +
        "game_length (average game duration in minutes), champions (distinct champions picked), dragons, barons, towers, heralds or void_grubs per game, " +
        "first_dragon, first_herald or first_baron (share of games, Riot game data), gold_diff_15 (team gold difference at 15 min, Riot game data)",
    ),
  order: z.enum(["desc", "asc"]).describe("desc: highest first (default); asc: lowest first ('shortest games', 'fewest deaths')"),
  side: MapSideInput,
  minGames: z.number().int().min(1).max(200).nullable().describe("Minimum games to be ranked, null for the default"),
});

export type TeamLeaderboardInput = z.infer<typeof TeamLeaderboardInput>;

export const ChampionMatchupInput = z.object({
  champion: z.string().min(1).describe("The champion the question is about (Azir, Lee Sin...)"),
  opponent: z.string().min(1).nullable().describe("The champion it faces in the same role, null to list every champion it faced"),
  role: z.enum(ROLES).nullable().describe("Only the games where both are played in this role, null for every role"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
});

export type ChampionMatchupInput = z.infer<typeof ChampionMatchupInput>;

/** What a single-game record is counted on: end-of-game figures, then lane figures from the Riot game data. */
export const RECORD_METRICS = ["kills", "deaths", "assists", "damage", "cs", "gold", "vision", "gold_diff_15", "cs_diff_15", "solo_kills"] as const;

export type RecordMetric = (typeof RECORD_METRICS)[number];

export const GameRecordsInput = z.object({
  metric: z
    .enum(RECORD_METRICS)
    .describe(
      "The figure of one game: kills, deaths, assists, damage (to champions), cs, gold, vision (score), " +
        "gold_diff_15 or cs_diff_15 (against the lane opponent at 15 min, Riot game data), solo_kills (Riot game data)",
    ),
  player: z.string().min(1).nullable().describe("One player's best games only, null for every player"),
  role: z.enum(ROLES).nullable().describe("Players of one role only, null for every role"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
});

export type GameRecordsInput = z.infer<typeof GameRecordsInput>;

export const PlayerRecentInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  count: z.number().int().min(3).max(20).nullable().describe("How many of the latest games (\"last 5 games\" = 5), null for 10"),
});

export type PlayerRecentInput = z.infer<typeof PlayerRecentInput>;

export const TeamIngameInput = z.object({
  team: z.string().min(1).describe("Team name or shorthand (T1, Gen.G, G2...)"),
  league: League.nullable(),
  ...Period,
  minute: MinuteInput,
});

export const GAME_PHASES = ["final", "semifinal", "quarterfinal", "third_place", "groups", "play_in"] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export const GameTimelineInput = z.object({
  teamA: z.string().min(1).nullable().describe("One team of the game (T1, Gen.G...), null when the question names none"),
  teamB: z.string().min(1).nullable().describe("The other team, null when the question names one team or none"),
  league: League.nullable(),
  year: Year.describe("Season of the game, null when not given"),
  phase: z.enum(GAME_PHASES).nullable().describe("Stage of the series (final, semifinal...), null when not given"),
  game: z.number().int().min(1).max(5).nullable().describe("Game number in the series (\"game 3\" = 3), null when not given"),
});

export type GameTimelineInput = z.infer<typeof GameTimelineInput>;

export const SeriesInput = z.object({
  teamA: z.string().min(1).nullable().describe("One team of the series (T1, Gen.G...), null when the question names none"),
  teamB: z.string().min(1).nullable().describe("The other team, null when the question names one team or none"),
  league: League.nullable(),
  ...Period,
  phase: z.enum(GAME_PHASES).nullable().describe("Stage of the series (final, semifinal, quarterfinal...), null for every series of the teams"),
  split: z.enum(["Spring", "Summer", "Winter"]).nullable().describe("Split of the season (LCK summer final...), null when not given"),
});

export type SeriesInput = z.infer<typeof SeriesInput>;

export type PlayerIngameInput = z.infer<typeof PlayerIngameInput>;

export type LeaderboardInput = z.infer<typeof LeaderboardInput>;

export type TeamIngameInput = z.infer<typeof TeamIngameInput>;

export type PlayerHistoryInput = z.infer<typeof PlayerHistoryInput>;

export type TeamHistoryInput = z.infer<typeof TeamHistoryInput>;

export type TeamRosterInput = z.infer<typeof TeamRosterInput>;

export type HeadToHeadInput = z.infer<typeof HeadToHeadInput>;

export type PlayerComparisonInput = z.infer<typeof PlayerComparisonInput>;

export type ChampionStatsInput = z.infer<typeof ChampionStatsInput>;

export type StandingsInput = z.infer<typeof StandingsInput>;

/** A typed tool with its input, as decided by the router (rules or LLM). */
export type ToolName = keyof typeof TOOLS;

export type ToolCall = { [K in ToolName]: { tool: K; input: z.infer<(typeof TOOLS)[K]["input"]> } }[ToolName];

export type ToolInput = ToolCall["input"];

type Params = Record<string, string | number>;

type Plan = { sql: string; params: Params };

type Relaxation<I> = { key: string; input: I; note: string; reason: string };

/** A line a tool adds to the trace while formatting (a timeline read from storage...). */
export type ToolTrace = { status: TraceStatus; title: string; detail?: string };

export type ToolOutput = {
  title: string;
  rows?: ResultRow[];
  table?: { columns: string[]; rows: TableCell[][] };
  timeline?: TimelineView;
  scoreboard?: GameScoreboard;
  versus?: VersusView;
  teams?: TeamHeadToHead;
  roster?: TeamRoster;
  champion?: ChampionProfile;
  pool?: ChampionPool;
  series?: SeriesList;
  /** Champion name → icon of every champion the table names. */
  icons?: Record<string, string>;
  trace?: ToolTrace[];
  /** Notes shown under the answer (the game shown when several match...). */
  notes?: string[];
  facts: string;
  sources: Source[];
  followUps: string[];
  totals: Record<string, string | number>;
};

type ToolDef<I> = {
  name: string;
  /** French label, shown in the trace. */
  label: string;
  description: string;
  plan: (db: DatabaseSync, input: I) => Plan;
  /** Deterministic corrections when the result is empty, most conservative first. */
  relaxations: (input: I, entities: Entities) => Relaxation<I>[];
  format: (db: DatabaseSync, input: I, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
  /** Maps names written by the LLM onto database names. */
  normalize: (db: DatabaseSync, input: I) => I | null;
};

/** A tool bound to its input: the plan to run, its corrections and its formatting. */
export type BoundTool = {
  call: ToolCall;
  label: string;
  sql: string;
  params: Params;
  relaxations: (entities: Entities) => { key: string; note: string; reason: string; next: () => BoundTool }[];
  format: (db: DatabaseSync, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
};

// Helpers -------------------------------------------------------------------------

function inList(prefix: string, values: string[], params: Params): string {
  return values
    .map((v, i) => {
      params[`${prefix}${i}`] = v;

      return `:${prefix}${i}`;
    })
    .join(", ");
}

type Period = { yearFrom: number | null; yearTo: number | null };

function leagueFilter(column: string, input: { league: string | null; yearFrom?: number | null; yearTo?: number | null; year?: number | null }, params: Params): string {
  const members = leagueMembers(input.league!, input.yearFrom ?? input.year ?? null, input.yearTo ?? input.year ?? null);

  return `${column} IN (${inList("league", members, params)})`;
}

function periodFilter(col: string, input: Period, params: Params): string {
  const parts: string[] = [];

  if (input.yearFrom != null) {
    parts.push(`AND ${col} >= :yearFrom`);
    params.yearFrom = input.yearFrom;
  }

  if (input.yearTo != null) {
    parts.push(`AND ${col} <= :yearTo`);
    params.yearTo = input.yearTo;
  }

  return parts.join(" ");
}

/** Games that count in a competition scope: its stages, the league when one is asked, the period, a role when ranked by role. */
function competitionScope(alias: string, input: { league: string | null; role?: string | null; side?: MapSide | null } & Period, params: Params): string {
  const league = input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "";
  const role = input.role ? `AND ${alias}.role = :role` : "";
  const side = input.side ? `AND ${alias}.side = ${SIDE_ID[input.side]}` : "";

  if (input.role) params.role = input.role;

  return `${alias}.stage IN (${COMPETITION_STAGES}) ${league} ${role} ${side} ${periodFilter(`${alias}.year`, input, params)}`;
}

/** `side` as the tables store it. */
const SIDE_ID: Record<MapSide, number> = { blue: 1, red: 2 };

/** " côté bleu", or nothing when both sides count. */
const sideLabel = (side: MapSide | null) => (side ? ` côté ${side === "blue" ? "bleu" : "rouge"}` : "");

/** The league and period of an input, without the role its own tool filters on. */
const leagueAndPeriod = (input: { league: string | null } & Period) => ({ league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

/** A JSON text column (json_group_array...) parsed with its own schema. */
const jsonColumn = <S extends z.ZodType>(schema: S) => z.string().transform((text) => schema.parse(JSON.parse(text)));

/** SQLite integers come back as numbers; a missing year sorts first. */
const YearColumn = z.number().catch(0);

const PlayerCounts = z.array(z.object({ player: z.string(), games: z.number() }));

const tidy = (sql: string) => sql.replace(/\n\s*\n/g, "\n");
const hasPeriod = (i: Period) => i.yearFrom != null || i.yearTo != null;

const noPeriod = <I extends Period>(input: I, what: string): Relaxation<I> => ({
  key: "period",
  input: { ...input, yearFrom: null, yearTo: null },
  note: `Rien entre ${input.yearFrom ?? "…"} et ${input.yearTo ?? "…"} : affichage de ${what}.`,
  reason: "filtre de période retiré",
});

export const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");
const pct = (w: number, n: number) => Math.round((100 * w) / Math.max(1, n));
const span = (years: number[]) => (years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "");

export function placeLabel(place: string | null, isRegularSeason = false): string {
  if (!place) return "Classement non publié";

  // Regular-season standings are not a title.
  if (isRegularSeason) return place === "1" ? "1er de la saison régulière" : `${place}e de la saison régulière`;

  if (place === "1") return "Champion";

  if (place === "2") return "Finaliste";

  if (place === "3-4") return "Demi-finale";

  if (place === "5-8") return "Quart de finale";

  return `Éliminé (${place}e)`;
}

function leagueShortName(db: DatabaseSync, league: string | null): string {
  if (!league) return "toutes compétitions";

  return selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league])?.short_name ?? league;
}

const inLeague = (short: string) => (short === "Worlds" ? "aux Worlds" : short === "MSI" ? "au MSI" : short === "toutes compétitions" ? "" : `en ${short}`);

function eventSources(pages: string[], max = 12): Source[] {
  const unique = [...new Set(pages)];

  return unique.slice(-max).map((page) => ({ label: `Leaguepedia — ${page}`, url: wikiUrl(page) }));
}

function teamMembers(db: DatabaseSync, team: string): { team: string; members: string[] } {
  const t = resolveTeam(db, team);

  return t ? { team: t.team, members: t.members } : { team, members: [team] };
}

/** SQL for a team name with a franchise's former names folded into its current one. */
function franchiseName(db: DatabaseSync, column: string, params: Params): string {
  const whens = renamedTeams(db).map((f, i) => {
    params[`fr${i}`] = f.team;

    return `WHEN ${column} IN (${inList(`fr${i}_`, f.members, params)}) THEN :fr${i}`;
  });

  return whens.length ? `CASE ${whens.join(" ")} ELSE ${column} END` : column;
}

// Result rows, as each tool's query returns them ----------------------------------------

const Text = z.string();
const NullableText = z.string().nullable();

/** Pages listed in a json_group_array column. */
const pageList = z.string().nullable().transform((v) => (v ? z.array(z.string()).parse(JSON.parse(v)) : []));

const PlayerHistoryRow = z.object({
  year: YearColumn,
  event_page: Text,
  team: Text,
  stage: NullableText,
  wins: z.number(),
  losses: z.number(),
  place: NullableText,
  place_number: z.number().nullable(),
  regular_season: z.number(),
  champions: jsonColumn(
    z.array(z.object({ name: z.string(), games: z.number(), wins: z.number(), icon: z.string().nullable() })),
  ),
});

const TeamHistoryRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  stage: NullableText,
  tournament: NullableText,
  team: Text,
  wins: z.number(),
  losses: z.number(),
  place: NullableText,
  place_number: z.number().nullable(),
  regular_season: z.number(),
});

const HeadToHeadRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  tournament: NullableText,
  wins_a: z.number(),
  wins_b: z.number(),
});

const ChampionStatsRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  tournament: NullableText,
  games: z.number(),
  scope_games: z.number(),
  scope_from: z.number().nullable(),
  scope_to: z.number().nullable(),
  picks: z.number(),
  wins: z.number(),
  bans: z.number(),
  players: jsonColumn(PlayerCounts),
});

const StandingsRow = z.object({
  year: YearColumn,
  event_page: Text,
  tournament: NullableText,
  stage: NullableText,
  place: NullableText,
  place_number: z.number().nullable(),
  team: Text,
  prize_usd: z.number().nullable(),
});

// 1. Player history in a competition ------------------------------------------------

const playerEventHistory: ToolDef<PlayerHistoryInput> = {
  name: "player_event_history",
  label: "historique joueur × compétition",
  description:
    "A player's results in one competition, edition by edition: team, final place, game record (W-L) and champions played.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const period = periodFilter("gp.year", input, params);

    return {
      params,
      sql: tidy(`WITH player_games AS (
  SELECT gp.year, gp.event_page, gp.stage, gp.team, gp.champion, gp.win, gp.played_at
  FROM v_game_players gp
  WHERE gp.player = :player
    AND ${leagueFilter("gp.league", input, params)}
    AND gp.stage IN (${COMPETITION_STAGES})
    ${period}
),
champ_counts AS (
  SELECT event_page, team, champion, COUNT(*) AS games, SUM(win) AS wins
  FROM player_games
  GROUP BY event_page, team, champion
)
SELECT pg.year, pg.event_page, pg.team, MIN(pg.stage) AS stage,
       SUM(pg.win) AS wins,
       COUNT(*) - SUM(pg.win) AS losses,
       tr.place, tr.place_number,
       MAX(CASE WHEN ${regularSeason("t")} THEN 1 ELSE 0 END) AS regular_season,
       (SELECT json_group_array(json_object('name', c.champion, 'games', c.games, 'wins', c.wins,
                                            'icon', ch.icon_url)
                ORDER BY c.games DESC, c.wins DESC, c.champion)
          FROM champ_counts c LEFT JOIN champions ch ON ch.name = c.champion
         WHERE c.event_page = pg.event_page AND c.team = pg.team) AS champions
FROM player_games pg
LEFT JOIN v_tournament_results tr
  ON tr.event_page = pg.event_page AND tr.team = pg.team
LEFT JOIN v_tournaments t ON t.tournament_page = pg.event_page
GROUP BY pg.year, pg.event_page, pg.team
ORDER BY pg.year, MIN(pg.played_at), pg.event_page`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les éditions"));
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({
          key: `player:${other}`,
          input: { ...input, player: other },
          note: `« ${resolved!.mention} » désigne aussi ${other} : résultats de ${other}.`,
          reason: `alias homonyme essayé : ${other}`,
        });

    return out;
  },
  format: (db, input, raw): ToolOutput => {
    const league = leagueShortName(db, input.league);

    const rows: ResultRow[] = z.array(PlayerHistoryRow).parse(raw).map((r) => ({
      year: r.year,
      event: r.event_page,
      team: r.team,
      place: r.place,
      placeLabel: placeLabel(r.place, r.regular_season === 1),
      // Regular-season ranks do not compete with final placements.
      placeNumber: r.regular_season === 1 ? null : r.place_number,
      wins: r.wins,
      losses: r.losses,
      champions: r.champions.map(({ icon, ...c }) => ({ ...c, imageUrl: icon })),
    }));

    const wins = rows.reduce((n, r) => n + r.wins, 0);
    const losses = rows.reduce((n, r) => n + r.losses, 0);
    const teams = [...new Set(rows.map((r) => displayTeam(r.team)))];
    const ranked = rows.filter((r) => r.placeNumber != null);
    const best = ranked.length ? Math.min(...ranked.map((r) => r.placeNumber!)) : null;
    const bestRows = ranked.filter((r) => r.placeNumber === best);
    const unranked = rows.filter((r) => r.place == null);
    const titles = rows.filter((r) => r.placeNumber === 1).length;
    const events = new Set(rows.map((r) => r.event)).size;

    // One page per year is an edition (Worlds, MSI); a league's year holds several tournaments (seasons, playoffs, cups).
    const perYear = new Set(rows.map((r) => r.year)).size === events;
    const what = perYear ? "éditions" : "tournois";

    let facts =
      `${input.player} a disputé ${events} ${what} ${league === "Worlds" ? "des Worlds" : `de ${league}`} (${span(rows.map((r) => r.year))}) ` +
      `avec ${teams.length} équipe${teams.length > 1 ? "s" : ""} (${teams.join(", ")}), ` +
      `pour un bilan de ${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %).`;

    if (bestRows.length)
      facts += ` Meilleur résultat : ${placeLabel(bestRows[0].place).toLowerCase()} en ${bestRows
        .map((r) => `${r.year} (${displayTeam(r.team)})`)
        .join(", ")}.`;

    if (unranked.length) facts += ` Classement final ${unranked.map((r) => r.year).join(", ")} pas encore publié sur Leaguepedia.`;

    // Follow-ups stay within what the agent supports: teammates of the latest run.
    const latest = rows[rows.length - 1];

    const teammates = selectAll(
      db,
      z.object({ player: z.string() }),
      `SELECT player, COUNT(*) AS n FROM v_game_players
       WHERE event_page = ? AND team = ? AND player <> ? AND stage <> 'qualifier'
       GROUP BY player ORDER BY n DESC LIMIT 2`,
      [latest.event, latest.team, input.player],
    ).map((r) => r.player);

    return {
      title: `${input.player} — ${league}`,
      rows,
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(rows.map((r) => r.event), 30),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: [
        `${input.player} ${inLeague(league)} ${bestRows[0]?.year ?? latest.year}`,
        ...teammates.map((m) => `Résultats de ${m} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`),
      ],
      totals: { events, wins, losses, titles, best_place: bestRows[0]?.place ?? "" },
    };
  },
  normalize: (db, input) => {
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// 2. Team history -------------------------------------------------------------------

const teamHistory: ToolDef<TeamHistoryInput> = {
  name: "team_history",
  label: "historique d'équipe",
  description:
    "A team's history tournament by tournament (all competitions or one): final place and game record. Renamed teams are merged (SK Telecom T1 → T1).",
  plan: (db, input) => {
    const { members } = teamMembers(db, input.team);
    const params: Params = {};
    const t = inList("t", members, params);
    let league = "";

    if (input.league) {
      league = `AND ${leagueFilter("g.league", input, params)}`;

    }

    return {
      params,
      sql: tidy(`WITH team_games AS (
  SELECT g.year, g.league_short, g.event_page, g.stage, g.tournament, g.played_at,
         CASE WHEN g.blue_team IN (${t}) THEN g.blue_team ELSE g.red_team END AS team,
         CASE WHEN g.winner IN (${t}) THEN 1 ELSE 0 END AS win
  FROM v_games g
  WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t}))
    AND g.stage IN (${COMPETITION_STAGES})
    ${league}
    ${periodFilter("g.year", input, params)}
)
SELECT tg.year, tg.league_short, tg.event_page, MIN(tg.stage) AS stage,
       COALESCE(tr.tournament, MIN(tg.tournament)) AS tournament, tg.team,
       SUM(tg.win) AS wins, COUNT(*) - SUM(tg.win) AS losses,
       tr.place, tr.place_number,
       MAX(CASE WHEN ${regularSeason("t")} THEN 1 ELSE 0 END) AS regular_season
FROM team_games tg
LEFT JOIN v_tournament_results tr ON tr.event_page = tg.event_page AND tr.team = tg.team
LEFT JOIN v_tournaments t ON t.tournament_page = tg.event_page
GROUP BY tg.year, tg.event_page, tg.team
ORDER BY tg.year, MIN(tg.played_at), tg.event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toute son histoire"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: `Aucune partie de ${input.team} dans cette compétition : affichage de toutes les compétitions.`,
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(TeamHistoryRow).parse(sqlRows);
    const { team, members } = teamMembers(db, input.team);
    const league = leagueShortName(db, input.league);
    const wins = raw.reduce((n, r) => n + Number(r.wins), 0);
    const losses = raw.reduce((n, r) => n + Number(r.losses), 0);
    const titles = raw.filter((r) => r.place === "1" && r.regular_season !== 1);
    const leagues = [...new Set(raw.map((r) => String(r.league_short)))];
    const names = [...new Set(raw.map((r) => String(r.team)))];
    const intl = titles.filter((r) => r.league_short === "Worlds" || r.league_short === "MSI");

    let facts =
      `${team} : ${raw.length} tournois ${inLeague(league) || `(${leagues.join(", ")})`} entre ${span(raw.map((r) => Number(r.year))).replace("–", " et ")}, ` +
      `${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %). ` +
      `${titles.length} titre${titles.length > 1 ? "s" : ""}`;

    if (intl.length) facts += `, dont ${intl.map((r) => r.tournament ?? r.event_page).join(", ")}`;
    facts += ".";

    if (names.length > 1) facts += ` Noms pris en compte : ${names.map(displayTeam).join(", ")}.`;

    return {
      title: `${team} — ${league === "toutes compétitions" ? "historique" : league}`,
      table: {
        columns: ["Année", "Compétition", "Tournoi", ...(names.length > 1 ? ["Équipe"] : []), "Place", "V-D", "%"],
        rows: raw.map((r) => [
          r.year,
          r.league_short,
          r.tournament ?? r.event_page,
          ...(names.length > 1 ? [displayTeam(r.team)] : []),
          r.place ? `${placeLabel(r.place, r.regular_season === 1)} (${r.place})` : placeLabel(null),
          `${r.wins}-${r.losses}`,
          pct(r.wins, r.wins + r.losses),
        ]),
      },
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources([...titles.map((r) => String(r.event_page)), ...raw.slice(-8).map((r) => String(r.event_page))], 20),
      ],
      followUps: [
        input.league ? `Historique de ${team}` : `${team} aux Worlds`,
        `Palmarès ${league === "toutes compétitions" ? "des Worlds" : league}`,
      ],
      totals: { events: raw.length, wins, losses, titles: titles.length },
    };
  },
  normalize: (db, input) => {
    const t = resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

// 2b. Team roster ---------------------------------------------------------------------

const RosterEvent = z.object({ event: z.string(), tournament: z.string().nullable(), team: z.string(), games: z.number(), at: z.number().nullable() });

const RosterRow = z.object({
  player: Text,
  role: Text,
  games: z.number(),
  wins: z.number(),
  first_played: z.number().nullable(),
  last_played: z.number().nullable(),
  events: jsonColumn(z.array(RosterEvent)),
});

const RosterTournamentRow = z.object({ event_page: Text, tournament: NullableText, games: z.number(), wins: z.number(), at: z.number().nullable() });

/** Roles in roster order; a role the database does not know sorts last. */
const roleRank = (role: string) => {
  const i = ROLE_ORDER.indexOf(role);

  return i < 0 ? ROLE_ORDER.length : i;
};

/** A split of the season ("Spring 2018"): the tournament pages of that split. */
function splitFilter(column: string, input: { split: string | null }, params: Params): string {
  if (!input.split) return "";
  params.split = input.split;

  return `AND ${column} IN (SELECT s.tournament_page FROM v_tournaments s WHERE s.split = :split)`;
}

/** The roster's filters on v_game_players (`gp`): the team's names, the competition stages, the league, the period and the split. */
function rosterScope(db: DatabaseSync, input: TeamRosterInput, params: Params): string {
  const t = inList("t", teamMembers(db, input.team).members, params);
  const league = input.league ? `AND ${leagueFilter("gp.league", input, params)}` : "";

  return `gp.team IN (${t}) AND gp.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("gp.year", input, params)} ${splitFilter("gp.tournament_page", input, params)}`;
}

/**
 * Without a period, the roster is the current one: the team's latest season in the scope, competition and split
 * included (in the database, so a team that stopped playing gets its last season). A period given by the question stays as is.
 */
function rosterSeason(db: DatabaseSync, input: TeamRosterInput): TeamRosterInput & { latest: boolean } {
  if (input.yearFrom != null || input.yearTo != null) return { ...input, latest: false };
  const params: Params = {};
  const t = inList("t", teamMembers(db, input.team).members, params);
  const league = input.league ? `AND ${leagueFilter("g.league", input, params)}` : "";

  const year = selectOne(
    db,
    z.object({ year: z.number().nullable() }),
    `SELECT MAX(g.year) AS year FROM v_games g
     WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t})) AND g.stage IN (${COMPETITION_STAGES}) ${league} ${splitFilter("g.tournament_page", input, params)}`,
    params,
  )?.year;

  return year == null ? { ...input, latest: false } : { ...input, yearFrom: year, yearTo: year, latest: true };
}

/** The team's tournaments of the scope, in play order, with its games and wins in each (a trusted helper query). */
function rosterTournaments(db: DatabaseSync, input: TeamRosterInput) {
  const params: Params = {};
  const t = inList("t", teamMembers(db, input.team).members, params);
  const league = input.league ? `AND ${leagueFilter("g.league", input, params)}` : "";

  return selectAll(
    db,
    RosterTournamentRow,
    `SELECT g.event_page, MIN(g.tournament) AS tournament, COUNT(*) AS games,
            SUM(CASE WHEN g.winner IN (${t}) THEN 1 ELSE 0 END) AS wins, MIN(g.played_at) AS at
     FROM v_games g
     WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t})) AND g.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("g.year", input, params)}
       ${splitFilter("g.tournament_page", input, params)}
     GROUP BY g.event_page
     ORDER BY MIN(g.played_at), g.event_page`,
    params,
  );
}

const teamRoster: ToolDef<TeamRosterInput> = {
  name: "team_roster",
  label: "roster d'équipe",
  description:
    "A team's roster over a period or a competition: every player who played for it, by role (Top, Jungle, Mid, Bot, Support), " +
    "with their games and the tournaments they played. Renamed teams are merged (Samsung Ozone → Samsung White, SK Telecom T1 → T1).",
  plan: (db, asked) => {
    const params: Params = {};
    const input = rosterSeason(db, asked);

    return {
      params,
      sql: tidy(`WITH lines AS (
  SELECT gp.player, gp.role, gp.event_page, MIN(gp.tournament) AS tournament, MIN(gp.team) AS team,
         COUNT(*) AS games, SUM(gp.win) AS wins, MIN(gp.played_at) AS first_played, MAX(gp.played_at) AS last_played
  FROM v_game_players gp
  WHERE ${rosterScope(db, input, params)}
  GROUP BY gp.player, gp.role, gp.event_page
)
SELECT player, role, SUM(games) AS games, SUM(wins) AS wins, MIN(first_played) AS first_played, MAX(last_played) AS last_played,
       json_group_array(json_object('event', event_page, 'tournament', tournament, 'team', team, 'games', games, 'at', first_played) ORDER BY first_played) AS events
FROM lines
GROUP BY player, role
ORDER BY role, SUM(games) DESC, player`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.split)
      out.push({ key: "split", input: { ...input, split: null }, note: `Aucune partie de ${input.team} au split ${input.split} : affichage de toute la saison.`, reason: "filtre de split retiré" });

    if (hasPeriod(input)) out.push(noPeriod({ ...input, split: null }, "tous les joueurs de son histoire"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null },
        note: `Aucune partie de ${input.team} dans cette compétition : affichage de toutes les compétitions.`,
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, asked, sqlRows): ToolOutput => {
    const input = rosterSeason(db, asked);
    const raw = z.array(RosterRow).parse(sqlRows);
    const { team, members } = teamMembers(db, input.team);
    const league = leagueShortName(db, input.league);
    const scope = [input.split ? `au split ${input.split}` : "", scopeLabel(league, input)].filter(Boolean).join(" ");
    const events = rosterTournaments(db, input);
    const games = events.reduce((n, e) => n + e.games, 0);
    const wins = events.reduce((n, e) => n + e.wins, 0);
    const names = [...new Set(raw.flatMap((r) => r.events.map((e) => e.team)))].map(displayTeam);
    const label = (e: { event: string; tournament: string | null }) => e.tournament ?? e.event;

    const top = new Map<string, number>();

    for (const r of raw) top.set(r.role, Math.max(top.get(r.role) ?? 0, r.games));

    const players = raw
      .map((r): RosterPlayer => ({
        player: r.player,
        role: r.role,
        games: r.games,
        wins: r.wins,
        starter: false,
        tournaments: r.events.map(label),
        firstPlayed: r.first_played,
        lastPlayed: r.last_played,
        source: { label: `Leaguepedia — ${r.player}`, url: wikiUrl(r.player) },
      }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role) || b.games - a.games || a.player.localeCompare(b.player));

    // The starters of a role are its players with the most games: two of them when they split the games evenly.
    for (const p of players) p.starter = p.games === top.get(p.role);

    const starters = players.filter((p) => p.starter);
    const others = players.filter((p) => !p.starter);
    const roleName = (role: string) => ROLE_LABEL_BY_NAME.get(role) ?? role;
    const where = scope ? ` ${scope}` : "";

    const inRole = input.role ? players.filter((p) => p.role === input.role) : [];

    const answer = input.role
      ? inRole.length
        ? `${roleName(input.role).replace(/^./, (c) => c.toUpperCase())} de ${team}${where} : ${inRole.map((p) => `${p.player} (${p.games} partie${p.games > 1 ? "s" : ""}${p.starter ? "" : ", remplaçant"})`).join(", ")}. `
        : `Aucun ${roleName(input.role)} de ${team} aligné${where}. `
      : "";

    let facts =
      answer +
      `${team}${where} : ${games} parties (${wins} victoires) sur ${events.length} tournoi${events.length > 1 ? "s" : ""}. ` +
      `Joueurs avec le plus de parties à chaque poste : ${starters.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`;

    if (others.length) facts += ` Aussi alignés : ${others.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`;

    if (names.length > 1) facts += ` Noms pris en compte : ${names.join(", ")}.`;

    return {
      title: `${team} — roster${where}`,
      table: {
        columns: ["Poste", "Joueur", "Statut", "Parties", "V-D", "Tournois"],
        rows: players.map((p) => [roleName(p.role), p.player, p.starter ? "titulaire" : "remplaçant", p.games, `${p.wins}-${p.games - p.wins}`, p.tournaments.join(", ")]),
      },
      roster: {
        team,
        names,
        scope,
        games,
        wins,
        tournaments: events.map((e) => ({ label: label({ event: e.event_page, tournament: e.tournament }), games: e.games, source: { label: `Leaguepedia — ${e.event_page}`, url: wikiUrl(e.event_page) } })),
        players,
      },
      notes: [
        ...(input.latest ? [`Aucune période précisée : roster de la saison la plus récente de ${team} (${input.yearFrom}).`] : []),
        "Seuls les joueurs alignés en match figurent ici : la base ne contient ni les coachs ni les remplaçants qui n'ont pas joué.",
      ],
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(events.map((e) => e.event_page), 12),
        ...starters.map((p) => p.source),
      ],
      followUps: [`Historique de ${team}${where}`, ...starters.slice(0, 2).map((p) => `${p.player}${where}`)].slice(0, 3),
      totals: { season: input.latest ? (input.yearFrom ?? "n/d") : "asked", players: players.length, starters: starters.length, games, wins, events: events.length, ...Object.fromEntries(starters.toReversed().map((p) => [p.role.toLowerCase(), p.player])) },
    };
  },
  normalize: (db, input) => {
    const t = resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

// 3. Head-to-head -------------------------------------------------------------------

const SeriesRow = z.object({
  tournament_page: Text,
  tab: NullableText,
  league_short: Text,
  year: z.number().nullable(),
  played_at: z.number().nullable(),
  team_a: Text,
  team_b: Text,
  wins_a: z.number(),
  wins_b: z.number(),
});

/** Series listed under a head-to-head; the record counts every series of the scope. */
const MAX_SERIES = 100;

/** Every series (one tab's match of one tournament page) the two teams played in the scope, newest first. */
function teamSeries(db: DatabaseSync, input: HeadToHeadInput) {
  const params: Params = {};
  const A = inList("a", teamMembers(db, input.sideA).members, params);
  const B = inList("b", teamMembers(db, input.sideB).members, params);
  const league = input.league ? `AND ${leagueFilter("g.league", input, params)}` : "";

  const rows = selectAll(
    db,
    SeriesRow,
    `SELECT g.tournament_page, g.tab, MIN(g.league_short) AS league_short, MIN(g.year) AS year, MIN(g.played_at) AS played_at,
            MIN(CASE WHEN g.blue_team IN (${A}) THEN g.blue_team ELSE g.red_team END) AS team_a,
            MIN(CASE WHEN g.blue_team IN (${A}) THEN g.red_team ELSE g.blue_team END) AS team_b,
            SUM(CASE WHEN g.winner IN (${A}) THEN 1 ELSE 0 END) AS wins_a,
            SUM(CASE WHEN g.winner IN (${B}) THEN 1 ELSE 0 END) AS wins_b
     FROM v_games g
     WHERE ((g.blue_team IN (${A}) AND g.red_team IN (${B})) OR (g.blue_team IN (${B}) AND g.red_team IN (${A})))
       AND g.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("g.year", input, params)}
     GROUP BY g.tournament_page, g.tab, g.match_n
     ORDER BY MIN(g.played_at) DESC`,
    params,
  );

  return {
    count: rows.length,
    seriesA: rows.filter((r) => r.wins_a > r.wins_b).length,
    seriesB: rows.filter((r) => r.wins_b > r.wins_a).length,
    series: rows.slice(0, MAX_SERIES).map((r): TeamSeries => ({
      playedAt: r.played_at,
      label: [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · "),
      teamA: displayTeam(r.team_a),
      teamB: displayTeam(r.team_b),
      winsA: r.wins_a,
      winsB: r.wins_b,
      source: { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) },
    })),
  };
}

const headToHead: ToolDef<HeadToHeadInput> = {
  name: "head_to_head",
  label: "confrontations",
  description:
    "Games between two teams, tournament by tournament (wins of each side). For two players, use player_comparison.",
  plan: (db, input) => {
    const params: Params = {};
    const filters: string[] = [];

    const A = inList("a", teamMembers(db, input.sideA).members, params);
    const B = inList("b", teamMembers(db, input.sideB).members, params);

    if (input.league) {
      filters.push(`AND ${leagueFilter("g.league", input, params)}`);

    }

    return {
      params,
      sql: tidy(`SELECT g.year, g.league_short, g.event_page, MIN(g.tournament) AS tournament,
       SUM(CASE WHEN g.winner IN (${A}) THEN 1 ELSE 0 END) AS wins_a,
       SUM(CASE WHEN g.winner IN (${B}) THEN 1 ELSE 0 END) AS wins_b
FROM v_games g
WHERE ((g.blue_team IN (${A}) AND g.red_team IN (${B})) OR (g.blue_team IN (${B}) AND g.red_team IN (${A})))
  AND g.stage IN (${COMPETITION_STAGES})
  ${filters.join(" ")}
  ${periodFilter("g.year", input, params)}
GROUP BY g.year, g.event_page
ORDER BY g.year, MIN(g.played_at), g.event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les années"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: "Aucune confrontation dans cette compétition : affichage de toutes les compétitions.",
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(HeadToHeadRow).parse(sqlRows);
    const a = teamMembers(db, input.sideA);
    const b = teamMembers(db, input.sideB);
    const winsA = raw.reduce((n, r) => n + Number(r.wins_a), 0);
    const winsB = raw.reduce((n, r) => n + Number(r.wins_b), 0);
    const league = leagueShortName(db, input.league);
    const last = raw[raw.length - 1];
    const leader = winsA === winsB ? "à égalité" : `avantage ${winsA > winsB ? a.team : b.team}`;

    const series = teamSeries(db, input);
    const latest = series.series[0];
    const seriesLeader = series.seriesA === series.seriesB ? "à égalité" : `avantage ${series.seriesA > series.seriesB ? a.team : b.team}`;

    const facts =
      `${[`${a.team} – ${b.team}`, inLeague(league)].filter(Boolean).join(" ")} : ` +
      `${series.count} séries (${span(raw.map((r) => Number(r.year)))}), ${series.seriesA} gagnées par ${a.team} et ${series.seriesB} par ${b.team} (${seriesLeader}) ; ` +
      `${winsA} victoires à ${winsB} en parties sur ${raw.length} tournois, ${leader}. ` +
      (latest
        ? `Dernière rencontre : ${latest.label}${latest.playedAt ? ` (${DAY_FR.format(new Date(latest.playedAt * 1000))})` : ""}, ${latest.teamA} ${latest.winsA}-${latest.winsB} ${latest.teamB}.`
        : `Dernière confrontation : ${last.tournament ?? last.event_page} (${last.wins_a}-${last.wins_b}).`);

    return {
      title: `${a.team} vs ${b.team}${league === "toutes compétitions" ? "" : ` — ${league}`}`,
      table: {
        columns: ["Année", "Compétition", "Tournoi", a.team, b.team],
        rows: raw.map((r) => [r.year, r.league_short, r.tournament ?? r.event_page, r.wins_a, r.wins_b]),
      },
      facts,
      sources: [
        ...[...a.members, ...b.members].map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(raw.map((r) => String(r.event_page)), 15),
      ],
      teams: {
        teamA: a.team,
        teamB: b.team,
        scope: scopeLabel(league, input),
        seriesA: series.seriesA,
        seriesB: series.seriesB,
        gamesA: winsA,
        gamesB: winsB,
        seriesCount: series.count,
        series: series.series,
      },
      followUps: [`Historique de ${a.team}`, `Historique de ${b.team}`],
      totals: { wins_a: winsA, wins_b: winsB, events: raw.length, series: series.count, series_a: series.seriesA, series_b: series.seriesB },
    };
  },
  // The model may write a franchise's old name ("MAD Lions KOI"): the input carries the franchise's current one.
  normalize: (db, input) => {
    const a = resolveTeam(db, input.sideA);
    const b = resolveTeam(db, input.sideB);

    return a && b ? { ...input, sideA: a.team, sideB: b.team } : null;
  },
};

// 3b. Two players set against each other ----------------------------------------------

const ComparisonRow = z.object({
  player: Text,
  games: z.number(),
  wins: z.number(),
  avg_kills: z.number().nullable(),
  avg_deaths: z.number().nullable(),
  avg_assists: z.number().nullable(),
  avg_gold: z.number().nullable(),
  avg_cs: z.number().nullable(),
  avg_damage: z.number().nullable(),
  avg_vision: z.number().nullable(),
  avg_gold_diff_15: z.number().nullable(),
  avg_cs_diff_15: z.number().nullable(),
  avg_solo_kills: z.number().nullable(),
  solo_kills: z.number().nullable(),
  ingame_games: z.number(),
  pages: pageList,
});

type ComparisonRow = z.infer<typeof ComparisonRow>;

/** Columns of the comparison tables, named as the comparison layout reads them. */
const COMPARISON_COLUMNS = [
  "player", "games", "wins", "avg_kills", "avg_deaths", "avg_assists", "avg_gold", "avg_cs", "avg_damage", "avg_vision", "avg_gold_diff_15", "avg_cs_diff_15",
  "avg_solo_kills",
] as const;

const VersusGameRow = z.object({
  played_at: z.number().nullable(),
  league_short: Text,
  year: z.number().nullable(),
  tab: NullableText,
  game_n: z.number().nullable(),
  tournament_page: Text,
  stats_page: NullableText,
  team_a: NullableText,
  team_b: NullableText,
  role_a: NullableText,
  role_b: NullableText,
  win_a: z.number().nullable(),
  champion_a: NullableText,
  icon_a: NullableText,
  kills_a: z.number().nullable(),
  deaths_a: z.number().nullable(),
  assists_a: z.number().nullable(),
  champion_b: NullableText,
  icon_b: NullableText,
  kills_b: z.number().nullable(),
  deaths_b: z.number().nullable(),
  assists_b: z.number().nullable(),
});

/** Most games listed under the comparison (Faker and Chovy met 146 times). */
const MAX_VERSUS_GAMES = 200;

const fr1 = (n: number) => (Math.round(n * 10) / 10).toString().replace(".", ",");

/** The other player of the pair, for a row of either: they faced each other when they were on opposing teams. */
const FACED = `EXISTS (SELECT 1 FROM v_game_players o
    WHERE o.game_id = p.game_id AND o.team <> p.team AND o.player = CASE p.player WHEN :a THEN :b ELSE :a END)`;

/**
 * Both players' statistics, one row each (player A first). `faced`: only the games where they played
 * against each other. The in-game stats are filtered on the two players before the join, so the view's
 * own joins stay small.
 */
function comparisonSql(input: PlayerComparisonInput, params: Params, faced: boolean): string {
  return tidy(`WITH st AS (
  SELECT game_id, player, gold_diff_15, cs_diff_15, solo_kills FROM v_game_player_stats WHERE player IN (:a, :b)
), g AS (
  SELECT p.player, p.event_page, p.win, p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision,
         st.gold_diff_15, st.cs_diff_15, st.solo_kills, (st.game_id IS NOT NULL) AS ingame
  FROM v_game_players p
  LEFT JOIN st ON st.game_id = p.game_id AND st.player = p.player
  WHERE p.player IN (:a, :b) AND ${competitionScope("p", input, params)}${faced ? `\n    AND ${FACED}` : ""}
)
SELECT player, COUNT(*) AS games, SUM(win) AS wins,
       ROUND(AVG(kills), 2) AS avg_kills, ROUND(AVG(deaths), 2) AS avg_deaths, ROUND(AVG(assists), 2) AS avg_assists,
       ROUND(AVG(gold), 0) AS avg_gold, ROUND(AVG(cs), 1) AS avg_cs, ROUND(AVG(damage), 0) AS avg_damage, ROUND(AVG(vision), 1) AS avg_vision,
       ROUND(AVG(gold_diff_15), 0) AS avg_gold_diff_15, ROUND(AVG(cs_diff_15), 1) AS avg_cs_diff_15,
       ROUND(AVG(solo_kills), 2) AS avg_solo_kills, SUM(solo_kills) AS solo_kills,
       SUM(ingame) AS ingame_games, json_group_array(DISTINCT event_page) AS pages
FROM g GROUP BY player
ORDER BY player = :a DESC`);
}

const comparisonTable = (rows: ComparisonRow[]) => ({
  columns: [...COMPARISON_COLUMNS],
  rows: rows.map((r) => COMPARISON_COLUMNS.map((c) => (c === "player" ? r.player : r[c]))),
});

/** "en LEC en 2025", "aux Worlds entre 2015 et 2020", "depuis 2023", "" for every competition and season. */
function scopeLabel(league: string, input: Period): string {
  const { yearFrom: from, yearTo: to } = input;

  const period =
    from != null && from === to ? `en ${from}` : from != null && to != null ? `entre ${from} et ${to}` : from != null ? `depuis ${from}` : to != null ? `jusqu'en ${to}` : "";

  return [inLeague(league), period].filter(Boolean).join(" ");
}

/** Their games against each other, newest first, with each player's champion and K/D/A. */
function versusGames(db: DatabaseSync, input: PlayerComparisonInput): VersusGame[] {
  const params: Params = {};

  Object.assign(params, { a: input.playerA, b: input.playerB });

  const rows = selectAll(
    db,
    VersusGameRow,
    `SELECT g.played_at, g.league_short, g.year, g.tab, g.game_n, g.tournament_page, r.stats_page,
            p.team AS team_a, o.team AS team_b, p.role AS role_a, o.role AS role_b, p.win AS win_a,
            p.champion AS champion_a, ca.icon_url AS icon_a, p.kills AS kills_a, p.deaths AS deaths_a, p.assists AS assists_a,
            o.champion AS champion_b, cb.icon_url AS icon_b, o.kills AS kills_b, o.deaths AS deaths_b, o.assists AS assists_b
     FROM v_game_players p
     JOIN v_game_players o ON o.game_id = p.game_id AND o.team <> p.team AND o.player = :b
     JOIN v_games g ON g.game_id = p.game_id
     LEFT JOIN game_riot r ON r.game_id = p.game_id
     LEFT JOIN champions ca ON ca.name = p.champion
     LEFT JOIN champions cb ON cb.name = o.champion
     WHERE p.player = :a AND ${competitionScope("p", input, params)}
     ORDER BY g.played_at DESC
     LIMIT ${MAX_VERSUS_GAMES}`,
    params,
  );

  return rows.map((r) => {
    // The game's own page when Leaguepedia has its Riot data, else the tournament page.
    const page = r.stats_page ?? r.tournament_page;

    return {
      playedAt: r.played_at,
      label: [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab), r.game_n ? `game ${r.game_n}` : ""].filter(Boolean).join(" · "),
      winA: r.win_a == null ? null : r.win_a === 1,
      a: { team: r.team_a && displayTeam(r.team_a), role: r.role_a, champion: r.champion_a, championIcon: r.icon_a, kills: r.kills_a, deaths: r.deaths_a, assists: r.assists_a },
      b: { team: r.team_b && displayTeam(r.team_b), role: r.role_b, champion: r.champion_b, championIcon: r.icon_b, kills: r.kills_b, deaths: r.deaths_b, assists: r.assists_b },
      source: { label: `Leaguepedia — ${page}`, url: wikiUrl(page) },
    };
  });
}

/** Of their games against each other, those they played in the same role (a lane face-off), by role. */
function sameLane(db: DatabaseSync, input: PlayerComparisonInput): VersusView["lanes"] {
  const params: Params = {};

  Object.assign(params, { a: input.playerA, b: input.playerB });

  const roles = selectAll(
    db,
    z.object({ role: Text, games: z.number() }),
    `SELECT p.role, COUNT(*) AS games FROM v_game_players p
     JOIN v_game_players o ON o.game_id = p.game_id AND o.team <> p.team AND o.player = :b AND o.role = p.role
     WHERE p.player = :a AND p.role IS NOT NULL AND ${competitionScope("p", input, params)}
     GROUP BY p.role ORDER BY games DESC, p.role`,
    params,
  );

  return { same: roles.reduce((n, r) => n + r.games, 0), roles };
}

/** "dont 12 dans la même lane (Mid)", or why they never faced each other in lane. */
function laneFacts(lanes: VersusView["lanes"], met: number, profiles: [string | null, string | null], names: [string, string]): string {
  if (!met) return "";

  if (lanes.same === met) return ` Toutes ces parties se sont jouées dans la même lane (${lanes.roles.map((r) => r.role).join(", ")}).`;

  if (lanes.same) return ` Dont ${lanes.same} dans la même lane (${lanes.roles.map((r) => `${r.role} ${r.games}`).join(", ")}).`;

  const [ra, rb] = profiles;

  return ` Jamais dans la même lane${ra && rb && ra !== rb ? ` (${names[0]} joue ${ra}, ${names[1]} ${rb})` : ""}.`;
}

const playerComparison: ToolDef<PlayerComparisonInput> = {
  name: "player_comparison",
  label: "comparaison de deux joueurs",
  description:
    "Sets two players against each other in a competition and period: their statistics in the games they played against each other " +
    "(record, average kills/deaths/assists, gold, CS, damage, vision, gold and CS difference at 15 min, solo kills), the list of those games, " +
    "and their statistics over every game of the scope. Use it for any question opposing two players: 'compare X and Y', 'X vs Y', " +
    "'X contre Y', 'X or Y who is better', 'head to head', 'h2h', 'confrontations'.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { a: input.playerA, b: input.playerB });

    // Every game of the scope: it decides whether there is anything to compare (the relaxations run on it).
    return { params, sql: comparisonSql(input, params, false) };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: "Aucune partie des deux joueurs dans cette compétition : comparaison sur toutes les compétitions.",
        reason: "filtre de compétition retiré",
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(ComparisonRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const params: Params = {};

    Object.assign(params, { a: input.playerA, b: input.playerB });

    const faced = selectAll(db, ComparisonRow, comparisonSql(input, params, true), params);
    const games = faced.length ? versusGames(db, input) : [];
    const met = faced.find((r) => r.player === input.playerA)?.games ?? 0;
    const winsA = faced.find((r) => r.player === input.playerA)?.wins ?? 0;
    const lanes = met ? sameLane(db, input) : { same: 0, roles: [] };
    const mainRole = (player: string) => games.find((g) => g.a.role)?.[player === input.playerA ? "a" : "b"].role ?? null;

    const line = (r: ComparisonRow) => {
      const kda = r.avg_kills != null && r.avg_deaths && r.avg_assists != null ? `, KDA ${fr1((r.avg_kills + r.avg_assists) / r.avg_deaths)}` : "";

      const solo = r.solo_kills == null ? "" : `, ${r.solo_kills} solo kill${r.solo_kills > 1 ? "s" : ""}`;

      return `${r.player} ${r.games} parties, ${r.wins} victoires (${pct(r.wins, r.games)} %)${kda}${solo}`;
    };

    const missing = [input.playerA, input.playerB].filter((p) => !rows.some((r) => r.player === p));
    const pair = `${input.playerA} et ${input.playerB}${scope ? ` ${scope}` : ""}`;

    const facts =
      (met
        ? `${pair} se sont affrontés sur ${met} parties : ${input.playerA} ${winsA} – ${met - winsA} ${input.playerB} ; face à face, ${faced.map(line).join(" ; ")}. ` +
          `Sur toutes leurs parties : ${rows.map(line).join(" ; ")}.` +
          laneFacts(lanes, met, [mainRole(input.playerA), mainRole(input.playerB)], [input.playerA, input.playerB])
        : `${pair} ne se sont jamais affrontés. Sur toutes leurs parties : ${rows.map(line).join(" ; ")}.`) +
      (missing.length ? ` Aucune partie de ${missing.join(" ni de ")} dans ce périmètre.` : "") +
      ([...rows, ...faced].every((r) => r.ingame_games === 0)
        ? " Écarts à 15 min et solo kills : n/d, aucune partie avec données Riot dans ce périmètre."
        : [...rows, ...faced].some((r) => r.ingame_games < r.games) ? " Écarts à 15 min et solo kills calculés sur les parties avec données Riot seulement." : "");

    return {
      title: `${input.playerA} vs ${input.playerB}${league === "toutes compétitions" ? "" : ` — ${league}`}`,
      // The generic table (and the text answer) keep the global statistics; the view adds the games they met in.
      table: comparisonTable(rows),
      versus: {
        playerA: input.playerA,
        playerB: input.playerB,
        scope,
        global: comparisonTable(rows),
        h2h: met ? comparisonTable(faced) : null,
        lanes,
        games,
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.playerA}`, url: wikiUrl(input.playerA) },
        { label: `Leaguepedia — ${input.playerB}`, url: wikiUrl(input.playerB) },
        ...eventSources(rows.flatMap((r) => r.pages), 10),
      ],
      followUps: [`Résultats de ${input.playerA}${scope ? ` ${scope}` : " à tous les Worlds"}`, `Résultats de ${input.playerB}${scope ? ` ${scope}` : " à tous les Worlds"}`],
      totals: {
        games_a: rows.find((r) => r.player === input.playerA)?.games ?? 0,
        games_b: rows.find((r) => r.player === input.playerB)?.games ?? 0,
        wins_a: rows.find((r) => r.player === input.playerA)?.wins ?? 0,
        wins_b: rows.find((r) => r.player === input.playerB)?.wins ?? 0,
        h2h_games: met,
        h2h_wins_a: winsA,
        h2h_listed: games.length,
        h2h_same_lane: lanes.same,
        // The face-to-face when they met, else the scope: what the comparison shows first.
        solo_kills_a: (met ? faced : rows).find((r) => r.player === input.playerA)?.solo_kills ?? "n/d",
        solo_kills_b: (met ? faced : rows).find((r) => r.player === input.playerB)?.solo_kills ?? "n/d",
      },
    };
  },
  normalize: (db, input) => {
    const scope = { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo };
    const a = resolvePlayer(db, input.playerA, scope);
    const b = resolvePlayer(db, input.playerB, scope);

    return a && b && a.player !== b.player ? { ...input, playerA: a.player, playerB: b.player } : null;
  },
};

// 4. Champion in an event -----------------------------------------------------------

/** (kills + assists) / deaths, a perfect game counting one death; null without the three figures. */
const kdaOf = (ka: number | null, deaths: number | null) => (ka == null || deaths == null ? null : Math.round((100 * ka) / Math.max(1, deaths)) / 100);

/** SQL of the two sums a KDA is made of, null-aware: kills + assists, and deaths (see kdaOf). */
const kaSum = (alias: string) => `SUM(CASE WHEN ${alias}.deaths IS NOT NULL THEN ${alias}.kills + ${alias}.assists END)`;
const deathsSum = (alias: string) => `SUM(CASE WHEN ${alias}.kills IS NOT NULL AND ${alias}.assists IS NOT NULL THEN ${alias}.deaths END)`;

/** French role names, as the answers write them. */
export const ROLE_LABEL: Record<(typeof ROLES)[number], string> = { Top: "top", Jungle: "jungle", Mid: "mid", Bot: "ADC", Support: "support" };

const ROLE_LABEL_BY_NAME = new Map<string, string>(Object.entries(ROLE_LABEL));

/** The players of a role, as the answers name them. */
const ROLE_PLAYERS: Record<(typeof ROLES)[number], string> = { Top: "toplaners", Jungle: "junglers", Mid: "mids", Bot: "ADC", Support: "supports" };

/** A champion's picks in the scope (`gp` is v_game_players). */
function championScope(input: ChampionStatsInput, params: Params): string {
  params.champion = input.champion;

  return `gp.champion = :champion AND ${leagueFilter("gp.league", input, params)} AND gp.stage IN (${COMPETITION_STAGES}) ${periodFilter("gp.year", input, params)}`;
}

/** End-of-game figures averaged per game on the champion, with the number of games that have them. */
const CHAMPION_AVERAGES = [
  { key: "kills", label: "kills", digits: 1 },
  { key: "deaths", label: "morts", digits: 1 },
  { key: "assists", label: "assists", digits: 1 },
  { key: "gold", label: "or", digits: 0 },
  { key: "cs", label: "CS", digits: 1 },
  { key: "damage", label: "dégâts", digits: 0 },
  { key: "vision", label: "score de vision", digits: 1 },
] as const;

/** In-game figures (Riot data), averaged over the games that have them. */
const CHAMPION_INGAME = [
  { key: "gold_diff_15", label: "écart d'or @15", digits: 0 },
  { key: "cs_diff_15", label: "écart CS @15", digits: 1 },
] as const;

const Averages = z.record(z.string(), z.number().nullable());

const ChampionPlayerRow = z.object({ player: Text, team: NullableText, games: z.number(), wins: z.number(), ka: z.number().nullable(), deaths: z.number().nullable() });

const roundTo = (n: number | null, digits: number) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

/** "12 345", "3,1", "+72", "n/d" */
export const frNumber = (n: number | null, signedValue = false) =>
  n == null ? "n/d" : `${signedValue && n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, " ")}`;

/** Since 2026, a bot laner's boots sit in the role quest slot (Riot `roleBoundItem`), which Leaguepedia's Items field leaves out. */
const BOT_BOOTS_SLOT_YEAR = 2026;

/** Where the inventories come from: the Items field of the scoreboards. */
const ITEMS_SOURCE: Source = { label: "Leaguepedia — inventaires de fin de partie (ScoreboardPlayers)", url: wikiUrl("Special:CargoTables/ScoreboardPlayers") };

const ChampionItemRow = z.object({ item: Text, icon: Text, kind: z.enum(ITEM_KINDS).nullable(), games: z.number(), wins: z.number() });

/** A champion's end-of-game items in the scope (`gp` is v_game_players), and what the inventories leave out. */
function championItems(db: DatabaseSync, input: ChampionStatsInput, picks: number): ChampionItems {
  const params: Params = {};
  const where = championScope(input, params);
  const owned = "pi.game_id = gp.game_id AND pi.player = gp.player";

  const items = selectAll(
    db,
    ChampionItemRow,
    `SELECT pi.item, pi.icon_url AS icon, pi.kind, COUNT(DISTINCT gp.game_id) AS games, COUNT(DISTINCT CASE WHEN gp.win = 1 THEN gp.game_id END) AS wins
     FROM v_game_players gp JOIN v_player_items pi ON ${owned}
     WHERE ${where}
     GROUP BY pi.item ORDER BY games DESC, pi.item`,
    params,
  );

  const counts = selectOne(
    db,
    z.object({ games: z.number(), bot_slot: z.number() }),
    `SELECT COUNT(CASE WHEN EXISTS (SELECT 1 FROM v_player_items pi WHERE ${owned}) THEN 1 END) AS games,
            COUNT(CASE WHEN gp.role = 'Bot' AND gp.year >= ${BOT_BOOTS_SLOT_YEAR} THEN 1 END) AS bot_slot
     FROM v_game_players gp WHERE ${where}`,
    params,
  ) ?? { games: 0, bot_slot: 0 };

  const notes: string[] = [];

  if (picks && !counts.games) notes.push("Leaguepedia ne liste aucun inventaire de fin de partie pour ces parties.");
  else if (counts.games < picks) notes.push(`Inventaire connu pour ${counts.games} parties sur ${picks}.`);

  if (counts.bot_slot) notes.push(`Depuis ${BOT_BOOTS_SLOT_YEAR}, les bottes des ADC (emplacement de quête de rôle) ne figurent pas dans l'inventaire listé par Leaguepedia.`);

  return { games: counts.games, items, notes };
}

/** "Infinity Edge (17/21 parties, 81 %)" for the most built completed items. */
function itemsFacts(p: ChampionProfile): string {
  const complete = p.items.items.filter((i) => i.kind === "complete").slice(0, 3);

  if (!complete.length) return p.items.notes.length ? ` Items : ${p.items.notes.join(" ")}` : "";

  return (
    ` Items complets les plus fréquents en fin de partie : ${complete.map((i) => `${i.item} (${i.games}/${p.items.games} parties, ${pct(i.games, p.items.games)} %)`).join(", ")}.` +
    (p.items.notes.length ? ` ${p.items.notes.join(" ")}` : "")
  );
}

/** Averages, players and roles of a champion in the scope of the question. */
function championProfile(db: DatabaseSync, input: ChampionStatsInput, scope: string, games: number, bans: number, icon: string | null): ChampionProfile {
  const params: Params = {};
  const where = championScope(input, params);
  const ends = CHAMPION_AVERAGES.map((a) => `AVG(gp.${a.key}) AS ${a.key}, COUNT(gp.${a.key}) AS n_${a.key}`).join(", ");

  const totals = selectOne(
    db,
    Averages,
    `SELECT COUNT(*) AS picks, COALESCE(SUM(gp.win), 0) AS wins,
            ${kaSum("gp")} AS ka,
            ${deathsSum("gp")} AS kda_deaths, ${ends}
     FROM v_game_players gp WHERE ${where}`,
    params,
  ) ?? {};

  const ingameParams: Params = {};

  const ingame = selectOne(
    db,
    Averages,
    `SELECT ${CHAMPION_INGAME.map((a) => `AVG(gp.${a.key}) AS ${a.key}, COUNT(gp.${a.key}) AS n_${a.key}`).join(", ")}
     FROM v_game_player_stats gp WHERE ${championScope(input, ingameParams)}`,
    ingameParams,
  ) ?? {};

  const players = selectAll(
    db,
    ChampionPlayerRow,
    `SELECT gp.player, gp.team, MAX(gp.played_at) AS last_game, COUNT(*) AS games, SUM(gp.win) AS wins,
            ${kaSum("gp")} AS ka,
            ${deathsSum("gp")} AS deaths
     FROM v_game_players gp WHERE ${where}
     GROUP BY gp.player ORDER BY games DESC, wins DESC, gp.player LIMIT 5`,
    params,
  );

  const roles = selectAll(
    db,
    z.object({ role: Text, games: z.number() }),
    `SELECT gp.role, COUNT(*) AS games FROM v_game_players gp WHERE ${where} AND gp.role IS NOT NULL GROUP BY gp.role ORDER BY games DESC, gp.role`,
    params,
  );

  const picks = totals.picks ?? 0;

  return {
    champion: input.champion,
    icon,
    scope,
    games,
    picks,
    bans,
    wins: totals.wins ?? 0,
    kda: kdaOf(totals.ka ?? null, totals.kda_deaths ?? null),
    averages: [
      ...CHAMPION_AVERAGES.map((a) => ({ key: a.key, label: a.label, value: roundTo(totals[a.key] ?? null, a.digits), counted: totals[`n_${a.key}`] ?? 0 })),
      ...CHAMPION_INGAME.map((a) => ({ key: a.key, label: a.label, value: roundTo(ingame[a.key] ?? null, a.digits), signed: true, counted: ingame[`n_${a.key}`] ?? 0 })),
    ],
    players: players.map((p) => ({ player: p.player, team: p.team && displayTeam(p.team), games: p.games, wins: p.wins, kda: kdaOf(p.ka, p.deaths) })),
    roles,
    items: championItems(db, input, picks),
  };
}

/** The sentence part of a champion's averages, saying which figures are missing or partial. */
function averagesFacts(p: ChampionProfile): string {
  const shown = p.averages.map((a) => `${a.label} ${frNumber(a.value, a.signed)}`).join(", ");
  const partial = p.averages.filter((a) => a.counted > 0 && a.counted < p.picks);
  const ingame = p.averages.find((a) => a.key === "gold_diff_15");

  return (
    `Moyennes par partie : ${shown}.` +
    (partial.length ? ` Calculés sur une partie des parties seulement (les autres n'ont pas la donnée) : ${partial.map((a) => `${a.label} sur ${a.counted}`).join(", ")}.` : "") +
    (ingame && ingame.counted === 0 ? " Écarts à 15 min n/d : aucune partie avec données Riot dans ce périmètre." : "")
  );
}

const championEventStats: ToolDef<ChampionStatsInput> = {
  name: "champion_event_stats",
  label: "stats d'un champion × compétition",
  description:
    "One champion in one competition and period: picks, bans, presence, win rate, KDA, average kills/deaths/assists, gold, CS, damage, vision " +
    "and gold/CS difference at 15 min, the players who played it most (games, win rate, KDA), the roles it was played in, and its editions one by one.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { champion: input.champion });

    return {
      params,
      sql: tidy(`WITH ev AS (
  SELECT g.game_id, g.year, g.league_short, g.event_page, g.tournament, g.played_at
  FROM v_games g
  WHERE ${leagueFilter("g.league", input, params)} AND g.stage IN (${COMPETITION_STAGES})
    ${periodFilter("g.year", input, params)}
),
picks AS (
  SELECT gp.game_id, gp.win, gp.player
  FROM v_game_players gp
  WHERE gp.champion = :champion AND ${leagueFilter("gp.league", input, params)} AND gp.stage IN (${COMPETITION_STAGES})
),
bans AS (
  SELECT DISTINCT d.game_id FROM v_draft d WHERE d.champion = :champion AND d.kind = 'ban'
),
player_counts AS (
  SELECT ev.event_page, p.player, COUNT(*) AS n
  FROM picks p JOIN ev ON ev.game_id = p.game_id
  GROUP BY ev.event_page, p.player
)
SELECT ev.year, ev.league_short, ev.event_page, MIN(ev.tournament) AS tournament,
       COUNT(*) AS games, COUNT(p.game_id) AS picks, COALESCE(SUM(p.win), 0) AS wins, COUNT(b.game_id) AS bans,
       (SELECT COUNT(*) FROM ev) AS scope_games, (SELECT MIN(year) FROM ev) AS scope_from, (SELECT MAX(year) FROM ev) AS scope_to,
       (SELECT json_group_array(json_object('player', pc.player, 'games', pc.n) ORDER BY pc.n DESC, pc.player)
          FROM player_counts pc WHERE pc.event_page = ev.event_page) AS players
FROM ev
LEFT JOIN picks p ON p.game_id = ev.game_id
LEFT JOIN bans b ON b.game_id = ev.game_id
GROUP BY ev.year, ev.event_page
HAVING COUNT(p.game_id) + COUNT(b.game_id) > 0
ORDER BY ev.year, MIN(ev.played_at), ev.event_page`),
    };
  },
  relaxations: (input) => {
    if (!hasPeriod(input)) return [];
    const { yearFrom: from, yearTo: to } = input;
    const when = from != null && from === to ? `en ${from}` : from != null && to != null ? `entre ${from} et ${to}` : from != null ? `depuis ${from}` : `jusqu'en ${to}`;

    return [{ ...noPeriod(input, "toutes les éditions"), note: `${input.champion} n'a été ni pické ni banni ${when} dans cette compétition (qualifications exclues) : affichage de toutes les éditions.` }];
  },
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(ChampionStatsRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const sum = (k: "picks" | "bans" | "wins") => raw.reduce((n, r) => n + r[k], 0);
    const picks = sum("picks");
    const bans = sum("bans");
    const wins = sum("wins");
    // Every game of the scope, as champion_ranking counts them: editions without the champion included.
    const first = raw[0];
    const games = first?.scope_games ?? 0;
    const years = raw.map((r) => Number(r.year));

    // Said only when the scope is wider than the champion's own editions.
    const scopeYears =
      first?.scope_from != null && first.scope_to != null && (first.scope_from < Math.min(...years) || first.scope_to > Math.max(...years))
        ? `, ${yearSpan([first.scope_from, first.scope_to])}`
        : "";

    const icon = selectOne(db, z.object({ icon_url: z.string().nullable() }), "SELECT icon_url FROM champions WHERE name = ?", [
      input.champion,
    ])?.icon_url ?? null;

    const scope = scopeLabel(league, input);
    const profile = championProfile(db, input, scope, games, bans, icon);
    const playerLine = (p: ChampionPlayer) => `${p.player} (${p.games} partie${p.games > 1 ? "s" : ""}, ${pct(p.wins, p.games)} % de victoires, KDA ${frNumber(p.kda)})`;

    const facts =
      `${input.champion} ${inLeague(league)} (${yearSpan(years)}) : ${picks} picks et ${bans} bans ` +
      `sur les ${games} parties du périmètre${scopeYears} (présence ${pct(picks + bans, games)} %), ${wins} victoires pour ${picks - wins} défaites ` +
      `(${pct(wins, picks)} % de victoires)` +
      (picks ? `, KDA ${frNumber(profile.kda)}. ${averagesFacts(profile)}` : ".") +
      (profile.roles.length ? ` Rôles : ${profile.roles.map((r) => `${r.role} (${r.games})`).join(", ")}.` : "") +
      (profile.players.length ? ` Joueurs les plus fréquents (classés par parties jouées) : ${profile.players.slice(0, 3).map(playerLine).join(", ")}.` : "") +
      (picks ? itemsFacts(profile) : "");

    return {
      title: `${input.champion} — ${league}`,
      champion: profile,
      table: {
        columns: ["Année", "Tournoi", "Parties", "Picks", "Bans", "Présence %", "V-D", "% victoire", "Joueurs"],
        rows: raw.map((r) => [
          r.year,
          r.tournament ?? r.event_page,
          r.games,
          r.picks,
          r.bans,
          pct(r.picks + r.bans, r.games),
          `${r.wins}-${r.picks - r.wins}`,
          r.picks ? pct(r.wins, r.picks) : null,
          r.players.slice(0, 3).map((p) => `${p.player} ×${p.games}`).join(", "),
        ]),
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.champion}`, url: wikiUrl(input.champion) },
        ...eventSources(raw.map((r) => String(r.event_page)), 15),
        ...(profile.averages.some((a) => a.key === "gold_diff_15" && a.counted > 0) ? [RIOT_DATA_SOURCE] : []),
        { label: "Riot Data Dragon — champions", url: icon ?? `${DDRAGON_BASE}/api/versions.json` },
        ...(profile.items.items.length ? [ITEMS_SOURCE, { label: "Riot Data Dragon — items", url: `${DDRAGON_BASE}/api/versions.json` }] : []),
      ],
      followUps: [
        `Champions les plus joués ${inLeague(league) || "aux Worlds"}${hasPeriod(input) ? ` ${input.yearFrom ?? ""}`.trimEnd() : ""}`,
        ...profile.players.slice(0, 2).map((p) => `Résultats de ${p.player} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`),
      ],
      totals: {
        picks,
        bans,
        wins,
        games,
        events: raw.length,
        kda: profile.kda ?? "n/d",
        top_player: profile.players[0]?.player ?? "",
        top_player_games: profile.players[0]?.games ?? 0,
        main_role: profile.roles[0]?.role ?? "",
        avg_gold: profile.averages.find((a) => a.key === "gold")?.value ?? "n/d",
        avg_damage: profile.averages.find((a) => a.key === "damage")?.value ?? "n/d",
        gold_diff_15: profile.averages.find((a) => a.key === "gold_diff_15")?.value ?? "n/d",
        item_games: profile.items.games,
        top_item: profile.items.items.find((i) => i.kind === "complete")?.item ?? "",
        top_item_games: profile.items.items.find((i) => i.kind === "complete")?.games ?? 0,
      },
    };
  },
  normalize: (db, input) => {
    const c = resolveChampion(db, input.champion);

    return c ? { ...input, champion: c.champion } : null;
  },
};

// 4b. Champions ranked ------------------------------------------------------------------

const CHAMPION_SORT_LABEL: Record<ChampionSort, { title: string; criterion: string }> = {
  picks: { title: "les plus joués", criterion: "nombre de picks" },
  bans: { title: "les plus bannis", criterion: "nombre de bans" },
  presence: { title: "les plus présents", criterion: "présence, (picks + bans) / parties" },
  winrate: { title: "au meilleur taux de victoire", criterion: "victoires / picks" },
  kda: { title: "au meilleur KDA", criterion: "KDA, (kills + assists) / morts" },
  kills: { title: "avec le plus de kills par partie", criterion: "kills par partie, en moyenne" },
  deaths: { title: "avec le plus de morts par partie", criterion: "morts par partie, en moyenne" },
  assists: { title: "avec le plus d'assists par partie", criterion: "assists par partie, en moyenne" },
  gold: { title: "avec le plus d'or par partie", criterion: "or par partie, en moyenne" },
  cs: { title: "avec le plus de CS par partie", criterion: "CS par partie, en moyenne" },
  damage: { title: "avec le plus de dégâts par partie", criterion: "dégâts aux champions par partie, en moyenne" },
  vision: { title: "avec le plus de vision par partie", criterion: "score de vision par partie, en moyenne" },
  dpm: { title: "avec le plus de dégâts par minute", criterion: "dégâts aux champions par minute" },
  gpm: { title: "avec le plus d'or par minute", criterion: "or gagné par minute" },
  cspm: { title: "avec le plus de CS par minute", criterion: "CS par minute" },
  gold_diff_15: { title: "au meilleur écart d'or à 15 min", criterion: "écart d'or moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot" },
  cs_diff_15: { title: "au meilleur écart de CS à 15 min", criterion: "écart de CS moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot" },
  xp_diff_15: { title: "au meilleur écart d'XP à 15 min", criterion: "écart d'XP moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot" },
  first_blood: { title: "qui prennent le plus souvent le first blood", criterion: "part des parties où le champion fait le first blood, sur les parties avec données Riot" },
  solo_kills: { title: "avec le plus de solo kills par partie", criterion: "solo kills par partie, sur les parties avec données Riot" },
  players: { title: "joués par le plus de joueurs", criterion: "nombre de joueurs différents à l'avoir joué" },
  penta_kills: { title: "avec le plus de pentakills", criterion: "pentakills au total, sur les parties avec données Riot" },
  quadra_kills: { title: "avec le plus de quadrakills", criterion: "quadrakills au total, sur les parties avec données Riot" },
  triple_kills: { title: "avec le plus de triple kills", criterion: "triple kills au total, sur les parties avec données Riot" },
  double_kills: { title: "avec le plus de double kills", criterion: "double kills au total, sur les parties avec données Riot" },
};

/**
 * A total over the scope: the column it sums, in v_game_players (end-of-game) or v_game_player_stats (Riot data,
 * named as metrics.ts defines it), its title, and how a figure reads (`one` for a count of 1, when it differs).
 */
function ingameTotal(metric: keyof typeof PLAYER_METRIC_DEFS) {
  const { column, label } = PLAYER_METRIC_DEFS[metric];

  return { ingame: true, column, title: `avec le plus de ${label}`, unit: label, one: label.replace(/s$/, "") };
}

const CHAMPION_TOTAL: Record<ChampionTotalSort, { ingame: boolean; column: string; title: string; unit: string; one?: string }> = {
  kills: { ingame: false, column: "kills", title: "avec le plus de kills", unit: "kills", one: "kill" },
  deaths: { ingame: false, column: "deaths", title: "avec le plus de morts", unit: "morts", one: "mort" },
  assists: { ingame: false, column: "assists", title: "avec le plus d'assists", unit: "assists", one: "assist" },
  gold: { ingame: false, column: "gold", title: "avec le plus d'or", unit: "d'or" },
  cs: { ingame: false, column: "cs", title: "avec le plus de CS", unit: "CS" },
  damage: { ingame: false, column: "damage", title: "avec le plus de dégâts", unit: "de dégâts" },
  vision: { ingame: false, column: "vision", title: "avec le plus de score de vision", unit: "de score de vision" },
  solo_kills: ingameTotal("solo_kills"),
  first_blood: ingameTotal("first_bloods"),
  penta_kills: ingameTotal("penta_kills"),
  quadra_kills: ingameTotal("quadra_kills"),
  triple_kills: ingameTotal("triple_kills"),
  double_kills: ingameTotal("double_kills"),
};

const totalSortOf = (input: Pick<ChampionRankingInput, "sort" | "total">): ChampionTotalSort | null =>
  input.total ? (CHAMPION_TOTAL_SORTS.find((s) => s === input.sort) ?? null) : null;

/** "3 pentakills", "1 pentakill", "0 pentakill", "45 210 d'or". */
const totalText = (sort: ChampionTotalSort, n: number | null) => {
  const t = CHAMPION_TOTAL[sort];

  return `${frNumber(n)} ${t.one && (n ?? 0) < 2 ? t.one : t.unit}`;
};

const totalCriterion = (sort: ChampionTotalSort) =>
  `${CHAMPION_TOTAL[sort].unit} au total sur le périmètre${CHAMPION_TOTAL[sort].ingame ? ", sur les parties avec données Riot" : ""}`;

/** How each extra figure reads in a sentence. */
const CHAMPION_EXTRA_TEXT: Record<ChampionExtraSort, (v: number | null) => string> = {
  dpm: (v) => `${frNumber(v)} dégâts/min`,
  gpm: (v) => `${frNumber(v)} d'or/min`,
  cspm: (v) => `${frNumber(v)} CS/min`,
  gold_diff_15: (v) => `${frNumber(v, true)} d'or à 15 min`,
  cs_diff_15: (v) => `${frNumber(v, true)} CS à 15 min`,
  xp_diff_15: (v) => `${frNumber(v, true)} d'XP à 15 min`,
  first_blood: (v) => `first blood dans ${frNumber(v)} % des parties`,
  solo_kills: (v) => `${frNumber(v)} solo kills par partie`,
  players: (v) => `${frNumber(v)} joueurs`,
};

const extraSortOf = (sort: ChampionSort): ChampionExtraSort | null => CHAMPION_EXTRA_SORTS.find((s) => s === sort) ?? null;

/** The extra figures that come from the Riot game data: none where Leaguepedia hosts no game JSON (the LPL). */
const CHAMPION_INGAME_SORTS: ChampionSort[] = ["gold_diff_15", "cs_diff_15", "xp_diff_15", "first_blood", "solo_kills", ...CHAMPION_MULTIKILL_SORTS];

/** What a per-game average is called in a sentence, and its decimals. */
const CHAMPION_AVERAGE_UNIT: Record<ChampionAverageSort, { unit: string; digits: number }> = {
  kills: { unit: "kills", digits: 2 },
  deaths: { unit: "morts", digits: 2 },
  assists: { unit: "assists", digits: 2 },
  gold: { unit: "d'or", digits: 0 },
  cs: { unit: "CS", digits: 1 },
  damage: { unit: "de dégâts", digits: 0 },
  vision: { unit: "de vision", digits: 1 },
};

const averageSortOf = (sort: ChampionSort): ChampionAverageSort | null => CHAMPION_AVERAGE_SORTS.find((s) => s === sort) ?? null;

/** Columns of the champion ranking table, named as the champion layout reads them. */
export const CHAMPION_RANKING_COLUMNS = ["rank", "champion", "picks", "bans", "presence", "winrate", "kda", ...CHAMPION_EXTRA_SORTS] as const;

const ChampionRankingRow = z.object({
  champion: Text,
  icon: NullableText,
  picks: z.number(),
  all_picks: z.number(),
  bans: z.number(),
  games: z.number(),
  wins: z.number(),
  presence: z.number().nullable(),
  winrate: z.number().nullable(),
  kda: z.number().nullable(),
  average: z.number().nullable(),
  /** The total over the scope a total ranking is ordered by, null otherwise. */
  total: z.number().nullable(),
  dpm: z.number().nullable(),
  gpm: z.number().nullable(),
  cspm: z.number().nullable(),
  gold_diff_15: z.number().nullable(),
  cs_diff_15: z.number().nullable(),
  xp_diff_15: z.number().nullable(),
  first_blood: z.number().nullable(),
  solo_kills: z.number().nullable(),
  players: z.number(),
  /** Games on the champion that have Riot data: what the lane figures are computed on. */
  ingame_picks: z.number(),
  /** Games of the scope that have Riot data: 0 where Leaguepedia hosts none (the LPL). */
  ingame_games: z.number(),
  /** The figure the ranking is ordered by. */
  sort_value: z.number().nullable(),
  min_picks: z.number(),
});

/** Winrate and KDA need enough picks to mean something: 2 % of the scope's games, at least 3. */
const DEFAULT_MIN_PICKS = "MAX(3, (n.games + 49) / 50)";

/** A per-game average swings more on a few games: at least 5 picks, the cut Riot's own Worlds stats page applies. */
const DEFAULT_MIN_PICKS_AVERAGE = "MAX(5, (n.games + 49) / 50)";

/** A total needs no minimum: more picks is what makes it. A minimum the question sets still applies. */
const needsMinPicks = (input: Pick<ChampionRankingInput, "sort" | "total">) => !["picks", "bans", "presence", "players"].includes(input.sort) && !totalSortOf(input);

const championRanking: ToolDef<ChampionRankingInput> = {
  name: "champion_ranking",
  label: "classement de champions",
  description:
    "Ranks the champions of a competition and period: most played (picks), most banned (bans), most present (picks + bans share of games), " +
    "best win rate or KDA, highest per-game average of kills, deaths, assists, gold, CS, damage or vision, highest damage, gold or CS per minute, " +
    "best gold, CS or XP difference at 15 min, first blood share, solo kills per game, or most different players (with a minimum of picks), " +
    "or the highest total over the scope (total: true) of kills, deaths, assists, gold, CS, damage, vision, solo kills, first bloods, " +
    "pentakills, quadrakills, triple or double kills; the Riot game figures are absent in the LPL, and a total of 0 is said as such. " +
    "Each line has picks, bans, presence, win rate, KDA, the per-minute figures, the lane figures at 15 min and the number of players. " +
    "Optionally one role only ('champions les plus joués en mid') or one side of the map ('côté bleu'). " +
    "Use it for 'most played / banned / picked champions', 'meta', 'priority picks', 'champion avec le plus de morts par partie', " +
    "'champion avec le plus de morts' (total), 'quel champion a le plus de pentakills'.",
  plan: (_db, input) => {
    const params: Params = {};
    // The picks the figures are about: one role, one side of the map, or every pick.
    const mine = (alias: string) => [input.role ? `${alias}.role = :role` : "", input.side ? `${alias}.side = ${SIDE_ID[input.side]}` : ""].filter(Boolean).join(" AND ") || "1";
    const role = mine("gp");
    // Bans and presence follow the side asked; a ban has no role.
    const side = (alias: string) => (input.side ? `${alias}.side = ${SIDE_ID[input.side]}` : "1");

    const perMinuteOf = (column: string) =>
      `60.0 * SUM(CASE WHEN ${role} AND ev.length_s > 0 THEN gp.${column} END) / SUM(CASE WHEN ${role} AND ev.length_s > 0 AND gp.${column} IS NOT NULL THEN ev.length_s END)`;

    if (input.role) params.role = input.role;

    if (input.minPicks != null) params.minPicks = input.minPicks;
    const totalSort = totalSortOf(input);
    const total = totalSort ? CHAMPION_TOTAL[totalSort] : null;
    const average = totalSort ? null : averageSortOf(input.sort);
    const minPicks = input.minPicks != null ? ":minPicks" : totalSort ? "0" : average || extraSortOf(input.sort) ? DEFAULT_MIN_PICKS_AVERAGE : DEFAULT_MIN_PICKS;
    const order = totalSort ? "total" : average ? "average" : input.sort;
    // A figure of the Riot data: kept where the scope has none, so the answer says it is absent rather than widen the scope.
    const ingame = CHAMPION_INGAME_SORTS.includes(input.sort);

    return {
      params,
      sql: tidy(`WITH ev AS (
  SELECT g.game_id, g.length_s FROM v_games g WHERE ${competitionScope("g", leagueAndPeriod(input), params)}
),
n AS (SELECT COUNT(*) AS games FROM ev),
picks AS (
  SELECT gp.champion, SUM(${side("gp")}) AS all_picks, SUM(${role}) AS picks,
         SUM(CASE WHEN ${role} THEN gp.win END) AS wins,
         SUM(CASE WHEN ${role} AND gp.deaths IS NOT NULL THEN gp.kills + gp.assists END) AS ka,
         SUM(CASE WHEN ${role} AND gp.kills IS NOT NULL AND gp.assists IS NOT NULL THEN gp.deaths END) AS deaths,
         ${average ? `AVG(CASE WHEN ${role} THEN gp.${average} END)` : "NULL"} AS average,
         ${total && !total.ingame ? `SUM(CASE WHEN ${role} THEN gp.${total.column} END)` : "NULL"} AS total,
         ${perMinuteOf("damage")} AS dpm, ${perMinuteOf("gold")} AS gpm, ${perMinuteOf("cs")} AS cspm,
         COUNT(DISTINCT CASE WHEN ${role} THEN gp.player END) AS players
  FROM v_game_players gp JOIN ev ON ev.game_id = gp.game_id WHERE ${competitionScope("gp", leagueAndPeriod(input), params)}
  GROUP BY gp.champion
),
ig AS (
  SELECT s.champion, SUM(${mine("s")}) AS ingame_picks,
         AVG(CASE WHEN ${mine("s")} THEN s.gold_diff_15 END) AS gold_diff_15, AVG(CASE WHEN ${mine("s")} THEN s.cs_diff_15 END) AS cs_diff_15,
         AVG(CASE WHEN ${mine("s")} THEN s.xp_diff_15 END) AS xp_diff_15, 100.0 * AVG(CASE WHEN ${mine("s")} THEN s.first_blood_kill END) AS first_blood,
         AVG(CASE WHEN ${mine("s")} THEN s.solo_kills END) AS solo_kills,
         ${total?.ingame ? `SUM(CASE WHEN ${mine("s")} THEN s.${total.column} END)` : "NULL"} AS total
  FROM v_game_player_stats s WHERE ${competitionScope("s", leagueAndPeriod(input), params)}
  GROUP BY s.champion
),
ign AS (SELECT COUNT(DISTINCT s.game_id) AS games FROM v_game_player_stats s WHERE ${competitionScope("s", leagueAndPeriod(input), params)}),
bans AS (
  SELECT d.champion, COUNT(DISTINCT d.game_id) AS bans FROM v_draft d JOIN ev ON ev.game_id = d.game_id WHERE d.kind = 'ban' AND ${side("d")} GROUP BY d.champion
),
lines AS (
  SELECT c.name AS champion, c.icon_url AS icon, COALESCE(p.picks, 0) AS picks, COALESCE(p.all_picks, 0) AS all_picks,
         COALESCE(b.bans, 0) AS bans, n.games, COALESCE(p.wins, 0) AS wins,
         ROUND(100.0 * (COALESCE(p.all_picks, 0) + COALESCE(b.bans, 0)) / MAX(1, n.games), 1) AS presence,
         CASE WHEN p.picks > 0 THEN ROUND(100.0 * p.wins / p.picks, 1) END AS winrate,
         CASE WHEN p.picks > 0 AND p.ka IS NOT NULL THEN ROUND(1.0 * p.ka / MAX(1, p.deaths), 2) END AS kda,
         ${average ? `ROUND(p.average, ${CHAMPION_AVERAGE_UNIT[average].digits})` : "NULL"} AS average,
         ${total ? (total.ingame ? "i.total" : "p.total") : "NULL"} AS total,
         ROUND(p.dpm, 0) AS dpm, ROUND(p.gpm, 0) AS gpm, ROUND(p.cspm, 2) AS cspm,
         ROUND(i.gold_diff_15, 0) AS gold_diff_15, ROUND(i.cs_diff_15, 1) AS cs_diff_15, ROUND(i.xp_diff_15, 0) AS xp_diff_15,
         ROUND(i.first_blood, 1) AS first_blood, ROUND(i.solo_kills, 2) AS solo_kills,
         COALESCE(p.players, 0) AS players, COALESCE(i.ingame_picks, 0) AS ingame_picks, ign.games AS ingame_games,
         ${needsMinPicks(input) || totalSort ? minPicks : "0"} AS min_picks
  FROM champions c CROSS JOIN n CROSS JOIN ign
  LEFT JOIN picks p ON p.champion = c.name
  LEFT JOIN bans b ON b.champion = c.name
  LEFT JOIN ig i ON i.champion = c.name
  WHERE ${input.role ? "COALESCE(p.picks, 0) > 0" : "COALESCE(p.all_picks, 0) + COALESCE(b.bans, 0) > 0"}
)
SELECT *, ${order} AS sort_value FROM lines
WHERE picks >= min_picks AND (${order} IS NOT NULL${ingame ? " OR ingame_games = 0" : ""})
ORDER BY ${order} DESC, picks DESC, bans DESC, champion
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if ((needsMinPicks(input) || (totalSortOf(input) && input.minPicks != null)) && input.minPicks !== 1)
      out.push({ key: "minPicks", input: { ...input, minPicks: 1 }, note: "Trop peu de picks par champion dans ce périmètre : seuil abaissé à 1 pick.", reason: "seuil de picks abaissé" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const all = z.array(ChampionRankingRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const totalSort = totalSortOf(input);
    const label = totalSort ? { title: CHAMPION_TOTAL[totalSort].title, criterion: totalCriterion(totalSort) } : CHAMPION_SORT_LABEL[input.sort];
    const games = all[0]?.games ?? 0;
    const minPicks = all[0]?.min_picks ?? 0;
    const ingameGames = all[0]?.ingame_games ?? 0;
    const average = totalSort ? null : averageSortOf(input.sort);
    const extra = totalSort ? null : extraSortOf(input.sort);
    const role = `${input.role ? ` en ${ROLE_LABEL[input.role]}` : ""}${sideLabel(input.side)}`;
    const params: Params = {};
    // The Riot data has no game of the scope (the LPL): the figure is absent, not zero.
    const absent = CHAMPION_INGAME_SORTS.includes(input.sort) && ingameGames === 0;
    // A total ranks the champions that have one: none at all is a true zero over the scope, said as such.
    const rows = absent ? [] : totalSort ? all.filter((r) => (r.total ?? 0) > 0) : all;
    const ingamePicks = rows.reduce((n, r) => n + r.ingame_picks, 0);

    const counted =
      totalSort && CHAMPION_TOTAL[totalSort].ingame ? `${ingameGames}${ingameGames < games ? ` sur ${games}` : ""} parties avec données Riot` : `${games} parties`;

    const pages = selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT DISTINCT g.event_page FROM v_games g WHERE ${competitionScope("g", leagueAndPeriod(input), params)} ORDER BY g.played_at DESC LIMIT 12`,
      params,
    ).map((r) => r.event_page);

    const ongoingParams: Params = {};
    const ongoing = inProgressNote(db, competitionScope("g", leagueAndPeriod(input), ongoingParams), ongoingParams);

    const line = (r: z.infer<typeof ChampionRankingRow>, i: number) =>
      `${i + 1}. ${r.champion} (${totalSort ? `${totalText(totalSort, r.total)}, ` : ""}` +
      `${average ? `${frNumber(r.average)} ${CHAMPION_AVERAGE_UNIT[average].unit} par partie, ` : ""}${extra ? `${CHAMPION_EXTRA_TEXT[extra](r[extra])}, ` : ""}` +
      `${r.picks} pick${r.picks > 1 ? "s" : ""}, ${r.bans} ban${r.bans > 1 ? "s" : ""}, présence ${frNumber(r.presence)} %, ` +
      `${r.winrate == null ? "winrate n/d" : `${frNumber(r.winrate)} % de victoires`}, KDA ${frNumber(r.kda)})`;

    const threshold = minPicks ? `, minimum ${minPicks} picks` : "";
    const head = `Champions ${label.title}${role} ${scope || "toutes compétitions"}`;

    const ranking = absent
      ? `Aucune partie ${scope || "de ce périmètre"} n'a de données Riot sur Leaguepedia (${games} parties) : pas de ${CHAMPION_SORT_LABEL[input.sort].criterion.split(",")[0]} par champion.`
      : totalSort && !rows.length
        ? `Aucun ${CHAMPION_TOTAL[totalSort].one ?? CHAMPION_TOTAL[totalSort].unit}${role} ${scope || "toutes compétitions"} : 0 au total sur les ${counted}${threshold}.`
        : `${head} (${counted}) : ${rows.slice(0, 3).map(line).join(", ")}. Critère : ${label.criterion}${threshold}.`;

    const facts =
      ranking +
      (rows.length && input.role
        ? ` Picks, victoires, KDA et moyennes${role} seulement ; bans et présence${sideLabel(input.side)} tous rôles confondus.`
        : rows.length && input.side
          ? ` Picks, bans et présence${role} seulement, sur les ${games} parties.`
          : "") +
      (ongoing ? ` ${ongoing}` : "");

    const multikill = CHAMPION_MULTIKILL_SORTS.findIndex((m) => m === totalSort);
    const lowerMultikill = multikill >= 0 ? (CHAMPION_MULTIKILL_SORTS[multikill + 1] ?? null) : null;
    const where = `${inLeague(league) || "aux Worlds"}${input.yearFrom != null && input.yearFrom === input.yearTo ? ` ${input.yearFrom}` : ""}`;

    // A total or a per-game average is one more column, named as the sort: the champion layout gives it the bar.
    const figure = totalSort ? `total_${totalSort}` : average;

    const out: ToolOutput = {
      title: `Champions ${label.title}${role}${league === "toutes compétitions" ? "" : ` — ${league}`}${hasPeriod(input) ? ` ${scopeLabel("toutes compétitions", input).replace(/^en /, "")}` : ""}`,
      icons: Object.fromEntries(rows.flatMap((r) => (r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [
        ...eventSources(pages, 12),
        ...(ingamePicks || (totalSort && CHAMPION_TOTAL[totalSort].ingame && ingameGames) ? [RIOT_DATA_SOURCE] : []),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: rows.length
        ? rows.slice(0, 2).map((r) => `Stats de ${r.champion} ${where}`)
        : [
            // No champion to look at: the next multikill down, and the champions of the same scope.
            ...(lowerMultikill ? [`Champions avec le plus de ${CHAMPION_TOTAL[lowerMultikill].unit} ${where}`] : []),
            `Champions les plus joués ${where}`,
          ],
      totals: {
        leader: rows[0]?.champion ?? "",
        leader_value: rows[0]?.sort_value ?? 0,
        leader_picks: rows[0]?.picks ?? 0,
        leader_bans: rows[0]?.bans ?? 0,
        rows: rows.length,
        games,
        ingame_games: ingameGames,
        min_picks: minPicks,
      },
    };

    // An absent figure or a true zero is said in the facts: no empty table under it.
    if (!absent && (rows.length || !totalSort))
      out.table = {
        columns: figure ? ["rank", "champion", figure, ...CHAMPION_RANKING_COLUMNS.slice(2)] : [...CHAMPION_RANKING_COLUMNS],
        rows: rows.map((r, i) => [i + 1, r.champion, ...(figure ? [totalSort ? r.total : r.average] : []), r.picks, r.bans, r.presence, r.winrate, r.kda, ...CHAMPION_EXTRA_SORTS.map((c) => r[c])]),
      };

    return out;
  },
  // The router model tends to set a minimum of 1 for "top 5": below 3 picks, the default threshold keeps a winrate meaningful.
  // A multikill is only ever a total; `total` means nothing for a figure that is not a count or a sum.
  normalize: (_db, input) => ({
    ...input,
    total: CHAMPION_TOTAL_SORTS.some((s) => s === input.sort) && (input.total === true || CHAMPION_MULTIKILL_SORTS.some((s) => s === input.sort)),
    minPicks: input.minPicks != null && input.minPicks >= 3 ? input.minPicks : null,
  }),
};

// 4c. A player's or a team's champion pool ---------------------------------------------

/** Columns of the champion pool table; the team pool adds who played each champion. */
export const CHAMPION_POOL_COLUMNS = ["rank", "champion", "games", "wins", "losses", "winrate", "kda", "share"] as const;

const ChampionPoolRow = z.object({
  champion: Text,
  icon: NullableText,
  games: z.number(),
  wins: z.number(),
  kda: z.number().nullable(),
  players: jsonColumn(z.array(z.object({ player: z.string(), games: z.number() }))),
  total_games: z.number(),
  total_wins: z.number(),
  total_picks: z.number(),
  unique_champions: z.number(),
});

/** The picks of a pool's scope: the player's or the team's games in the competition, period and split. */
function poolScope(db: DatabaseSync, input: ChampionPoolInput, params: Params): string {
  const who =
    input.subject === "player"
      ? ((params.player = input.name), "gp.player = :player")
      : `gp.team IN (${inList("team", teamMembers(db, input.name).members, params)})`;

  const league = input.league ? `AND ${leagueFilter("gp.league", input, params)}` : "";
  const split = input.split ? ((params.split = input.split), "AND gp.tournament_page IN (SELECT t.tournament_page FROM v_tournaments t WHERE t.split = :split)") : "";

  return `${who} AND gp.champion IS NOT NULL AND gp.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("gp.year", input, params)} ${split}`;
}

const championPool: ToolDef<ChampionPoolInput> = {
  name: "champion_pool",
  label: "champion pool",
  description:
    "The champion pool of one player, or of one team (every champion its players picked), in a competition, period and split: games, " +
    "W-L, win rate and KDA on each champion, its share of the pool, and the pool's diversity (distinct champions, share of the three most played). " +
    "Use it for 'champion pool de Faker', 'quels champions joue Keria', 'champions joués par T1 aux Worlds 2023'.",
  plan: (db, input) => {
    const params: Params = {};

    // Who played each champion is aggregated once and joined: a correlated subquery rescanned every pick per champion (10 s for T1).
    return {
      params,
      sql: tidy(`WITH picks AS (
  SELECT gp.game_id, gp.champion, gp.player, gp.win, gp.kills, gp.deaths, gp.assists
  FROM v_game_players gp
  WHERE ${poolScope(db, input, params)}
),
tot AS (
  SELECT COUNT(DISTINCT game_id) AS total_games, COUNT(DISTINCT CASE WHEN win = 1 THEN game_id END) AS total_wins,
         COUNT(*) AS total_picks, COUNT(DISTINCT champion) AS unique_champions
  FROM picks
),
by_player AS (SELECT champion, player, COUNT(*) AS games FROM picks GROUP BY champion, player),
pool_players AS (
  SELECT b.champion, json_group_array(json_object('player', b.player, 'games', b.games) ORDER BY b.games DESC, b.player) AS players
  FROM by_player b GROUP BY b.champion
)
SELECT p.champion, c.icon_url AS icon, COUNT(*) AS games, SUM(p.win) AS wins,
       ROUND(1.0 * ${kaSum("p")}
             / MAX(1, ${deathsSum("p")}), 2) AS kda,
       pp.players, tot.total_games, tot.total_wins, tot.total_picks, tot.unique_champions
FROM picks p JOIN pool_players pp ON pp.champion = p.champion CROSS JOIN tot
LEFT JOIN champions c ON c.name = p.champion
GROUP BY p.champion
ORDER BY games DESC, wins DESC, p.champion
LIMIT 200`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.split) out.push({ key: "split", input: { ...input, split: null }, note: `Aucune partie en ${input.split} : toute la saison.`, reason: "filtre de split retiré" });

    if (hasPeriod(input)) out.push(noPeriod({ ...input, split: null }, "toutes les saisons"));

    if (input.subject !== "player") return out;
    const resolved = entities.players.find((p) => p.player === input.name || p.otherCandidates.includes(input.name));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.name)
        out.push({
          key: `player:${other}`,
          input: { ...input, name: other },
          note: `« ${resolved!.mention} » désigne aussi ${other} : champion pool de ${other}.`,
          reason: `alias homonyme essayé : ${other}`,
        });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(ChampionPoolRow).parse(sqlRows);
    const first = rows[0];
    const league = leagueShortName(db, input.league);
    const scope = [scopeLabel(league, input), input.split ? `(${input.split})` : ""].filter(Boolean).join(" ");
    const team = input.subject === "team";
    const name = team ? displayTeam(input.name) : input.name;
    const share = (games: number) => Math.round((1000 * games) / Math.max(1, first.total_picks)) / 10;

    const lines: ChampionPoolLine[] = rows.map((r) => ({
      champion: r.champion,
      icon: r.icon,
      games: r.games,
      wins: r.wins,
      losses: r.games - r.wins,
      winrate: Math.round((1000 * r.wins) / Math.max(1, r.games)) / 10,
      kda: r.kda,
      share: share(r.games),
      players: team ? r.players : [],
    }));

    const top3Share = share(rows.slice(0, 3).reduce((n, r) => n + r.games, 0));

    const pool: ChampionPool = {
      subject: input.subject,
      name,
      scope,
      games: first.total_games,
      wins: first.total_wins,
      losses: first.total_games - first.total_wins,
      picks: first.total_picks,
      unique: first.unique_champions,
      top3Share,
      lines,
    };

    const params: Params = {};

    const pages = selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT DISTINCT gp.event_page FROM v_game_players gp WHERE ${poolScope(db, input, params)} ORDER BY gp.played_at DESC LIMIT 12`,
      params,
    ).map((r) => r.event_page);

    const line = (l: ChampionPoolLine) =>
      `${l.champion} (${l.games} partie${l.games > 1 ? "s" : ""}, ${l.wins}-${l.losses}, ${frNumber(l.winrate)} % de victoires, KDA ${frNumber(l.kda)}` +
      `${team && l.players[0] ? `, surtout ${l.players[0].player}` : ""})`;

    const facts =
      `Champion pool de ${name}${scope ? ` ${scope}` : " toutes compétitions"} : ${pool.unique} champion${pool.unique > 1 ? "s" : ""} différent${pool.unique > 1 ? "s" : ""} ` +
      `sur ${pool.games} partie${pool.games > 1 ? "s" : ""} (${pool.wins} victoire${pool.wins > 1 ? "s" : ""}, ${pool.losses} défaite${pool.losses > 1 ? "s" : ""})${team ? `, ${pool.picks} picks` : ""}. ` +
      `Les plus joués : ${lines.slice(0, 3).map(line).join(", ")}. ` +
      `Les ${Math.min(3, lines.length)} premiers font ${frNumber(top3Share)} % du pool.`;

    const ongoingParams: Params = {};
    const ongoing = inProgressNote(db, `g.game_id IN (SELECT gp.game_id FROM v_game_players gp WHERE ${poolScope(db, input, ongoingParams)})`, ongoingParams);
    const period = input.yearFrom != null && input.yearFrom === input.yearTo ? ` ${input.yearFrom}` : "";
    const where = inLeague(league);

    return {
      title: `Champion pool — ${name}${league === "toutes compétitions" ? "" : ` — ${league}`}${hasPeriod(input) ? ` ${scopeLabel("toutes compétitions", input).replace(/^en /, "")}` : ""}${input.split ? ` ${input.split}` : ""}`,
      pool,
      table: {
        columns: [...CHAMPION_POOL_COLUMNS, ...(team ? ["players"] : [])],
        rows: lines.map((l, i) => [
          i + 1, l.champion, l.games, l.wins, l.losses, l.winrate, l.kda, l.share,
          ...(team ? [l.players.slice(0, 3).map((p) => `${p.player} ×${p.games}`).join(", ")] : []),
        ]),
      },
      icons: Object.fromEntries(lines.flatMap((l) => (l.icon ? [[l.champion, l.icon]] : []))),
      facts,
      notes: ongoing ? [ongoing] : [],
      sources: [
        { label: `Leaguepedia — ${input.name}`, url: wikiUrl(input.name) },
        ...eventSources(pages, 12),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: [
        ...lines.slice(0, 1).map((l) => `Stats ${/^[AEIOUYH]/i.test(l.champion) ? "d'" : "de "}${l.champion} ${where || "aux Worlds"}${period}`),
        team ? `Historique de ${name}${where ? ` ${where}` : ""}` : `Résultats de ${name} ${where || "à tous les Worlds"}`,
        `Champions les plus joués ${where || "aux Worlds"}${period}`,
      ],
      totals: {
        games: pool.games,
        wins: pool.wins,
        losses: pool.losses,
        picks: pool.picks,
        unique: pool.unique,
        top3_share: top3Share,
        top: lines[0]?.champion ?? "",
        top_games: lines[0]?.games ?? 0,
        top_wins: lines[0]?.wins ?? 0,
        top_kda: lines[0]?.kda ?? "n/d",
        rows: lines.length,
      },
    };
  },
  normalize: (db, input) => {
    if (input.subject === "team") {
      const t = resolveTeam(db, input.name);

      return t ? { ...input, name: t.team } : null;
    }

    const p = resolvePlayer(db, input.name, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, name: p.player } : null;
  },
};

// 5. Standings / roll of honour -------------------------------------------------------

const tournamentStandings: ToolDef<StandingsInput> = {
  name: "tournament_standings",
  label: "palmarès / classement",
  description:
    "Final standings of a competition: every placement of one edition (full), or the champion and finalist of each edition (roll of honour).",
  plan: (_db, input) => {
    const params: Params = {};

    

    const filters: string[] = [];

    if (input.split) {
      filters.push("AND t.split = :split");
      params.split = input.split;
    }

    if (!input.full) {
      filters.push("AND tr.place_number <= 2");
      // A regular season with its own playoffs: the title is the playoffs one.
      filters.push(`AND NOT ${regularSeason("t")}`);
    }

    return {
      params,
      sql: tidy(`SELECT tr.year, tr.event_page, tr.tournament, t.stage, t.split, t.date_start,
       tr.place, tr.place_number, tr.team, tr.prize_usd
FROM v_tournament_results tr
JOIN v_tournaments t ON t.tournament_page = tr.event_page
WHERE ${leagueFilter("tr.league", input, params)}
  AND t.stage IN (${STANDINGS_STAGES})
  ${periodFilter("tr.year", input, params)}
  ${filters.join("\n  ")}
ORDER BY t.date_start, tr.event_page, tr.place_number IS NULL, tr.place_number, tr.team`),
    };
  },
  relaxations: (input) =>
    input.split
      ? [{ key: "split", input: { ...input, split: null }, note: `Aucun classement pour le split ${input.split} : affichage de toute l'année.`, reason: "filtre de split retiré" }]
      : [],
  format: (db, input, sqlRows): ToolOutput => {
    const raw = z.array(StandingsRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const pages = [...new Set(raw.map((r) => String(r.event_page)))];
    const winnerOf = (page: string) => raw.find((r) => r.event_page === page && r.place_number === 1);
    const nameOf = (page: string) => raw.find((r) => r.event_page === page)?.tournament ?? page;

    const sources = [
      ...eventSources(pages, 30),
    ];

    if (input.full) {
      const multi = pages.length > 1;
      const champions = pages.flatMap((p) => winnerOf(p) ?? []);

      const facts =
        pages
          .map((p) => {
            const w = winnerOf(p);
            const f = raw.find((r) => r.event_page === p && r.place_number === 2);
            const name = nameOf(p);

            return w
              ? `${name} : ${displayTeam(String(w.team))} champion${f ? `, ${displayTeam(String(f.team))} finaliste` : ""}.`
              : `${name} : finale pas encore publiée sur Leaguepedia.`;
          })
          .join(" ") + ` ${raw.length} équipes classées.`;

      return {
        title: `Classement — ${pages.length === 1 ? nameOf(pages[0]) : `${league} ${span(raw.map((r) => r.year))}`}`,
        table: {
          columns: [...(multi ? ["Tournoi"] : []), "Place", "Équipe", "Gains (USD)"],
          rows: raw.map((r) => [
            ...(multi ? [nameOf(r.event_page)] : []),
            r.place ? `${placeLabel(r.place)} (${r.place})` : "—",
            displayTeam(r.team),
            r.prize_usd == null ? null : Math.round(r.prize_usd),
          ]),
        },
        facts,
        sources,
        followUps: champions.slice(0, 2).map((w) => `Historique de ${displayTeam(w.team)}`),
        totals: { champion: champions[0] ? displayTeam(champions[0].team) : "", teams: raw.length, events: pages.length },
      };
    }

    const editions = pages.map((p) => {
      const w = winnerOf(p);
      const f = raw.find((r) => r.event_page === p && r.place_number === 2);

      return {
        year: raw.find((r) => r.event_page === p)?.year ?? 0,
        tournament: nameOf(p),
        winner: w ? displayTeam(w.team) : null,
        finalist: f ? displayTeam(f.team) : null,
      };
    });

    const rows = editions.map((e) => [e.year, e.tournament, e.winner ?? "—", e.finalist ?? "—"]);
    const count = new Map<string, number>();

    for (const e of editions) if (e.winner) count.set(e.winner, (count.get(e.winner) ?? 0) + 1);
    const ranking = [...count].sort((x, y) => y[1] - x[1]);
    const latest = editions.findLast((e) => e.winner)?.winner ?? "";

    const facts =
      `Palmarès ${league === "Worlds" ? "des Worlds" : `de ${league}`}${input.split ? ` (${input.split})` : ""} : ${rows.length} tournois (${span(editions.map((e) => e.year))}). ` +
      (ranking.length
        ? `Plus titrés : ${ranking.slice(0, 3).map(([t, n]) => `${t} (${n})`).join(", ")}. Dernier vainqueur : ${latest}.`
        : "Aucun vainqueur publié.");

    return {
      title: `Palmarès — ${league}${hasPeriod(input) ? ` ${yearSpan(editions.map((e) => e.year))}` : ""}`,
      table: { columns: ["Année", "Tournoi", "Vainqueur", "Finaliste"], rows },
      facts,
      sources,
      followUps: ranking.slice(0, 2).map(([t]) => `Historique de ${t}`),
      totals: { events: rows.length, most_titles: ranking[0]?.[0] ?? "", most_titles_count: ranking[0]?.[1] ?? 0, latest_champion: latest },
    };
  },
  normalize: (_db, input) => input,
};

// In-game stats (Riot JSON on Leaguepedia, not the LPL) ------------------------------

/** Where the in-game numbers come from, cited with every in-game answer. */
const RIOT_DATA_SOURCE: Source = {
  label: "Leaguepedia — données Riot des parties (PostgameJsonMetadata)",
  url: wikiUrl("Special:CargoTables/PostgameJsonMetadata"),
};

/** "2024", or "2019–2024". */
const yearSpan = (years: number[]) => (years.length && Math.min(...years) === Math.max(...years) ? String(years[0]) : span(years));

const signed = (n: number | null) => (n == null ? "n/d" : `${n > 0 ? "+" : ""}${n}`);
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** SQL aggregate of a metric column: totals for counts, averages, percentages for 0/1 flags. */
function aggregateSql(aggregate: "sum" | "avg" | "rate", column: string): string {
  if (aggregate === "sum") return `SUM(${column})`;

  if (aggregate === "rate") return `ROUND(100.0 * AVG(${column}), 1)`;

  // Gold and XP in whole units, the rest (CS, wards, plates) to one decimal.
  return `ROUND(AVG(${column}), ${/gold|xp/.test(column) ? 0 : 1})`;
}

/** Shared WHERE clause of the in-game tools (`s` is the stats view). */
function ingameScope(input: { league: string | null } & Period, params: Params): string {
  return competitionScope("s", leagueAndPeriod(input), params);
}

/** Games of the scope, and how many of them have Riot data. */
function coverage(db: DatabaseSync, sql: string, params: Params) {
  return selectOne(db, z.object({ games: z.number(), ingame: z.number() }), sql, params) ?? { games: 0, ingame: 0 };
}

const coverageNote = (c: { games: number; ingame: number }) =>
  c.ingame < c.games
    ? ` Données in-game disponibles pour ${c.ingame} parties sur ${c.games} (Leaguepedia ne publie pas les données Riot de toutes les parties, aucune en LPL).`
    : "";

/** Metrics of the player overview, then the one the question asks about. */
const PLAYER_OVERVIEW: PlayerMetric[] = ["solo_kills", "penta_kills", "first_bloods", "kills_before_10", "gold_diff", "cs_diff", "wards_placed"];

const PLAYER_COLUMN_LABELS: Record<PlayerMetric, string> = {
  solo_kills: "Solo kills",
  penta_kills: "Pentakills",
  quadra_kills: "Quadrakills",
  triple_kills: "Triple kills",
  double_kills: "Double kills",
  first_bloods: "First bloods",
  kills_before_10: "Kills < 10 min",
  gold_diff: "Écart or",
  cs_diff: "Écart CS",
  xp_diff: "Écart XP",
  gold: "Or",
  cs: "CS",
  xp: "XP",
  wards_placed: "Wards / partie",
  wards_killed: "Wards détruites / partie",
  control_wards: "Control wards / partie",
  plates: "Plaques",
};

/** The metric the question asks about first, then the overview. */
const playerMetricsOf = (input: PlayerIngameInput): PlayerMetric[] =>
  input.metric ? [input.metric, ...PLAYER_OVERVIEW.filter((m) => m !== input.metric)] : PLAYER_OVERVIEW;

const IngameRow = z
  .object({ year: z.number().nullable(), league_short: z.string().nullable(), games: z.number(), wins: z.number(), pages: pageList, stats_page: z.string().nullable() })
  .catchall(z.number().nullable());

// 6. A player's in-game stats -----------------------------------------------------------

const playerIngameStats: ToolDef<PlayerIngameInput> = {
  name: "player_ingame_stats",
  label: "stats in-game d'un joueur",
  description:
    "A player's in-game stats from the Riot game data, season by season: solo kills, multi-kills, first bloods, kills before 10 min, " +
    "gold/CS/XP and their difference with the lane opponent at 10/15/20 min, wards, plates. Not available for the LPL.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const cols = playerMetricsOf(input)
      .map((m) => `${aggregateSql(PLAYER_METRIC_DEFS[m].aggregate, `s.${metricColumn(PLAYER_METRIC_DEFS[m], input.minute)}`)} AS ${m}`)
      .join(",\n         ");

    const scope = ingameScope(input, params);

    return {
      params,
      sql: tidy(`WITH base AS (
  SELECT * FROM v_game_player_stats s
  WHERE s.player = :player AND ${scope}
)
SELECT 0 AS is_total, s.year, s.league_short, MIN(s.played_at) AS first_game, COUNT(*) AS games, SUM(s.win) AS wins,
       ${cols},
       json_group_array(DISTINCT s.event_page) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null },
        note: "Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.",
        reason: "filtre de compétition retiré",
      });
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({ key: `player:${other}`, input: { ...input, player: other }, note: `« ${resolved!.mention} » désigne aussi ${other} : stats de ${other}.`, reason: `alias homonyme essayé : ${other}` });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const metrics = playerMetricsOf(input);
    const league = leagueShortName(db, input.league);
    const num = (r: z.infer<typeof IngameRow>, m: PlayerMetric) => (r[m] == null ? null : Number(r[m]));
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_game_players s JOIN v_games g USING (game_id) WHERE s.player = :player AND ${ingameScope(input, params)}`, params);
    const minute = input.minute ?? 15;
    const val = (m: PlayerMetric) => num(total, m);
    const fb = val("first_bloods");

    const parts: Record<PlayerMetric, string> = {
      solo_kills: `${val("solo_kills") ?? "n/d"} solo kills`,
      penta_kills: `${val("penta_kills") ?? "n/d"} pentakill${(val("penta_kills") ?? 0) > 1 ? "s" : ""}`,
      quadra_kills: `${val("quadra_kills") ?? "n/d"} quadrakills`,
      triple_kills: `${val("triple_kills") ?? "n/d"} triple kills`,
      double_kills: `${val("double_kills") ?? "n/d"} double kills`,
      first_bloods: fb == null ? "first bloods n/d" : `${fb} first blood${fb > 1 ? "s" : ""} (${pct(fb, total.games)} % des parties)`,
      kills_before_10: `${val("kills_before_10") ?? "n/d"} kills avant 10 min`,
      gold_diff: `un écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min face à son adversaire direct`,
      cs_diff: `un écart de CS moyen de ${signed(val("cs_diff"))} à ${minute} min`,
      xp_diff: `un écart d'XP moyen de ${signed(val("xp_diff"))} à ${minute} min`,
      gold: `${val("gold") ?? "n/d"} d'or en moyenne à ${minute} min`,
      cs: `${val("cs") ?? "n/d"} CS en moyenne à ${minute} min`,
      xp: `${val("xp") ?? "n/d"} XP en moyenne à ${minute} min`,
      wards_placed: `${val("wards_placed") ?? "n/d"} wards posées par partie`,
      wards_killed: `${val("wards_killed") ?? "n/d"} wards détruites par partie`,
      control_wards: `${val("control_wards") ?? "n/d"} control wards achetées par partie`,
      plates: `${val("plates") ?? "n/d"} plaques de tourelle`,
    };

    const facts =
      `${input.player}${league === "toutes compétitions" ? "" : ` ${inLeague(league)}`} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), ` +
      `sur ${total.games} parties avec données in-game : ${metrics.map((m) => parts[m]).join(", ")}.` +
      coverageNote(cov);

    const pages = rows.flatMap((r) => r.pages);
    const statsPages = rows.flatMap((r) => r.stats_page ?? []).slice(-3);

    return {
      title: `${input.player} — stats in-game${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Année", "Compétition", "Parties", "V-D", ...metrics.map((m) => (PLAYER_METRIC_DEFS[m].snapshot ? `${PLAYER_COLUMN_LABELS[m]} @${minute}` : PLAYER_COLUMN_LABELS[m]))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...metrics.map((m) => num(r, m))]),
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(pages, 10),
        ...statsPages.map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })),
        RIOT_DATA_SOURCE,
      ],
      followUps: [
        input.league ? `Joueurs avec le plus de solo kills ${inLeague(league)}` : "Joueurs avec le plus de solo kills aux Worlds",
        `Résultats de ${input.player} ${input.league ? inLeague(league) : "aux Worlds"}`,
      ],
      totals: {
        games: total.games,
        coverage_games: cov.games,
        // n/d: no game of the scope has this metric (no timeline, or no plate events before match-v5).
        ...Object.fromEntries(metrics.map((m) => [m, val(m) ?? "n/d"])),
      },
    };
  },
  normalize: (db, input) => {
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// 7. Leaderboard on an in-game metric --------------------------------------------------

const LeaderRow = z.object({ name: z.string(), team: z.string().nullable(), games: z.number(), counted: z.number(), total: z.number().nullable(), average: z.number().nullable() });

function leaderboardMetric(input: LeaderboardInput) {
  if (input.subject === "team") {
    const key = TEAM_METRICS.find((m) => m === input.metric);

    if (!key) throw new Error(`Métrique équipe invalide : ${input.metric}`);

    return { def: TEAM_METRIC_DEFS[key], key };
  }

  const key = PLAYER_METRICS.find((m) => m === input.metric);

  if (!key) throw new Error(`Métrique joueur invalide : ${input.metric}`);

  return { def: PLAYER_METRIC_DEFS[key], key };
}

/** Averages and rates need enough games to mean something. */
function minGamesOf(input: LeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (leaderboardMetric(input).def.aggregate === "sum") return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  return input.league && oneSeason ? 5 : 15;
}

const ingameLeaderboard: ToolDef<LeaderboardInput> = {
  name: "ingame_leaderboard",
  label: "classement sur une stat in-game",
  description:
    "Ranks players (or teams) of a competition and period on one in-game metric from the Riot game data: solo kills, pentakills, first bloods, " +
    "kills before 10 min, gold/CS/XP difference at 10/15/20 min, wards, plates; teams: first blood/tower/dragon/herald/baron rate, gold difference. " +
    "Optionally on one side of the map only. Not available for the LPL.",
  plan: (db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOf(input) });

    const { def } = leaderboardMetric(input);
    const column = `s.${metricColumn(def, input.minute)}`;
    const view = input.subject === "team" ? "v_game_team_stats" : "v_game_player_stats";
    const name = input.subject === "team" ? franchiseName(db, "s.team", params) : "s.player";
    const filters = [ingameScope(input, params)];

    if (input.subject === "player" && input.role) {
      filters.push("AND s.role = :role");
      params.role = input.role;
    }

    if (input.side) filters.push(`AND s.side = ${SIDE_ID[input.side]}`);

    const value = def.aggregate === "sum" ? "total" : "average";
    const average = def.aggregate === "rate" ? `100.0 * AVG(${column})` : `AVG(${column})`;

    return {
      params,
      sql: tidy(`SELECT ${name} AS name, ${input.subject === "team" ? "NULL" : "s.team"} AS team, MAX(s.played_at) AS last_game,
       COUNT(*) AS games, COUNT(${column}) AS counted, SUM(${column}) AS total, ROUND(${average}, 2) AS average
FROM ${view} s
WHERE ${filters.join(" ")}
GROUP BY 1
HAVING COUNT(${column}) >= :minGames${def.aggregate === "sum" ? ` AND SUM(${column}) > 0` : ""}
ORDER BY ${value} DESC, games ASC, name
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.minGames == null && minGamesOf(input) > 3)
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: "Peu de parties par joueur dans ce périmètre : seuil abaissé à 3 parties.", reason: "seuil de parties abaissé" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(LeaderRow).parse(sqlRows);
    const { def } = leaderboardMetric(input);
    const label = metricLabel(def, input.minute);
    const league = leagueShortName(db, input.league);
    const params: Params = {};
    const scope = ingameScope(input, params);
    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE ${scope}`, params);
    const pages = selectAll(db, z.object({ event_page: z.string() }), `SELECT DISTINCT s.event_page FROM v_games s WHERE ${scope} AND s.has_ingame ORDER BY s.played_at DESC LIMIT 12`, params).map((r) => r.event_page);
    const value = (r: z.infer<typeof LeaderRow>) => (def.aggregate === "sum" ? (r.total ?? 0) : round1(r.average));
    const unit = def.aggregate === "rate" ? " %" : "";
    const who = input.subject === "team" ? "Équipe" : "Joueur";
    const minGames = minGamesOf(input);
    const years = selectAll(db, z.object({ year: z.number().nullable() }), `SELECT DISTINCT s.year FROM v_games s WHERE ${scope} AND s.has_ingame`, params).flatMap((r) => (r.year == null ? [] : [r.year]));
    const scopeLabel = [inLeague(league), years.length ? `(${yearSpan(years)})` : ""].filter(Boolean).join(" ");
    const roleLabel = `${input.role ? ` (rôle ${input.role})` : ""}${sideLabel(input.side)}`;

    const totals: ToolOutput["totals"] = {
      leader: rows[0] ? displayTeam(rows[0].name) : "",
      leader_value: rows[0] ? (value(rows[0]) ?? 0) : 0,
      rows: rows.length,
      ingame_games: cov.ingame,
    };

    // A rate's leader: how many games had it ("6 first dragons").
    if (def.aggregate === "rate") totals.leader_count = rows[0]?.total ?? 0;

    const facts =
      `${def.aggregate === "sum" ? "Total de" : def.aggregate === "rate" ? "Part des parties avec" : "Moyenne par partie de"} ${label}${roleLabel} ${scopeLabel} : ` +
      rows.slice(0, 3).map((r, i) => `${i + 1}. ${displayTeam(r.name)} (${def.aggregate === "rate" ? `${r.total ?? 0} sur ${r.counted} parties, ${value(r)}${unit}` : `${value(r)}${unit}, ${r.games} parties`})`).join(", ") +
      `. ${cov.ingame} parties avec données in-game${def.aggregate === "sum" ? "" : `, minimum ${minGames} parties par ${input.subject === "team" ? "équipe" : "joueur"}`}.` +
      coverageNote(cov);

    return {
      title: `Classement — ${label}${roleLabel}${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        // A rate shows its count too: "11 first dragons in 17 games, 64.7 %".
        columns: ["Rang", who, ...(input.subject === "player" ? ["Équipe (dernière)"] : []), "Parties", ...(def.aggregate === "rate" ? ["Nombre"] : []), def.aggregate === "sum" ? "Total" : def.aggregate === "rate" ? "%" : "Moyenne", ...(def.aggregate === "sum" ? ["Par partie"] : [])],
        rows: rows.map((r, i) => [
          i + 1,
          displayTeam(r.name),
          ...(input.subject === "player" ? [r.team ? displayTeam(r.team) : null] : []),
          r.games,
          ...(def.aggregate === "rate" ? [r.total ?? 0] : []),
          value(r),
          ...(def.aggregate === "sum" ? [Math.round((100 * (r.total ?? 0)) / Math.max(1, r.counted)) / 100] : []),
        ]),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.name}`, url: wikiUrl(r.name) })),
        ...eventSources(pages, 12),
        RIOT_DATA_SOURCE,
      ],
      followUps: rows.slice(0, 2).map((r) => (input.subject === "team" ? `Stats in-game de ${displayTeam(r.name)}` : `Stats in-game de ${r.name}`)),
      totals,
    };
  },
  normalize: (_db, input) => {
    const valid = input.subject === "team" ? TEAM_METRICS.some((m) => m === input.metric) : PLAYER_METRICS.some((m) => m === input.metric);

    return valid ? input : null;
  },
};

/** How recent an edition's last game must be, against the newest game of the database, to count as in progress. */
const IN_PROGRESS_DAYS = 30;

const DAY_FR = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Editions of the scope still being played: no champion in their standings yet, and a game within
 * IN_PROGRESS_DAYS of the newest game of the database (an old group stage without a winner is not one).
 * The answer then says its figures are those of the games played so far.
 */
function inProgressNote(db: DatabaseSync, scope: string, params: Params): string | null {
  const rows = selectAll(
    db,
    z.object({ tournament: NullableText, event_page: Text, games: z.number(), last: z.number() }),
    `SELECT MIN(g.tournament) AS tournament, g.event_page, COUNT(*) AS games, MAX(g.played_at) AS last FROM v_games g
     WHERE ${scope} AND g.played_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM v_tournament_results r WHERE r.event_page = g.event_page AND r.place_number = 1)
     GROUP BY g.event_page
     HAVING MAX(g.played_at) >= (SELECT MAX(played_at) FROM v_games) - ${IN_PROGRESS_DAYS} * 86400`,
    params,
  );

  if (!rows.length) return null;

  return rows
    .map((r) => `${(r.tournament ?? r.event_page).replace(/ (Main Event|Season)$/, "")} en cours : chiffres sur les ${r.games} parties jouées jusqu'au ${DAY_FR.format(new Date(r.last * 1000))}, sans le reste de la compétition.`)
    .join(" ");
}

// 7b. Players of a role ranked on an end-of-game criterion -----------------------------------

type CriterionDef = {
  /** Column header and sentence label. */
  label: string;
  /** How the figure is computed, said in the answer. */
  definition: string;
  /** Aggregate over the scope, in SQL (columns of the `base` CTE). */
  sql: string;
  /** A total (every game counts, no minimum of games by default) rather than a rate or an average. */
  total?: true;
  unit?: string;
};

/** Per-minute figures: over the games that have both the figure and the game's length. */
const perMinute = (column: string, digits: number) =>
  `ROUND(60.0 * SUM(CASE WHEN b.length_s > 0 THEN b.${column} END) / SUM(CASE WHEN b.length_s > 0 AND b.${column} IS NOT NULL THEN b.length_s END), ${digits})`;

/** A player's share of their team's total, in %: over the games where both figures exist. */
const teamShare = (column: string) =>
  `ROUND(100.0 * SUM(CASE WHEN b.team_${column} > 0 THEN b.${column} END) / SUM(CASE WHEN b.team_${column} > 0 AND b.${column} IS NOT NULL THEN b.team_${column} END), 1)`;

export const PLAYER_CRITERION_DEFS: Record<PlayerCriterion, CriterionDef> = {
  kda: { label: "KDA", definition: "(kills + assists) / morts, sur toutes leurs parties", sql: `ROUND(1.0 * ${kaSum("b")} / MAX(1, ${deathsSum("b")}), 2)` },
  winrate: { label: "% victoires", definition: "victoires / parties", sql: "ROUND(100.0 * SUM(b.win) / COUNT(*), 1)", unit: " %" },
  games: { label: "parties", definition: "nombre de parties jouées", sql: "COUNT(*)", total: true },
  kills: { label: "kills", definition: "total des kills", sql: "SUM(b.kills)", total: true },
  assists: { label: "assists", definition: "total des assists", sql: "SUM(b.assists)", total: true },
  kp: {
    label: "KP %",
    definition: "participation aux kills, (kills + assists) / kills de l'équipe",
    sql: "ROUND(100.0 * SUM(CASE WHEN b.team_kills > 0 THEN b.kills + b.assists END) / SUM(CASE WHEN b.team_kills > 0 AND b.kills IS NOT NULL AND b.assists IS NOT NULL THEN b.team_kills END), 1)",
    unit: " %",
  },
  dmg_share: { label: "DMG %", definition: "part des dégâts aux champions de son équipe", sql: teamShare("damage"), unit: " %" },
  gold_share: { label: "or %", definition: "part de l'or de son équipe", sql: teamShare("gold"), unit: " %" },
  dpm: { label: "DPM", definition: "dégâts aux champions par minute", sql: perMinute("damage", 0) },
  cspm: { label: "CS/min", definition: "CS par minute", sql: perMinute("cs", 2) },
  gpm: { label: "or/min", definition: "or gagné par minute", sql: perMinute("gold", 0) },
  vspm: { label: "vision/min", definition: "score de vision par minute", sql: perMinute("vision", 2) },
};

/** Every criterion is a column of the table, the ranking one first. */
const LEADERBOARD_COLUMNS: PlayerCriterion[] = ["kda", "winrate", "kp", "dmg_share", "gold_share", "dpm", "cspm", "gpm", "vspm"];

const PlayerLeaderRow = z
  .object({ player: Text, team: NullableText, games: z.number(), wins: z.number(), gold_diff_15: z.number().nullable(), ingame_games: z.number() })
  .catchall(z.number().nullable());

const isInternational = (league: string | null) => LEAGUES.some((l) => l.name === league && l.international);

/** Rates and averages need enough games: 5 in one international event, 10 in one league season, else 20. */
export function minGamesOfLeaderboard(input: PlayerLeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (PLAYER_CRITERION_DEFS[input.criterion].total) return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  if (input.league && oneSeason) return isInternational(input.league) ? 5 : 10;

  return 20;
}

const playerLeaderboard: ToolDef<PlayerLeaderboardInput> = {
  name: "player_leaderboard",
  label: "classement de joueurs",
  description:
    "Ranks the players of a competition and period, optionally of one role (top, jungle, mid, ADC/bot, support), on an explicit criterion " +
    "from the end-of-game stats: KDA (default for 'best'), win rate, games, total kills or assists, kill participation, share of the team's damage or gold, " +
    "damage, CS, gold or vision per minute. Optionally on one side of the map only ('côté bleu', 'red side'). " +
    "A minimum of games applies to rates and averages. Use it for 'best mids LEC 2025', 'meilleur jungler', 'top 5 ADC', 'quel support a le meilleur KDA'. " +
    "For in-game metrics (gold difference at 15, solo kills, first bloods, wards) use ingame_leaderboard.",
  plan: (_db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOfLeaderboard(input) });
    const order = PLAYER_CRITERION_DEFS[input.criterion].sql;
    const stats = [...new Set<PlayerCriterion>([input.criterion, ...LEADERBOARD_COLUMNS])];

    return {
      params,
      sql: tidy(`WITH p AS (
  SELECT p.game_id, p.player, p.team, p.played_at, p.win, p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision
  FROM v_game_players p WHERE ${competitionScope("p", input, params)}
),
team_kills AS (
  SELECT t.game_id, t.team, SUM(t.kills) AS team_kills, SUM(t.damage) AS team_damage, SUM(t.gold) AS team_gold FROM v_game_players t
  WHERE t.game_id IN (SELECT game_id FROM p) GROUP BY t.game_id, t.team
),
lengths AS (SELECT g.game_id, g.length_s FROM v_games g WHERE g.game_id IN (SELECT game_id FROM p)),
st AS (
  SELECT s.game_id, s.player, s.gold_diff_15 FROM v_game_player_stats s WHERE ${competitionScope("s", input, params)}
),
b AS (
  SELECT p.*, tk.team_kills, tk.team_damage, tk.team_gold, l.length_s, st.gold_diff_15
  FROM p LEFT JOIN team_kills tk ON tk.game_id = p.game_id AND tk.team = p.team
  LEFT JOIN lengths l ON l.game_id = p.game_id
  LEFT JOIN st ON st.game_id = p.game_id AND st.player = p.player
)
SELECT b.player, b.team, MAX(b.played_at) AS last_game, COUNT(*) AS games, SUM(b.win) AS wins,
       ${stats.map((c) => `${PLAYER_CRITERION_DEFS[c].sql} AS ${c}`).join(",\n       ")},
       ROUND(AVG(b.gold_diff_15), 0) AS gold_diff_15, COUNT(b.gold_diff_15) AS ingame_games
FROM b
GROUP BY b.player
HAVING COUNT(*) >= :minGames AND ${order} IS NOT NULL
ORDER BY ${input.criterion} DESC, games DESC, b.player
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.minGames == null && minGamesOfLeaderboard(input) > 3)
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: "Peu de parties par joueur dans ce périmètre : seuil abaissé à 3 parties.", reason: "seuil de parties abaissé" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(PlayerLeaderRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const def = PLAYER_CRITERION_DEFS[input.criterion];
    const minGames = minGamesOfLeaderboard(input);
    const who = `${input.role ? ROLE_PLAYERS[input.role] : "joueurs"}${sideLabel(input.side)}`;
    const columns = [...new Set<PlayerCriterion>([input.criterion, ...LEADERBOARD_COLUMNS])].filter((c) => c !== "games");
    const value = (r: z.infer<typeof PlayerLeaderRow>, c: PlayerCriterion) => r[c] ?? null;
    const ingame = rows.reduce((n, r) => n + r.ingame_games, 0);
    const all = rows.reduce((n, r) => n + r.games, 0);
    const params: Params = {};

    const pages = selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT DISTINCT p.event_page FROM v_game_players p WHERE ${competitionScope("p", input, params)} ORDER BY p.played_at DESC LIMIT 12`,
      params,
    ).map((r) => r.event_page);

    const gameParams: Params = {};
    const ongoing = inProgressNote(db, competitionScope("g", leagueAndPeriod(input), gameParams), gameParams);

    const line = (r: z.infer<typeof PlayerLeaderRow>, i: number) =>
      `${i + 1}. ${r.player}${r.team ? ` (${displayTeam(r.team)})` : ""} : ${frNumber(value(r, input.criterion))}${def.unit ?? ""}${input.criterion === "games" ? " parties" : `, ${r.games} parties`}`;

    const facts =
      `${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} avec le plus de ${def.label}` : `Meilleurs ${who}`} ${scope || "toutes compétitions"} selon le critère ${def.label} (${def.definition})` +
      `${minGames > 1 ? `, minimum ${minGames} parties` : ""} : ${rows.slice(0, 3).map(line).join(" ; ")}. ${rows.length} joueurs classés.` +
      (ingame === 0
        ? " Écart d'or à 15 min n/d : aucune partie avec données Riot dans ce périmètre."
        : ingame < all
          ? ` Écart d'or à 15 min calculé sur les ${ingame} parties avec données Riot seulement (sur ${all}).`
          : "") +
      (ongoing ? ` ${ongoing}` : "");

    return {
      title: `${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} avec le plus de ${def.label}` : input.role ? `Meilleurs ${who}` : "Classement des joueurs"} — ${def.label}${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Rang", "Joueur", "Équipe", "Parties", ...columns.map((c) => PLAYER_CRITERION_DEFS[c].label), "Écart or @15"],
        rows: rows.map((r, i) => [i + 1, r.player, r.team ? displayTeam(r.team) : null, r.games, ...columns.map((c) => value(r, c)), r.gold_diff_15]),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.player}`, url: wikiUrl(r.player) })),
        ...eventSources(pages, 12),
        ...(ingame ? [RIOT_DATA_SOURCE] : []),
      ],
      followUps: [
        ...(rows.length >= 2 ? [`${rows[0].player} vs ${rows[1].player}${scope ? ` ${scope}` : ""}`] : []),
        ...(input.role ? [`Écart d'or à 15 min des ${ROLE_PLAYERS[input.role]} ${inLeague(league) || "aux Worlds"}`] : []),
        ...rows.slice(0, 1).map((r) => `Stats in-game de ${r.player}`),
      ],
      totals: {
        leader: rows[0]?.player ?? "",
        leader_value: rows[0] ? (value(rows[0], input.criterion) ?? "n/d") : "n/d",
        leader_games: rows[0]?.games ?? 0,
        rows: rows.length,
        min_games: minGames,
        criterion: input.criterion,
        leader_gold_diff_15: rows[0]?.gold_diff_15 ?? "n/d",
        in_progress: ongoing ? "yes" : "no",
      },
    };
  },
  // As for champions: "top 5 supports" is not a minimum of 1 game; below 3, the default minimum stands.
  normalize: (_db, input) => ({ ...input, minGames: input.minGames != null && input.minGames >= 3 ? input.minGames : null }),
};

// 8. A team's in-game stats --------------------------------------------------------------

const TEAM_OVERVIEW: TeamMetric[] = ["first_blood", "first_tower", "first_dragon", "first_herald", "first_baron", "gold_diff", "kills_before_10", "plates"];

const TEAM_COLUMN_LABELS: Record<TeamMetric, string> = {
  first_blood: "First blood %",
  first_tower: "1re tour %",
  first_dragon: "1er dragon %",
  first_herald: "1er héraut %",
  first_baron: "1er baron %",
  gold_diff: "Écart or",
  kills_before_10: "Kills < 10 min",
  plates: "Plaques / partie",
};

const teamIngameStats: ToolDef<TeamIngameInput> = {
  name: "team_ingame_stats",
  label: "stats in-game d'une équipe",
  description:
    "A team's in-game profile from the Riot game data, season by season: first blood, first tower, dragon, herald and baron rates, " +
    "team gold difference at 10/15/20 min, turret plates. Renamed teams are merged. Not available for the LPL.",
  plan: (db, input) => {
    const params: Params = {};
    const t = inList("t", teamMembers(db, input.team).members, params);
    const cols = TEAM_OVERVIEW.map((m) => `${aggregateSql(TEAM_METRIC_DEFS[m].aggregate, `s.${metricColumn(TEAM_METRIC_DEFS[m], input.minute)}`)} AS ${m}`).join(",\n         ");
    const scope = ingameScope(input, params);

    return {
      params,
      sql: tidy(`WITH base AS (
  SELECT * FROM v_game_team_stats s WHERE s.team IN (${t}) AND ${scope}
)
SELECT 0 AS is_total, s.year, s.league_short, MIN(s.played_at) AS first_game, COUNT(*) AS games, SUM(s.win) AS wins,
       ${cols},
       json_group_array(DISTINCT s.event_page) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: "Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.", reason: "filtre de compétition retiré" });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const { team, members } = teamMembers(db, input.team);
    const league = leagueShortName(db, input.league);
    const minute = input.minute ?? 15;
    const val = (m: TeamMetric) => (total[m] == null ? null : Number(total[m]));
    const params: Params = {};
    const t = inList("t", members, params);
    const cov = coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE (s.blue_team IN (${t}) OR s.red_team IN (${t})) AND ${ingameScope(input, params)}`, params);

    const facts =
      `${team}${league === "toutes compétitions" ? "" : ` ${inLeague(league)}`} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), sur ${total.games} parties avec données in-game ` +
      `(${total.wins} victoires) : first blood dans ${val("first_blood") ?? "n/d"} % des parties, première tourelle ${val("first_tower") ?? "n/d"} %, ` +
      `premier dragon ${val("first_dragon") ?? "n/d"} %, premier héraut ${val("first_herald") ?? "n/d"} %, premier baron ${val("first_baron") ?? "n/d"} %, ` +
      `écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min, ${val("kills_before_10") ?? "n/d"} kills avant 10 min et ${val("plates") ?? "n/d"} plaques de tourelle prises par partie.` +
      coverageNote(cov);

    return {
      title: `${team} — stats in-game${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Année", "Compétition", "Parties", "V-D", ...TEAM_OVERVIEW.map((m) => (m === "gold_diff" ? `Écart or @${minute}` : TEAM_COLUMN_LABELS[m]))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...TEAM_OVERVIEW.map((m) => (r[m] == null ? null : Number(r[m])))]),
      },
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(rows.flatMap((r) => r.pages), 10),
        RIOT_DATA_SOURCE,
      ],
      followUps: [`Historique de ${team}`, `Équipes qui prennent le plus souvent le first blood ${input.league ? inLeague(league) : "aux Worlds"}`],
      totals: { games: total.games, wins: total.wins, ...Object.fromEntries(TEAM_OVERVIEW.map((m) => [m, val(m) ?? "n/d"])) },
    };
  },
  normalize: (db, input) => {
    const t = resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};


// 9. One game's timeline (Riot JSON in R2, read server-side) ---------------------------------

const PHASE_SQL: Record<GamePhase, string> = {
  final: "g.tab IN ('Finals', 'Final', 'Grand Finals', 'Grand Final')",
  semifinal: "g.tab IN ('Semifinals', 'Semifinal')",
  quarterfinal: "g.tab IN ('Quarterfinals', 'Quarterfinal')",
  third_place: "g.tab LIKE 'Third-Place%'",
  groups: "(g.tab LIKE 'Group%' OR g.tab LIKE 'Swiss%' OR (g.stage = 'main_event' AND (g.tab LIKE 'Day %' OR g.tab GLOB 'Round [0-9]*')))",
  play_in: "(g.stage = 'play_in' OR g.tab LIKE 'Play-In%')",
};

const PHASE_LABEL: Record<GamePhase, string> = {
  final: "finale",
  semifinal: "demi-finale",
  quarterfinal: "quart de finale",
  third_place: "match pour la 3e place",
  groups: "phase de groupes",
  play_in: "play-in",
};

const TAB_LABELS = new Map([
  ["Finals", "finale"],
  ["Final", "finale"],
  ["Grand Finals", "grande finale"],
  ["Grand Final", "grande finale"],
  ["Semifinals", "demi-finale"],
  ["Semifinal", "demi-finale"],
  ["Quarterfinals", "quart de finale"],
  ["Quarterfinal", "quart de finale"],
  ["Third-Place Match", "match pour la 3e place"],
  ["Tiebreakers", "départage"],
]);

/** French name of a Leaguepedia tab: "Finals" → "finale", "Week 3" → "semaine 3". */
export function tabLabel(tab: string | null): string {
  if (!tab) return "";

  const fixed = TAB_LABELS.get(tab);

  if (fixed) return fixed;

  return tab
    .replace(/^Week (\d+)/, "semaine $1")
    .replace(/^Day (\d+)/, "jour $1")
    .replace(/^Bracket Round (\d+)/, "tour $1 du bracket")
    .replace(/^Round (\d+)/, "tour $1")
    .replace(/^Groups? /, "groupes ")
    .replace(/^Group ([A-Z])$/, "groupe $1");
}

const TimelineGameRow = z.object({
  game_id: z.number(),
  tournament_page: Text,
  event_page: Text,
  tournament: NullableText,
  league_short: Text,
  year: z.number().nullable(),
  tab: NullableText,
  match_n: z.number().nullable(),
  game_n: z.number().nullable(),
  played_at: z.number().nullable(),
  blue_team: NullableText,
  red_team: NullableText,
  winner: NullableText,
  length_s: z.number().nullable(),
  riot_key: NullableText,
  stats_page: NullableText,
  has_timeline: z.number().nullable(),
  side_swapped: z.number().nullable(),
});

type TimelineGameRow = z.infer<typeof TimelineGameRow>;

/** What names a series: its competition, season and tab. */
type SeriesNaming = Pick<TimelineGameRow, "league_short" | "year" | "tab" | "tournament">;

/** The series a game belongs to: one tab's match of one tournament page. */
const seriesKey = (r: Pick<TimelineGameRow, "tournament_page" | "tab" | "match_n">) => `${r.tournament_page}|${r.tab}|${r.match_n}`;

/** "Worlds 2024 · finale" */
const seriesLabel = (r: SeriesNaming) => [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · ");

/** "la finale des Worlds 2024" */
function seriesPhrase(r: SeriesNaming): string {
  const tab = tabLabel(r.tab);

  return tab ? `${/^(semaine|journée|jour|tour)/.test(tab) ? "" : /^(quart|match)/.test(tab) ? "le " : "la "}${tab} ${ofEvent(r)}` : (r.tournament ?? `${r.league_short}${r.year ? ` ${r.year}` : ""}`);
}

const thousands = (n: number) => Math.abs(n).toLocaleString("fr-FR").replace(/ | /g, " ");

const signedGold = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${thousands(n)}`;

const KIND_COUNT: { kind: ParsedTimeline["events"][number]["kind"]; one: string; many: string }[] = [
  { kind: "tower", one: "tour", many: "tours" },
  // Elder dragons count as dragons, as in Leaguepedia's scoreboards.
  { kind: "dragon", one: "dragon", many: "dragons" },
  { kind: "baron", one: "baron", many: "barons" },
  { kind: "inhibitor", one: "inhibiteur", many: "inhibiteurs" },
];

/** Riot team → Leaguepedia side (blue = Team1), as the build matched them. */
const sideOf = (team: RiotTeam, swapped: boolean): Side => ((team === 100) !== swapped ? "blue" : "red");

function timelineView(r: TimelineGameRow, t: ParsedTimeline): TimelineView {
  const swapped = r.side_swapped === 1;
  const sign = swapped ? -1 : 1;

  return {
    label: `${seriesLabel(r)}${r.game_n ? ` · game ${r.game_n}` : ""}`,
    blue: displayTeam(r.blue_team ?? "Bleu"),
    red: displayTeam(r.red_team ?? "Rouge"),
    winner: t.winner ? sideOf(t.winner, swapped) : null,
    durationS: t.durationS,
    version: t.version,
    gold: t.gold.map((g) => ({ s: g.s, diff: sign * g.diff })),
    events: t.events.map((e) => ({ s: e.s, kind: e.kind, side: sideOf(e.team, swapped), detail: e.detail })),
  };
}

/** The one-sentence story of the game, from the parsed timeline only. */
function timelineFacts(r: TimelineGameRow, v: TimelineView): string {
  const name = (side: Side) => (side === "blue" ? v.blue : v.red);
  const winner = v.winner ? name(v.winner) : null;
  const at15 = v.gold.find((g) => g.s >= 15 * 60 - 30 && g.s <= 15 * 60 + 30);
  const peak = v.gold.reduce((best, g) => (Math.abs(g.diff) > Math.abs(best.diff) ? g : best), v.gold[0]);
  const fb = v.events.find((e) => e.kind === "first_blood");
  const lead = (diff: number) => (diff === 0 ? "égalité" : `${signedGold(Math.abs(diff))} pour ${name(diff > 0 ? "blue" : "red")}`);

  const counts = (["blue", "red"] as const).map(
    (side) =>
      `${name(side)} ${KIND_COUNT.map((k) => {
        const n = v.events.filter((e) => e.side === side && (e.kind === k.kind || (k.kind === "dragon" && e.kind === "elder"))).length;

        return `${n} ${n > 1 ? k.many : k.one}`;
      }).join(", ")}`,
  );

  return (
    `Game ${r.game_n ?? "?"} de ${seriesPhrase(r)}, ${v.blue} (bleu) contre ${v.red} (rouge) : ` +
    `${winner ? `victoire de ${winner}` : "vainqueur inconnu"}${v.durationS ? ` en ${clock(v.durationS)}` : ""}` +
    `${fb ? `, first blood pour ${name(fb.side)} à ${clock(fb.s)}` : ""}` +
    `${at15 ? `, écart d'or à 15 min : ${lead(at15.diff)}` : ""}` +
    `${peak && peak.diff !== 0 ? `, écart maximal ${lead(peak.diff)} à ${clock(peak.s)}` : ""}. ` +
    `Objectifs : ${counts.join(" ; ")}.`
  );
}

const gameSources = (r: TimelineGameRow): Source[] => [
  ...(r.stats_page
    ? [
        { label: `Leaguepedia — page de la partie (${r.stats_page})`, url: wikiUrl(r.stats_page) },
        { label: `Leaguepedia — timeline de la partie (${r.stats_page}/Timeline)`, url: wikiUrl(`${r.stats_page}/Timeline`) },
      ]
    : []),
  { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) },
];

const ROLE_ORDER: readonly string[] = ROLES;

const ScoreboardGameRow = z.object({
  patch: NullableText,
  winner_side: z.number().nullable(),
  blue_towers: z.number().nullable(),
  red_towers: z.number().nullable(),
  blue_inhibitors: z.number().nullable(),
  red_inhibitors: z.number().nullable(),
  blue_dragons: z.number().nullable(),
  red_dragons: z.number().nullable(),
  blue_barons: z.number().nullable(),
  red_barons: z.number().nullable(),
  blue_heralds: z.number().nullable(),
  red_heralds: z.number().nullable(),
  blue_void_grubs: z.number().nullable(),
  red_void_grubs: z.number().nullable(),
});

const ScoreboardPlayerRow = z.object({
  side: z.number().nullable(),
  role: NullableText,
  player: Text,
  champion: NullableText,
  champion_icon: NullableText,
  kills: z.number().nullable(),
  deaths: z.number().nullable(),
  assists: z.number().nullable(),
  gold: z.number().nullable(),
  cs: z.number().nullable(),
  damage: z.number().nullable(),
  vision: z.number().nullable(),
  keystone: NullableText,
});

const ScoreboardItemRow = z.object({ player: Text, item: Text, icon_url: Text });

/** Sum of a team's player values, null when no player has the field (older scoreboards). */
const teamSum = (players: ScoreboardPlayer[], key: "kills" | "gold") =>
  players.some((p) => p[key] != null) ? players.reduce((n, p) => n + (p[key] ?? 0), 0) : null;

/**
 * End-of-game recap of one game, from Leaguepedia's scoreboard tables only (no Riot JSON needed, so
 * it also covers the LPL). Data Dragon gives the keystone icons; champion and item icons are stored.
 */
async function gameScoreboard(db: DatabaseSync, r: TimelineGameRow): Promise<GameScoreboard | null> {
  const game = selectOne(
    db,
    ScoreboardGameRow,
    `SELECT patch, winner_side, blue_towers, red_towers, blue_inhibitors, red_inhibitors, blue_dragons, red_dragons,
            blue_barons, red_barons, blue_heralds, red_heralds, blue_void_grubs, red_void_grubs
     FROM games WHERE id = :game`,
    { game: r.game_id },
  );

  const rows = selectAll(
    db,
    ScoreboardPlayerRow,
    `SELECT p.side, p.role, p.player, p.champion, c.icon_url AS champion_icon,
            p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision, p.keystone
     FROM v_game_players p LEFT JOIN champions c ON c.name = p.champion
     WHERE p.game_id = :game`,
    { game: r.game_id },
  );

  if (!game || !rows.length) return null;

  const items = selectAll(db, ScoreboardItemRow, "SELECT player, item, icon_url FROM v_player_items WHERE game_id = :game ORDER BY slot", { game: r.game_id });
  // Champion and item icons carry the Data Dragon version the build used: read the keystones from the same one.
  const version = /\/cdn\/([\d.]+)\//.exec(rows.find((p) => p.champion_icon)?.champion_icon ?? items[0]?.icon_url ?? "")?.[1];
  const runes = version && rows.some((p) => p.keystone) ? await keystoneIcons(version) : new Map<string, string>();
  const rank = (role: string | null) => (role && ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);

  const players: ScoreboardPlayer[] = rows
    .flatMap((p): ScoreboardPlayer[] =>
      p.side === 1 || p.side === 2
        ? [
            {
              side: p.side === 1 ? "blue" : "red",
              role: p.role,
              player: p.player,
              champion: p.champion,
              championIcon: p.champion_icon,
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
              gold: p.gold,
              cs: p.cs,
              damage: p.damage,
              vision: p.vision,
              keystone: p.keystone,
              keystoneIcon: p.keystone ? (runes.get(p.keystone) ?? null) : null,
              items: items.flatMap((i) => (i.player === p.player ? [{ name: i.item, iconUrl: i.icon_url }] : [])),
            },
          ]
        : [],
    )
    .sort((a, b) => rank(a.role) - rank(b.role));

  const team = (side: Side): ScoreboardTeam => {
    const own = players.filter((p) => p.side === side);
    const pick = (blue: number | null, red: number | null) => (side === "blue" ? blue : red);

    return {
      name: displayTeam((side === "blue" ? r.blue_team : r.red_team) ?? (side === "blue" ? "Bleu" : "Rouge")),
      kills: teamSum(own, "kills"),
      gold: teamSum(own, "gold"),
      towers: pick(game.blue_towers, game.red_towers),
      inhibitors: pick(game.blue_inhibitors, game.red_inhibitors),
      dragons: pick(game.blue_dragons, game.red_dragons),
      barons: pick(game.blue_barons, game.red_barons),
      heralds: pick(game.blue_heralds, game.red_heralds),
      grubs: pick(game.blue_void_grubs, game.red_void_grubs),
    };
  };

  return {
    label: `${seriesLabel(r)}${r.game_n ? ` · game ${r.game_n}` : ""}`,
    durationS: r.length_s,
    patch: game.patch,
    winner: game.winner_side === 1 ? "blue" : game.winner_side === 2 ? "red" : null,
    blue: team("blue"),
    red: team("red"),
    players,
  };
}

const ProfileRow = z.object({ team: NullableText, role: NullableText, games: z.number() });

/**
 * Teams (by games) and main role of each player, in one competition and period: the scope the answer was computed on.
 * Shown by the comparison layouts next to the table, which rarely selects them.
 */
export function playerProfiles(db: DatabaseSync, players: string[], scope: { league: string | null } & Period): PlayerProfile[] {
  return players.map((player) => {
    const params: Params = {};

    Object.assign(params, { player });

    const league = scope.league ? `AND ${leagueFilter("league", { league: scope.league, yearFrom: scope.yearFrom, yearTo: scope.yearTo }, params)}` : "";

    const rows = selectAll(
      db,
      ProfileRow,
      `SELECT team, role, COUNT(*) AS games FROM v_game_players
       WHERE player = :player AND stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("year", { yearFrom: scope.yearFrom, yearTo: scope.yearTo }, params)}
       GROUP BY team, role ORDER BY games DESC`,
      params,
    );

    const total = (key: "team" | "role") => {
      const games = new Map<string, number>();

      for (const r of rows) if (r[key]) games.set(r[key], (games.get(r[key]) ?? 0) + r.games);

      return [...games].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    };

    return { player, teams: total("team").map(displayTeam), role: total("role")[0] ?? null };
  });
}

const SOURCE_LABEL = { cache: "Runtime Cache", r2: "R2", local: "cache local (data/raw/riot)" } as const;

const gameTimeline: ToolDef<GameTimelineInput> = {
  name: "game_timeline",
  label: "timeline d'une partie",
  description:
    "The minute-by-minute story of one game: gold difference at every minute and the key events (first blood, towers, dragons, heralds, " +
    "barons, inhibitors, aces) with their time and team. The game is found by its teams, competition, season, stage of the series " +
    "(final, semifinal...) and game number. Not available for the LPL (no Riot data).",
  plan: (db, input) => {
    const params: Params = {};
    const where = [`g.stage IN (${COMPETITION_STAGES})`];
    const a = input.teamA ? inList("a", teamMembers(db, input.teamA).members, params) : null;
    const b = input.teamB ? inList("b", teamMembers(db, input.teamB).members, params) : null;

    if (a && b) where.push(`((g.blue_team IN (${a}) AND g.red_team IN (${b})) OR (g.blue_team IN (${b}) AND g.red_team IN (${a})))`);
    else if (a) where.push(`(g.blue_team IN (${a}) OR g.red_team IN (${a}))`);

    if (input.league) {
      where.push(leagueFilter("g.league", input, params));

    }

    if (input.year != null) {
      where.push("g.year = :year");
      params.year = input.year;
    }

    if (input.phase) where.push(PHASE_SQL[input.phase]);

    // Every game of the matching series, so the answer can say a series had no game 5.
    return {
      params,
      sql: `SELECT g.game_id, g.tournament_page, g.event_page, g.tournament, g.league_short, g.year, g.tab, g.match_n, g.game_n,
       g.played_at, g.blue_team, g.red_team, g.winner, g.length_s,
       r.riot_key, r.stats_page, r.has_timeline, r.side_swapped
FROM v_games g LEFT JOIN game_riot r ON r.game_id = g.game_id
WHERE ${where.join("\n  AND ")}
ORDER BY g.played_at DESC, g.game_n`,
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];
    const teams = [input.teamA, input.teamB].filter(Boolean).join(" – ");

    // Without a team, dropping a filter would show an unrelated game.
    if (!input.teamA) return out;

    if (input.phase)
      out.push({
        key: "phase",
        input: { ...input, phase: null },
        note: `Aucune ${PHASE_LABEL[input.phase]} ${teams} dans ce périmètre : recherche sur toute la compétition.`,
        reason: `phase « ${PHASE_LABEL[input.phase]} » retirée`,
      });

    if (input.year != null)
      out.push({ key: "year", input: { ...input, phase: null, year: null }, note: `Aucune partie ${teams} en ${input.year} : recherche sur toutes les saisons.`, reason: "saison retirée" });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(TimelineGameRow).parse(sqlRows);
    const series = new Map<string, TimelineGameRow[]>();

    for (const r of rows) series.set(seriesKey(r), [...(series.get(seriesKey(r)) ?? []), r]);
    // Rows come newest first: the first series is the most recent match.
    const [shownKey, games] = [...series][0];
    games.sort((x, y) => (x.game_n ?? 0) - (y.game_n ?? 0));
    const first = games[0];
    const notes: string[] = [];
    const others = [...series.values()].slice(1, 4).map((g) => g[0]);

    if (series.size > 1)
      notes.push(
        `${series.size} séries correspondent ; affichage de la plus récente (${seriesLabel(first)}, ${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}). ` +
          "Précise la compétition, la saison ou la phase pour une autre.",
      );

    const gameNumbers = games.flatMap((g) => (g.game_n == null ? [] : [g.game_n]));
    const pick = input.game == null ? first : games.find((g) => g.game_n === input.game);
    const vs = `${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}`;

    const followUpsFor = (except: number | null) =>
      [
        ...gameNumbers.filter((n) => n !== except).slice(0, 3).map((n) => `Timeline de la game ${n} de ${vs}, ${seriesLabel(first).replace(" · ", " ")}`),
        ...others.map((o) => `Timeline de ${displayTeam(o.blue_team ?? "?")} – ${displayTeam(o.red_team ?? "?")}, ${seriesLabel(o).replace(" · ", " ")}`),
      ].slice(0, 4);

    const base = { game_id: pick?.game_id ?? 0, series_games: games.length, series: shownKey };

    if (!pick)
      return {
        title: `${vs} — ${seriesLabel(first)}`,
        facts:
          `${seriesPhrase(first).replace(/^./, (c) => c.toUpperCase())} (${vs}) s'est jouée en ${games.length} partie${games.length > 1 ? "s" : ""} ` +
          `(victoire${games.length > 1 ? "s" : ""} : ${games.map((g) => displayTeam(g.winner ?? "?")).join(", ")}) : il n'y a pas de game ${input.game}.`,
        sources: [{ label: `Leaguepedia — ${first.tournament_page}`, url: wikiUrl(first.tournament_page) }],
        followUps: followUpsFor(null),
        totals: { ...base, timeline: "no_such_game" },
        notes,
      };

    if (input.game == null && games.length > 1) notes.push(`Numéro de game non précisé : game ${pick.game_n} affichée (la série en compte ${games.length}).`);

    const title = `${displayTeam(pick.blue_team ?? "?")} – ${displayTeam(pick.red_team ?? "?")} — ${seriesLabel(pick)}${pick.game_n ? ` · game ${pick.game_n}` : ""}`;
    const result = `${displayTeam(pick.winner ?? "?")} gagne${pick.length_s ? ` en ${clock(pick.length_s)}` : ""}`;
    // The recap comes from the scoreboard tables: shown whether or not the Riot timeline exists.
    const scoreboard = (await gameScoreboard(db, pick)) ?? undefined;

    if (!pick.riot_key || pick.has_timeline !== 1)
      return {
        title,
        facts:
          `Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Pas de timeline pour cette partie : ` +
          (pick.riot_key ? "les données Riot publiées par Leaguepedia n'en contiennent pas." : "Leaguepedia ne publie pas ses données Riot (aucune pour la LPL)."),
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        scoreboard,
        totals: { ...base, timeline: "absent" },
        notes,
      };

    const load = await loadTimeline(pick.riot_key);

    if (load.status !== "ok") {
      const why = {
        missing: "le fichier Riot de la partie est introuvable dans le stockage",
        unconfigured: "le stockage des timelines n'est pas configuré sur ce serveur",
        error: "la lecture du stockage a échoué",
      }[load.status];

      return {
        title,
        facts: `Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Timeline indisponible pour le moment (${why}).`,
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        scoreboard,
        totals: { ...base, timeline: load.status },
        trace: [{ status: "error", title: `Timeline ${pick.riot_key} : ${why}`, detail: load.status === "error" ? load.message : undefined }],
        notes,
      };
    }

    const view = timelineView(pick, load.timeline);
    const at = (min: number) => view.gold.find((g) => Math.abs(g.s - min * 60) <= 30)?.diff ?? "n/d";
    const fb = view.events.find((e) => e.kind === "first_blood");

    return {
      title,
      timeline: view,
      scoreboard,
      facts: timelineFacts(pick, view),
      sources: [...gameSources(pick), RIOT_DATA_SOURCE],
      followUps: followUpsFor(pick.game_n),
      totals: {
        ...base,
        timeline: "ok",
        blue: view.blue,
        red: view.red,
        winner: view.winner ? (view.winner === "blue" ? view.blue : view.red) : "n/d",
        version: view.version,
        duration_s: view.durationS ?? "n/d",
        gold_diff_10: at(10),
        gold_diff_15: at(15),
        first_blood: fb ? (fb.side === "blue" ? view.blue : view.red) : "n/d",
        events: view.events.length,
      },
      trace: [
        {
          status: "ok",
          title: `Timeline ${pick.riot_key} (match-v${view.version}) lue depuis ${SOURCE_LABEL[load.source]} en ${load.ms} ms`,
          detail: `${view.gold.length} points d'or, ${view.events.length} événements clés. Lecture serveur, en lecture seule : aucune clé n'est envoyée au navigateur.`,
        },
      ],
      notes,
    };
  },
  normalize: (db, input) => {
    const a = input.teamA ? resolveTeam(db, input.teamA) : null;
    const b = input.teamB ? resolveTeam(db, input.teamB) : null;

    if ((input.teamA && !a) || (input.teamB && !b)) return null;

    // A single team in teamB only is the same question.
    return { ...input, teamA: a?.team ?? b?.team ?? null, teamB: a ? (b?.team ?? null) : null };
  },
};

// 10. Series (best-of) as one unit: score, then every game ---------------------------------

const PhaseTabRow = z.object({
  tournament_page: Text,
  tab: Text,
  start: z.number().nullable(),
  end: z.number().nullable(),
  named: z.number(),
  final: z.number(),
  play_in: z.number(),
});

/** A tab that holds the phase asked; `before` names the final it precedes when the bracket names no such phase. */
type PhaseTab = { page: string; tab: string; before: string | null };

/**
 * The tabs (one per tournament page) that hold a phase in the scope. Play-in tabs only count for the play-in, so a
 * play-in final is not the event's final. A double-elimination bracket (MSI since 2023, LCK playoffs) has no tab
 * named "Semifinals": its semifinal is the last round before the final, the round that decides both finalists.
 * Qualifier stages are out of scope (COMPETITION_STAGES): "LPL Regional Finals" is not the Worlds final.
 */
function phaseTabs(db: DatabaseSync, input: SeriesInput & { phase: GamePhase }): PhaseTab[] {
  const params: Params = {};
  const league = input.league ? `AND ${leagueFilter("g.league", input, params)}` : "";

  const rows = selectAll(
    db,
    PhaseTabRow,
    `SELECT g.tournament_page, g.tab, MIN(g.played_at) AS start, MAX(g.played_at) AS end,
            MAX(${PHASE_SQL[input.phase]}) AS named, MAX(${PHASE_SQL.final}) AS final, MAX(${PHASE_SQL.play_in}) AS play_in
     FROM v_games g
     WHERE g.stage IN (${COMPETITION_STAGES}) AND g.tab IS NOT NULL ${league} ${periodFilter("g.year", input, params)} ${splitFilter("g.tournament_page", input, params)}
     GROUP BY g.tournament_page, g.tab`,
    params,
  );

  const pages = new Map<string, z.infer<typeof PhaseTabRow>[]>();

  for (const r of rows) pages.set(r.tournament_page, [...(pages.get(r.tournament_page) ?? []), r]);

  return [...pages].flatMap(([page, tabs]): PhaseTab[] => {
    const named = tabs.filter((t) => t.named === 1 && (input.phase === "play_in" || t.play_in === 0));

    if (named.length) return named.map((t) => ({ page, tab: t.tab, before: null }));

    const final = tabs.find((t) => t.final === 1 && t.play_in === 0);

    if (input.phase !== "semifinal" || !final || final.start == null) return [];

    const last = tabs
      .filter((t) => t.final === 0 && t.play_in === 0 && t.end != null && t.end <= final.start!)
      .reduce<z.infer<typeof PhaseTabRow> | null>((best, t) => (!best || t.end! > best.end! ? t : best), null);

    return last ? [{ page, tab: last.tab, before: final.tab }] : [];
  });
}

const SeriesGameRow = z.object({
  game_id: z.number(),
  tournament_page: Text,
  event_page: Text,
  tournament: NullableText,
  league_short: Text,
  year: z.number().nullable(),
  tab: NullableText,
  match_n: z.number().nullable(),
  game_n: z.number().nullable(),
  played_at: z.number().nullable(),
  patch: NullableText,
  length_s: z.number().nullable(),
  blue_team: NullableText,
  red_team: NullableText,
  winner: NullableText,
  stats_page: NullableText,
});

type SeriesGameRow = z.infer<typeof SeriesGameRow>;

const SeriesPickRow = z.object({ game_id: z.number(), side: z.number().nullable(), role: NullableText, player: Text, champion: NullableText, icon: NullableText });

const SeriesBanRow = z.object({ game_id: z.number(), side: z.number(), champion: Text, icon: NullableText });

/** Series detailed with their games; the others of a long phase (Swiss rounds...) are listed with their score only. */
const MAX_DETAILED_SERIES = 16;

const DAY_SHORT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const gameSource = (r: SeriesGameRow): Source =>
  r.stats_page
    ? { label: `Leaguepedia — ${seriesLabel(r)} · game ${r.game_n ?? "?"} (${r.stats_page})`, url: wikiUrl(r.stats_page) }
    : { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) };

/** 1, 3 or 5 from the score: the winner's wins are the wins needed. Null without a winner. */
const bestOfScore = (a: number, b: number) => (a === b ? null : 2 * Math.max(a, b) - 1);

/** Picks (Top → Support) and bans of the detailed games, from Leaguepedia's scoreboards. */
function seriesDrafts(db: DatabaseSync, ids: number[]) {
  const params: Params = {};
  const list = ids.map((id, i) => ((params[`g${i}`] = id), `:g${i}`)).join(", ");

  const picks = ids.length
    ? selectAll(
        db,
        SeriesPickRow,
        `SELECT p.game_id, p.side, p.role, p.player, p.champion, c.icon_url AS icon
         FROM v_game_players p LEFT JOIN champions c ON c.name = p.champion WHERE p.game_id IN (${list})`,
        params,
      )
    : [];

  const bans = ids.length
    ? selectAll(
        db,
        SeriesBanRow,
        `SELECT d.game_id, d.side, d.champion, c.icon_url AS icon
         FROM v_draft d LEFT JOIN champions c ON c.name = d.champion WHERE d.kind = 'ban' AND d.game_id IN (${list})
         ORDER BY d.game_id, d.side, d.slot`,
        params,
      )
    : [];

  const rank = (role: string | null) => (role && ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);

  return (id: number): Pick<SeriesGame, "picks" | "bans"> => {
    const sideOfRow = (side: number | null): Side | null => (side === 1 ? "blue" : side === 2 ? "red" : null);
    const own = picks.filter((p) => p.game_id === id).sort((a, b) => rank(a.role) - rank(b.role));
    const banned = bans.filter((b) => b.game_id === id);

    const pickOf = (side: Side): SeriesPick[] =>
      own.filter((p) => sideOfRow(p.side) === side).map((p) => ({ role: p.role, player: displayTeam(p.player), champion: p.champion, icon: p.icon }));

    const banOf = (side: Side) => banned.filter((b) => sideOfRow(b.side) === side).map((b) => ({ champion: b.champion, icon: b.icon }));

    return { picks: { blue: pickOf("blue"), red: pickOf("red") }, bans: { blue: banOf("blue"), red: banOf("red") } };
  };
}

const PHASE_PLURAL: Record<GamePhase, string> = {
  final: "finales",
  semifinal: "demi-finales",
  quarterfinal: "quarts de finale",
  third_place: "matchs pour la 3e place",
  groups: "phase de groupes",
  play_in: "play-in",
};

/** "des Worlds 2025", "du MSI 2024", "de la LCK 2024" */
function ofEvent(r: Pick<SeriesNaming, "league_short" | "year">): string {
  const event = `${r.league_short}${r.year ? ` ${r.year}` : ""}`;

  return r.league_short === "Worlds" || r.league_short.endsWith("Masters") ? `des ${event}` : r.league_short === "MSI" ? `du ${event}` : `de la ${event}`;
}

const capitalize = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

const series: ToolDef<SeriesInput> = {
  name: "series",
  label: "série (BO)",
  description:
    "Series (best-of) shown as one unit: the score (3-2), then every game with its winner, sides, duration, picks and bans. " +
    "For a final, a semifinal, a quarterfinal or another stage of a competition ('finale des Worlds 2025', 'demi-finales MSI 2024'), " +
    "or a named match between two teams ('T1 vs Gen.G finale LCK 2024'). Regional qualifiers such as 'LPL Regional Finals' are not " +
    "the international event's final. For a team's whole record against another, use head_to_head; for one game's minute-by-minute story, game_timeline.",
  plan: (db, input) => {
    const params: Params = {};
    const where = [`g.stage IN (${COMPETITION_STAGES})`];
    const a = input.teamA ? inList("a", teamMembers(db, input.teamA).members, params) : null;
    const b = input.teamB ? inList("b", teamMembers(db, input.teamB).members, params) : null;

    if (a && b) where.push(`((g.blue_team IN (${a}) AND g.red_team IN (${b})) OR (g.blue_team IN (${b}) AND g.red_team IN (${a})))`);
    else if (a) where.push(`(g.blue_team IN (${a}) OR g.red_team IN (${a}))`);

    if (input.league) where.push(leagueFilter("g.league", input, params));

    if (input.phase) {
      const tabs = phaseTabs(db, { ...input, phase: input.phase });

      where.push(tabs.length ? `(g.tournament_page || '|' || g.tab) IN (${inList("t", tabs.map((t) => `${t.page}|${t.tab}`), params)})` : "0");
    }

    return {
      params,
      sql: `SELECT g.game_id, g.tournament_page, g.event_page, g.tournament, g.league_short, g.year, g.tab, g.match_n, g.game_n,
       g.played_at, g.patch, g.length_s, g.blue_team, g.red_team, g.winner, r.stats_page
FROM v_games g LEFT JOIN game_riot r ON r.game_id = g.game_id
WHERE ${where.join("\n  AND ")}
  ${periodFilter("g.year", input, params)}
  ${splitFilter("g.tournament_page", input, params)}
ORDER BY g.played_at, g.tournament_page, g.tab, g.match_n, g.game_n`,
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];
    const phase = input.phase ? PHASE_LABEL[input.phase] : null;

    // Two teams that did not meet in that phase: their series in the season asked (a year keeps the list short).
    if (phase && input.teamA && input.teamB && hasPeriod(input))
      out.push({
        key: "phase",
        input: { ...input, phase: null },
        note: `Aucune ${phase} ${input.teamA} – ${input.teamB} dans ce périmètre : toutes leurs séries de la période.`,
        reason: `phase « ${phase} » retirée`,
      });

    // One team that did not reach that phase: the phase itself, without the team.
    if (phase && input.teamA && !input.teamB && (input.league || hasPeriod(input)))
      out.push({
        key: "team",
        input: { ...input, teamA: null },
        note: `${input.teamA} n'a pas joué de ${phase} dans ce périmètre : affichage de la ${phase} sans filtre d'équipe.`,
        reason: `équipe ${input.teamA} retirée`,
      });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(SeriesGameRow).parse(sqlRows);
    const groups = new Map<string, SeriesGameRow[]>();

    for (const r of rows) groups.set(seriesKey(r), [...(groups.get(seriesKey(r)) ?? []), r]);
    const seriesGames = [...groups.values()];
    const detailedIds = seriesGames.slice(0, MAX_DETAILED_SERIES).flatMap((g) => g.map((r) => r.game_id));
    const draftOf = seriesDrafts(db, detailedIds);

    const list: SeriesDetail[] = seriesGames.map((games, i) => {
      games.sort((x, y) => (x.game_n ?? 0) - (y.game_n ?? 0));
      const first = games[0];
      const names = [...new Set(games.flatMap((g) => [g.blue_team, g.red_team]).filter((t): t is string => t != null))];
      const winsOf = (team: string | undefined) => games.filter((g) => team != null && g.winner === team).length;
      // The series winner first; a series without one keeps the first game's blue side first.
      const [x, y] = winsOf(names[1]) > winsOf(names[0]) ? [names[1], names[0]] : [names[0], names[1]];

      return {
        label: seriesLabel(first),
        tournamentPage: first.tournament_page,
        playedAt: first.played_at,
        teamA: displayTeam(x ?? "?"),
        teamB: displayTeam(y ?? "?"),
        winsA: winsOf(x),
        winsB: winsOf(y),
        bestOf: bestOfScore(winsOf(x), winsOf(y)),
        games:
          i < MAX_DETAILED_SERIES
            ? games.map((g) => ({
                n: g.game_n,
                playedAt: g.played_at,
                blue: displayTeam(g.blue_team ?? "Bleu"),
                red: displayTeam(g.red_team ?? "Rouge"),
                winner: g.winner == null ? null : g.winner === g.blue_team ? "blue" : g.winner === g.red_team ? "red" : null,
                durationS: g.length_s,
                patch: g.patch,
                ...draftOf(g.game_id),
                source: gameSource(g),
              }))
            : null,
        source: { label: `Leaguepedia — ${first.tournament_page}`, url: wikiUrl(first.tournament_page) },
      };
    });

    const firstRow = rows[0];
    const one = list.length === 1 ? list[0] : null;
    const teams = [input.teamA, input.teamB].flatMap((t) => (t == null ? [] : [displayTeam(t)]));
    const labels = [...new Set(list.map((s) => s.label))];
    // One competition and season: "MSI 2024"; several: the competition asked, with the period.
    const oneEvent = new Set(rows.map((r) => `${r.league_short}|${r.year}`)).size === 1;
    const short = leagueShortName(db, input.league);
    const span = hasPeriod(input) ? yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year]))) : "";

    const event = oneEvent
      ? `${firstRow.league_short}${firstRow.year ? ` ${firstRow.year}` : ""}`
      : input.league
        ? [short, span].filter(Boolean).join(" ")
        : span || short;

    const phaseName = input.phase ? PHASE_PLURAL[input.phase] : null;
    const scope = [labels.length === 1 ? labels[0] : phaseName ? `${event} · ${phaseName}` : event, teams.join(" – ")].filter(Boolean).join(" · ");

    const notes: string[] = [];

    if (input.phase === "semifinal") {
      const fallback = phaseTabs(db, { ...input, phase: "semifinal" }).filter((t) => t.before && list.some((s) => s.tournamentPage === t.page));

      for (const t of fallback)
        notes.push(`${t.page} : pas de demi-finales nommées sur Leaguepedia (tableau à double élimination) ; séries du dernier tour avant la finale (${t.tab}), qui désigne les deux finalistes.`);
    }

    if (list.length > MAX_DETAILED_SERIES) notes.push(`${list.length} séries : le détail game par game est donné pour les ${MAX_DETAILED_SERIES} premières.`);

    if (rows.length >= MAX_ROWS) notes.push(`Liste limitée aux ${MAX_ROWS} premières parties : précise la saison ou la phase pour la suite.`);

    const score = (s: SeriesDetail) => `${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`;
    const sideName = (g: SeriesGame) => (g.winner === "blue" ? `${g.blue} (bleu)` : g.winner === "red" ? `${g.red} (rouge)` : "vainqueur inconnu");

    const ofScope = oneEvent
      ? ofEvent(firstRow)
      : input.league
        ? [ofEvent({ league_short: short, year: null }), span].filter(Boolean).join(" ")
        : [teams.length ? `de ${teams.join(" et ")}` : "", span ? `en ${span}` : "toutes compétitions"].filter(Boolean).join(" ");

    const phrase = capitalize(one || !phaseName ? seriesPhrase(firstRow) : `${phaseName} ${ofScope}`.trim());

    const facts = one
      ? `${phrase} : ${one.winsA === one.winsB ? `${one.teamA} et ${one.teamB} à égalité ${one.winsA}-${one.winsB}` : `${one.teamA} bat ${one.teamB} ${one.winsA}-${one.winsB}`}` +
        `${one.bestOf ? ` (BO${one.bestOf})` : ""}${one.playedAt ? `, le ${DAY_FR.format(new Date(one.playedAt * 1000))}` : ""}. ` +
        (one.games ?? []).map((g) => `Game ${g.n ?? "?"} : ${sideName(g)}${g.durationS ? ` en ${clock(g.durationS)}` : ""}`).join(" ; ") +
        "."
      : `${phrase} : ${list.length} séries. ${list.slice(0, 8).map(score).join(" ; ")}${list.length > 8 ? " ; …" : ""}.`;

    // Asked again by its stage, the follow-up routes back to this tool.
    const askAgain = (s: SeriesDetail) =>
      `${s.teamA} vs ${s.teamB} ${input.phase ? `${PHASE_LABEL[input.phase]} ${s.label.split(" · ")[0]}` : s.label.replace(" · ", " ")}`;

    const followUps = one
      ? [
          ...(one.games ?? []).filter((g) => g.n != null).slice(-2).reverse().map((g) => `Récap de la game ${g.n} de ${one.teamA} vs ${one.teamB}, ${seriesPhrase(firstRow)}`),
          `${one.teamA} contre ${one.teamB}`,
        ]
      : list.slice(0, 3).map(askAgain);

    const totals: ToolOutput["totals"] = { series: list.length, games: rows.length };
    const top = list[0];

    if (top)
      Object.assign(totals, {
        team_a: top.teamA,
        team_b: top.teamB,
        wins_a: top.winsA,
        wins_b: top.winsB,
        score: `${top.winsA}-${top.winsB}`,
        best_of: top.bestOf ?? "n/d",
        label: top.label,
        date: top.playedAt ? DAY_SHORT.format(new Date(top.playedAt * 1000)) : "n/d",
      });

    const pages = [...new Set(list.map((s) => s.tournamentPage))];
    const gamePages = list.flatMap((s) => (s.games ?? []).flatMap((g) => (g.source.url === s.source.url ? [] : [g.source])));

    return {
      title: one ? `${score(one)} — ${one.label}` : phaseName ? `${capitalize(phaseName)} — ${[event, teams.join(" – ")].filter(Boolean).join(" · ")}` : `Séries — ${scope}`,
      series: { scope, count: list.length, series: list },
      table: {
        columns: ["Série", "Game", "Bleu", "Rouge", "Vainqueur", "Durée", "Patch"],
        rows: list.flatMap((s, i) =>
          seriesGames[i].map((g) => [
            `${score(s)} · ${s.label}`,
            g.game_n,
            displayTeam(g.blue_team ?? "?"),
            displayTeam(g.red_team ?? "?"),
            g.winner ? displayTeam(g.winner) : null,
            g.length_s ? clock(g.length_s) : null,
            g.patch,
          ]),
        ),
      },
      facts,
      sources: [...pages.map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })), ...gamePages].slice(0, 30),
      followUps: followUps.slice(0, 3),
      notes,
      totals,
    };
  },
  normalize: (db, input) => {
    const a = input.teamA ? resolveTeam(db, input.teamA) : null;
    const b = input.teamB ? resolveTeam(db, input.teamB) : null;

    if ((input.teamA && !a) || (input.teamB && !b)) return null;

    return { ...input, teamA: a?.team ?? b?.team ?? null, teamB: a ? (b?.team ?? null) : null };
  },
};

// 11. Teams ranked on an end-of-game criterion -----------------------------------------------

type TeamCriterionDef = CriterionDef & {
  /** From the Riot game data: no figure where Leaguepedia hosts no game JSON. */
  ingame?: true;
};

const teamAverage = (column: string, digits: number) => `ROUND(AVG(b.${column}), ${digits})`;

const sideWinrate = (side: MapSide) =>
  `ROUND(100.0 * SUM(CASE WHEN b.side = ${SIDE_ID[side]} THEN b.win END) / COUNT(CASE WHEN b.side = ${SIDE_ID[side]} THEN b.win END), 1)`;

export const TEAM_CRITERION_DEFS: Record<TeamCriterion, TeamCriterionDef> = {
  winrate: { label: "% victoires", definition: "victoires / parties", sql: "ROUND(100.0 * SUM(b.win) / COUNT(b.win), 1)", unit: " %" },
  games: { label: "parties", definition: "nombre de parties jouées", sql: "COUNT(*)", total: true },
  blue_winrate: { label: "% côté bleu", definition: "victoires / parties jouées côté bleu", sql: sideWinrate("blue"), unit: " %" },
  red_winrate: { label: "% côté rouge", definition: "victoires / parties jouées côté rouge", sql: sideWinrate("red"), unit: " %" },
  kda: { label: "KDA", definition: "(kills + assists) / morts de l'équipe", sql: `ROUND(1.0 * ${kaSum("b")} / MAX(1, ${deathsSum("b")}), 2)` },
  kills: { label: "kills / partie", definition: "kills de l'équipe par partie", sql: teamAverage("kills", 1) },
  deaths: { label: "morts / partie", definition: "morts de l'équipe par partie", sql: teamAverage("deaths", 1) },
  game_length: { label: "durée (min)", definition: "durée moyenne des parties, en minutes", sql: "ROUND(AVG(b.length_s) / 60.0, 1)", unit: " min" },
  champions: { label: "champions", definition: "champions différents joués", sql: "MAX(pool.champions)", total: true },
  dragons: { label: "dragons / partie", definition: "dragons pris par partie", sql: teamAverage("dragons", 2) },
  barons: { label: "barons / partie", definition: "barons pris par partie", sql: teamAverage("barons", 2) },
  towers: { label: "tours / partie", definition: "tourelles détruites par partie", sql: teamAverage("towers", 1) },
  heralds: { label: "hérauts / partie", definition: "hérauts pris par partie", sql: teamAverage("heralds", 2) },
  void_grubs: { label: "grubs / partie", definition: "larves du Néant prises par partie", sql: teamAverage("void_grubs", 2) },
  first_dragon: { label: "1er dragon %", definition: "part des parties avec le premier dragon", sql: "ROUND(100.0 * AVG(b.first_dragon), 1)", unit: " %", ingame: true },
  first_herald: { label: "1er héraut %", definition: "part des parties avec le premier héraut", sql: "ROUND(100.0 * AVG(b.first_herald), 1)", unit: " %", ingame: true },
  first_baron: { label: "1er baron %", definition: "part des parties avec le premier baron", sql: "ROUND(100.0 * AVG(b.first_baron), 1)", unit: " %", ingame: true },
  gold_diff_15: { label: "écart or @15", definition: "écart d'or moyen de l'équipe à 15 min", sql: teamAverage("gold_diff_15", 0), ingame: true },
};

/** Every criterion is a column of the table, the ranking one first; a side's win rate has no meaning once one side is filtered. */
const TEAM_LEADERBOARD_COLUMNS: TeamCriterion[] = [
  "winrate", "blue_winrate", "red_winrate", "kda", "kills", "deaths", "game_length", "champions",
  "dragons", "barons", "towers", "void_grubs", "first_dragon", "first_baron", "gold_diff_15",
];

const teamColumnsOf = (input: TeamLeaderboardInput) =>
  [...new Set<TeamCriterion>([input.criterion, ...TEAM_LEADERBOARD_COLUMNS])].filter((c) => c !== "games" && !(input.side && (c === "blue_winrate" || c === "red_winrate")));

const TeamLeaderRow = z.object({ name: Text, games: z.number(), wins: z.number().nullable(), ingame_games: z.number() }).catchall(z.number().nullable());

/** Rates and averages need enough games: 5 in one international event, 10 in one league season, else 20. */
export function minGamesOfTeams(input: TeamLeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (TEAM_CRITERION_DEFS[input.criterion].total) return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  if (input.league && oneSeason) return isInternational(input.league) ? 5 : 10;

  return 20;
}

const teamLeaderboard: ToolDef<TeamLeaderboardInput> = {
  name: "team_leaderboard",
  label: "classement d'équipes",
  description:
    "Ranks the teams of a competition and period on one criterion from the end-of-game stats: win rate (default), games, win rate on blue or red side, " +
    "team KDA, kills or deaths per game, average game duration, distinct champions picked, dragons, barons, towers, heralds or void grubs per game, " +
    "and, from the Riot game data, first dragon / herald / baron share and gold difference at 15 min. Highest first, or lowest first " +
    "('équipe avec les parties les plus courtes'). Optionally on one side of the map only. Renamed teams are merged. " +
    "For a tournament's final placements use tournament_standings; for first blood, first tower or plates use ingame_leaderboard.",
  plan: (db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOfTeams(input) });
    const scope = competitionScope("g", leagueAndPeriod(input), params);
    const side = input.side ? `AND x.side = ${SIDE_ID[input.side]}` : "";

    const sideOf = (n: 1 | 2, color: "blue" | "red") =>
      `SELECT g.game_id, ${n} AS side, g.${color}_team AS team, (g.winner = g.${color}_team) AS win, g.length_s, g.played_at,
         g.${color}_dragons AS dragons, g.${color}_barons AS barons, g.${color}_towers AS towers, g.${color}_heralds AS heralds, g.${color}_void_grubs AS void_grubs
  FROM g`;

    return {
      params,
      sql: tidy(`WITH g AS (
  SELECT g.game_id, g.length_s, g.played_at, g.blue_team, g.red_team, g.winner,
         g.blue_dragons, g.red_dragons, g.blue_barons, g.red_barons, g.blue_towers, g.red_towers,
         g.blue_heralds, g.red_heralds, g.blue_void_grubs, g.red_void_grubs
  FROM v_games g WHERE ${scope}
),
sides AS (
  ${sideOf(1, "blue")}
  UNION ALL
  ${sideOf(2, "red")}
),
picks AS (
  SELECT p.game_id, p.team, p.champion, p.kills, p.deaths, p.assists FROM v_game_players p WHERE ${competitionScope("p", leagueAndPeriod(input), params)}
),
kda AS (SELECT k.game_id, k.team, SUM(k.kills) AS kills, SUM(k.deaths) AS deaths, SUM(k.assists) AS assists FROM picks k GROUP BY k.game_id, k.team),
ig AS (
  SELECT s.game_id, s.side, s.first_dragon, s.first_herald, s.first_baron, s.gold_diff_15 FROM v_game_team_stats s WHERE ${ingameScope(input, params)}
),
b AS (
  SELECT ${franchiseName(db, "x.team", params)} AS name, x.*, k.kills, k.deaths, k.assists,
         i.first_dragon, i.first_herald, i.first_baron, i.gold_diff_15
  FROM sides x LEFT JOIN kda k ON k.game_id = x.game_id AND k.team = x.team
  LEFT JOIN ig i ON i.game_id = x.game_id AND i.side = x.side
  WHERE x.team IS NOT NULL ${side}
),
pool AS (
  SELECT ${franchiseName(db, "x.team", params)} AS name, COUNT(DISTINCT k.champion) AS champions
  FROM sides x JOIN picks k ON k.game_id = x.game_id AND k.team = x.team
  WHERE x.team IS NOT NULL ${side}
  GROUP BY 1
)
SELECT b.name, COUNT(*) AS games, SUM(b.win) AS wins, COUNT(b.gold_diff_15) AS ingame_games,
       ${TEAM_CRITERIA.flatMap((c) => (c === "games" ? [] : [`${TEAM_CRITERION_DEFS[c].sql} AS ${c}`])).join(",\n       ")}
FROM b LEFT JOIN pool ON pool.name = b.name
GROUP BY b.name
HAVING COUNT(*) >= :minGames AND ${input.criterion === "games" ? "COUNT(*)" : input.criterion} IS NOT NULL
ORDER BY ${input.criterion === "games" ? "games" : input.criterion} ${input.order === "asc" ? "ASC" : "DESC"}, games DESC, b.name
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.minGames == null && minGamesOfTeams(input) > 3)
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: "Peu de parties par équipe dans ce périmètre : seuil abaissé à 3 parties.", reason: "seuil de parties abaissé" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(TeamLeaderRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const scope = `${scopeLabel(league, input) || "toutes compétitions"}${sideLabel(input.side)}`;
    const def = TEAM_CRITERION_DEFS[input.criterion];
    const minGames = minGamesOfTeams(input);
    const columns = teamColumnsOf(input);
    const value = (r: z.infer<typeof TeamLeaderRow>, c: TeamCriterion) => (c === "games" ? r.games : (r[c] ?? null));
    const ingame = rows.reduce((n, r) => n + r.ingame_games, 0);
    const params: Params = {};
    const gameScope = competitionScope("g", leagueAndPeriod(input), params);
    const pages = selectAll(db, z.object({ event_page: Text }), `SELECT DISTINCT g.event_page FROM v_games g WHERE ${gameScope} ORDER BY g.played_at DESC LIMIT 12`, params).map((r) => r.event_page);
    const ongoing = inProgressNote(db, gameScope, params);
    const lowest = input.order === "asc";

    const line = (r: z.infer<typeof TeamLeaderRow>, i: number) =>
      `${i + 1}. ${displayTeam(r.name)} : ${frNumber(value(r, input.criterion))}${def.unit ?? ""}${input.criterion === "games" ? " parties" : `, ${r.games} parties`}`;

    const facts =
      `Équipes classées ${scope} selon le critère ${def.label} (${def.definition})${lowest ? ", du plus bas au plus haut" : ""}` +
      `${minGames > 1 ? `, minimum ${minGames} parties` : ""} : ${rows.slice(0, 3).map(line).join(" ; ")}. ${rows.length} équipes classées.` +
      (def.ingame && ingame === 0 ? " Aucune partie de ce périmètre n'a de données Riot." : "") +
      (ongoing ? ` ${ongoing}` : "");

    return {
      title: `Classement des équipes — ${def.label}${sideLabel(input.side)}${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Rang", "Équipe", "Parties", ...columns.map((c) => TEAM_CRITERION_DEFS[c].label)],
        rows: rows.map((r, i) => [i + 1, displayTeam(r.name), r.games, ...columns.map((c) => value(r, c))]),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.name}`, url: wikiUrl(r.name) })),
        ...eventSources(pages, 12),
        ...(ingame ? [RIOT_DATA_SOURCE] : []),
      ],
      followUps: [
        ...rows.slice(0, 1).map((r) => `Historique de ${displayTeam(r.name)}`),
        ...(rows.length >= 2 ? [`${displayTeam(rows[0].name)} contre ${displayTeam(rows[1].name)}`] : []),
        ...rows.slice(0, 1).map((r) => `Champion pool de ${displayTeam(r.name)}${scopeLabel(league, input) ? ` ${scopeLabel(league, input)}` : ""}`),
      ],
      totals: {
        leader: rows[0] ? displayTeam(rows[0].name) : "",
        leader_value: rows[0] ? (value(rows[0], input.criterion) ?? "n/d") : "n/d",
        leader_games: rows[0]?.games ?? 0,
        rows: rows.length,
        min_games: minGames,
        criterion: input.criterion,
      },
    };
  },
  // A side's win rate already names its side; "top 5 équipes" is not a minimum of 1 game.
  normalize: (_db, input) => ({
    ...input,
    side: input.criterion === "blue_winrate" || input.criterion === "red_winrate" ? null : input.side,
    minGames: input.minGames != null && input.minGames >= 3 ? input.minGames : null,
  }),
};

// 12. A champion against the champions it faces in its role -----------------------------------

/** A matchup needs a few games before its win rate is called the best or the worst. */
const MATCHUP_MIN_GAMES = 3;

/** The games of a champion (`a` is v_game_players) in the competition, period and role asked. */
function matchupScope(alias: string, input: ChampionMatchupInput, params: Params): string {
  params.champion = input.champion;
  const league = input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "";
  const role = input.role ? ((params.role = input.role), `AND ${alias}.role = :role`) : "";

  return `${alias}.champion = :champion AND ${alias}.stage IN (${COMPETITION_STAGES}) ${league} ${role} ${periodFilter(`${alias}.year`, input, params)}`;
}

/** The direct opponent: the same role on the other side of the same game. */
const LANE_OPPONENT = "JOIN v_game_players b ON b.game_id = a.game_id AND b.role = a.role AND b.side <> a.side AND b.champion IS NOT NULL";

const MatchupListRow = z.object({
  champion: Text,
  icon: NullableText,
  games: z.number(),
  wins: z.number(),
  winrate: z.number().nullable(),
  kda: z.number().nullable(),
  gold_diff_15: z.number().nullable(),
  total_games: z.number(),
  total_wins: z.number(),
  opponents: z.number(),
});

const MatchupGameRow = z.object({
  played_at: z.number().nullable(),
  league_short: Text,
  year: z.number().nullable(),
  event_page: Text,
  role: NullableText,
  player_a: Text,
  team_a: NullableText,
  win: z.number().nullable(),
  kills_a: z.number().nullable(),
  deaths_a: z.number().nullable(),
  assists_a: z.number().nullable(),
  player_b: Text,
  team_b: NullableText,
  kills_b: z.number().nullable(),
  deaths_b: z.number().nullable(),
  assists_b: z.number().nullable(),
  gold_diff_15: z.number().nullable(),
  total_games: z.number(),
  total_wins: z.number(),
  kda_a: z.number().nullable(),
  kda_b: z.number().nullable(),
  avg_gold_diff_15: z.number().nullable(),
  ingame_games: z.number(),
});

/** "d'Azir", "de Jax": the French elision before a vowel or a mute h. */
const of = (name: string) => (/^[aeiouyhàâéèêîôû]/i.test(name) ? `d'${name}` : `de ${name}`);

const kdaText = (k: number | null, d: number | null, a: number | null) => (k == null || d == null || a == null ? null : `${k}/${d}/${a}`);

const championMatchup: ToolDef<ChampionMatchupInput> = {
  name: "champion_matchup",
  label: "matchup de champions",
  description:
    "A champion against its direct opponents (the champion played in the same role on the other team): against one named champion, the games, " +
    "the win rate, both KDAs and the gold difference at 15 min ('Azir contre Orianna', 'winrate de Jax face à Renekton en top'); " +
    "without one, the champions it faced most with its win rate against each ('matchups d'Azir', 'contre qui Azir perd le plus', 'counters de K'Sante'). " +
    "For one champion's own stats use champion_event_stats.",
  plan: (_db, input) => {
    const params: Params = {};
    const scope = matchupScope("a", input, params);
    // The lane figure of the champion's player in the same games, where Leaguepedia hosts the Riot data.
    const ingame = `LEFT JOIN v_game_player_stats s ON s.game_id = a.game_id AND s.player = a.player`;

    if (input.opponent) {
      params.opponent = input.opponent;

      return {
        params,
        sql: tidy(`SELECT a.played_at, a.league_short, a.year, a.event_page, a.role,
       a.player AS player_a, a.team AS team_a, a.win, a.kills AS kills_a, a.deaths AS deaths_a, a.assists AS assists_a,
       b.player AS player_b, b.team AS team_b, b.kills AS kills_b, b.deaths AS deaths_b, b.assists AS assists_b,
       s.gold_diff_15,
       COUNT(*) OVER () AS total_games, COALESCE(SUM(a.win) OVER (), 0) AS total_wins,
       ROUND(1.0 * ${kaSum("a")} OVER () / MAX(1, ${deathsSum("a")} OVER ()), 2) AS kda_a,
       ROUND(1.0 * ${kaSum("b")} OVER () / MAX(1, ${deathsSum("b")} OVER ()), 2) AS kda_b,
       ROUND(AVG(s.gold_diff_15) OVER (), 0) AS avg_gold_diff_15, COUNT(s.gold_diff_15) OVER () AS ingame_games
FROM v_game_players a ${LANE_OPPONENT} AND b.champion = :opponent
${ingame}
WHERE ${scope}
ORDER BY a.played_at DESC
LIMIT 30`),
      };
    }

    return {
      params,
      sql: tidy(`WITH m AS (
  SELECT a.win, a.kills, a.deaths, a.assists, b.champion AS opponent, s.gold_diff_15
  FROM v_game_players a ${LANE_OPPONENT}
  ${ingame}
  WHERE ${scope}
),
n AS (SELECT COUNT(*) AS total_games, COALESCE(SUM(m.win), 0) AS total_wins, COUNT(DISTINCT m.opponent) AS opponents FROM m)
SELECT m.opponent AS champion, c.icon_url AS icon, COUNT(*) AS games, COALESCE(SUM(m.win), 0) AS wins,
       ROUND(100.0 * SUM(m.win) / COUNT(m.win), 1) AS winrate,
       ROUND(1.0 * ${kaSum("m")} / MAX(1, ${deathsSum("m")}), 2) AS kda,
       ROUND(AVG(m.gold_diff_15), 0) AS gold_diff_15,
       n.total_games, n.total_wins, n.opponents
FROM m CROSS JOIN n LEFT JOIN champions c ON c.name = m.opponent
GROUP BY m.opponent
ORDER BY games DESC, winrate DESC, champion
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.role) out.push({ key: "role", input: { ...input, role: null }, note: `Aucune partie en ${ROLE_LABEL[input.role]} : affichage de tous les rôles.`, reason: "filtre de rôle retiré" });

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null, yearFrom: null, yearTo: null }, note: "Aucune partie dans cette compétition : affichage de toutes les compétitions.", reason: "filtre de compétition retiré" });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input) || "toutes compétitions";
    const role = input.role ? ` en ${ROLE_LABEL[input.role]}` : "";
    const names = [input.champion, ...(input.opponent ? [input.opponent] : [])];
    const iconParams: Params = {};

    const icons = Object.fromEntries(
      selectAll(db, z.object({ name: Text, icon_url: NullableText }), `SELECT name, icon_url FROM champions WHERE name IN (${inList("c", names, iconParams)})`, iconParams).flatMap((c) =>
        c.icon_url ? [[c.name, c.icon_url]] : [],
      ),
    );

    const championSource = (name: string): Source => ({ label: `Leaguepedia — ${name}`, url: wikiUrl(name) });
    const ddragon: Source = { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` };

    if (input.opponent) {
      const rows = z.array(MatchupGameRow).parse(sqlRows);
      const t = rows[0];
      const games = t?.total_games ?? 0;
      const wins = t?.total_wins ?? 0;
      const day = (s: number | null) => (s == null ? null : DAY_SHORT.format(new Date(s * 1000)));

      const facts =
        `${input.champion} contre ${input.opponent}${role} ${scope} (même rôle, équipes opposées) : ${games} parties, ${input.champion} en gagne ${wins} (${pct(wins, games)} %) ` +
        `et ${input.opponent} ${games - wins}. KDA ${of(input.champion)} : ${frNumber(t?.kda_a ?? null)}, ${of(input.opponent)} : ${frNumber(t?.kda_b ?? null)}.` +
        (t?.ingame_games
          ? ` Écart d'or moyen ${of(input.champion)} à 15 min : ${frNumber(t.avg_gold_diff_15, true)}, sur ${t.ingame_games} parties avec données Riot.`
          : " Écart d'or à 15 min n/d : aucune de ces parties n'a de données Riot.") +
        (games > rows.length ? ` Les ${rows.length} parties les plus récentes sont listées.` : "");

      return {
        title: `${input.champion} contre ${input.opponent}${role}${league === "toutes compétitions" ? "" : ` — ${league}`}`,
        table: {
          columns: ["Date", "Compétition", "Rôle", input.champion, "K/D/A", input.opponent, "K/D/A ", "Vainqueur", "Écart or @15"],
          rows: rows.map((r) => [
            day(r.played_at),
            `${r.league_short}${r.year ? ` ${r.year}` : ""}`,
            r.role,
            `${r.player_a}${r.team_a ? ` (${displayTeam(r.team_a)})` : ""}`,
            kdaText(r.kills_a, r.deaths_a, r.assists_a),
            `${r.player_b}${r.team_b ? ` (${displayTeam(r.team_b)})` : ""}`,
            kdaText(r.kills_b, r.deaths_b, r.assists_b),
            r.win == null ? null : r.win ? input.champion : input.opponent,
            r.gold_diff_15,
          ]),
        },
        icons,
        facts,
        sources: [...names.map(championSource), ...eventSources(rows.map((r) => r.event_page).reverse(), 10), ...(t?.ingame_games ? [RIOT_DATA_SOURCE] : []), ddragon],
        followUps: [`Matchups ${of(input.champion)}${role}`, `Stats ${of(input.champion)} ${inLeague(league) || "aux Worlds"}`, `Stats ${of(input.opponent)} ${inLeague(league) || "aux Worlds"}`],
        totals: {
          games,
          wins,
          losses: games - wins,
          winrate: games ? pct(wins, games) : "n/d",
          kda: t?.kda_a ?? "n/d",
          opponent_kda: t?.kda_b ?? "n/d",
          gold_diff_15: t?.avg_gold_diff_15 ?? "n/d",
          ingame_games: t?.ingame_games ?? 0,
        },
      };
    }

    const rows = z.array(MatchupListRow).parse(sqlRows);
    const games = rows[0]?.total_games ?? 0;
    const wins = rows[0]?.total_wins ?? 0;
    const enough = rows.filter((r) => r.games >= MATCHUP_MIN_GAMES && r.winrate != null);
    const best = enough.toSorted((x, y) => (y.winrate ?? 0) - (x.winrate ?? 0) || y.games - x.games)[0];
    const worst = enough.toSorted((x, y) => (x.winrate ?? 0) - (y.winrate ?? 0) || y.games - x.games)[0];
    const line = (r: z.infer<typeof MatchupListRow>) => `${r.champion} (${r.games} parties, ${frNumber(r.winrate)} % de victoires pour ${input.champion})`;

    const facts =
      `${input.champion}${role} ${scope} : ${games} parties face à un adversaire direct (même rôle, équipe opposée), ${pct(wins, games)} % de victoires, ` +
      `${rows[0]?.opponents ?? 0} champions affrontés. Les plus fréquents : ${rows.slice(0, 3).map((r, i) => `${i + 1}. ${line(r)}`).join(", ")}.` +
      (best && worst && best.champion !== worst.champion
        ? ` Parmi les ${rows.length} plus fréquents, avec au moins ${MATCHUP_MIN_GAMES} parties : meilleur bilan contre ${line(best)}, pire bilan contre ${line(worst)}.`
        : "");

    return {
      title: `Matchups ${of(input.champion)}${role}${league === "toutes compétitions" ? "" : ` — ${league}`}`,
      table: {
        columns: ["rank", "champion", "games", "wins", "winrate", "kda", "gold_diff_15"],
        rows: rows.map((r, i) => [i + 1, r.champion, r.games, r.wins, r.winrate, r.kda, r.gold_diff_15]),
      },
      icons: { ...icons, ...Object.fromEntries(rows.flatMap((r) => (r.icon ? [[r.champion, r.icon]] : []))) },
      facts,
      sources: [championSource(input.champion), ...(rows.some((r) => r.gold_diff_15 != null) ? [RIOT_DATA_SOURCE] : []), ddragon],
      followUps: [...rows.slice(0, 2).map((r) => `${input.champion} contre ${r.champion}${role}`), `Stats ${of(input.champion)} ${inLeague(league) || "aux Worlds"}`],
      totals: {
        games,
        wins,
        winrate: games ? pct(wins, games) : "n/d",
        opponents: rows[0]?.opponents ?? 0,
        top_opponent: rows[0]?.champion ?? "",
        top_opponent_games: rows[0]?.games ?? 0,
        best_matchup: best?.champion ?? "",
        worst_matchup: worst?.champion ?? "",
        rows: rows.length,
      },
    };
  },
  normalize: (db, input) => {
    const c = resolveChampion(db, input.champion);
    const o = input.opponent ? resolveChampion(db, input.opponent) : null;

    if (!c || (input.opponent && !o)) return null;

    return { ...input, champion: c.champion, opponent: o && o.champion !== c.champion ? o.champion : null };
  },
};

// 13. The best single games on one figure ------------------------------------------------------

type RecordDef = {
  /** Column header. */
  label: string;
  /** "kills", "de dégâts": what the figure counts, in a sentence. */
  unit: string;
  column: string;
  /** From the Riot game data (v_game_player_stats) rather than the scoreboard (v_game_players). */
  ingame?: true;
  signed?: true;
};

export const RECORD_DEFS: Record<RecordMetric, RecordDef> = {
  kills: { label: "Kills", unit: "kills", column: "kills" },
  deaths: { label: "Morts", unit: "morts", column: "deaths" },
  assists: { label: "Assists", unit: "assists", column: "assists" },
  damage: { label: "Dégâts", unit: "dégâts aux champions", column: "damage" },
  cs: { label: "CS", unit: "CS", column: "cs" },
  gold: { label: "Or", unit: "d'or", column: "gold" },
  vision: { label: "Vision", unit: "de score de vision", column: "vision" },
  gold_diff_15: { label: "Écart or @15", unit: "d'or d'écart à 15 min face à l'adversaire direct", column: "gold_diff_15", ingame: true, signed: true },
  cs_diff_15: { label: "Écart CS @15", unit: "CS d'écart à 15 min face à l'adversaire direct", column: "cs_diff_15", ingame: true, signed: true },
  solo_kills: { label: "Solo kills", unit: "solo kills", column: "solo_kills", ingame: true },
};

const GameRecordRow = z.object({
  player: Text,
  champion: NullableText,
  icon: NullableText,
  team: NullableText,
  opponent: NullableText,
  win: z.number().nullable(),
  kills: z.number().nullable(),
  deaths: z.number().nullable(),
  assists: z.number().nullable(),
  value: z.number(),
  length_s: z.number().nullable(),
  played_at: z.number().nullable(),
  league_short: Text,
  year: z.number().nullable(),
  event_page: Text,
});

/** The picks a record is looked up in (`x` is the players view): competition, period, role, and one player when asked. */
function recordScope(input: GameRecordsInput, params: Params): string {
  const player = input.player ? ((params.player = input.player), "AND x.player = :player") : "";

  return `${competitionScope("x", input, params)} ${player}`;
}

const gameRecords: ToolDef<GameRecordsInput> = {
  name: "game_records",
  label: "records sur une partie",
  description:
    "The best single-game performances on one figure, in a competition and period, optionally of one role or of one player: most kills, deaths, " +
    "assists, damage, CS, gold or vision in one game, and, from the Riot game data, biggest gold or CS lead at 15 min and most solo kills. " +
    "Each line is one game: player, champion, teams, event, date. Use it for 'record de kills en une partie aux Worlds', " +
    "'most kills in a single game', 'meilleure game de Faker en kills'. For totals or averages over many games use player_leaderboard or ingame_leaderboard.",
  plan: (_db, input) => {
    const params: Params = {};
    const def = RECORD_DEFS[input.metric];

    return {
      params,
      sql: tidy(`SELECT x.player, x.champion, c.icon_url AS icon, x.team,
       CASE WHEN x.team = g.blue_team THEN g.red_team ELSE g.blue_team END AS opponent,
       x.win, x.kills, x.deaths, x.assists, x.${def.column} AS value, g.length_s, x.played_at, x.league_short, x.year, x.event_page
FROM ${def.ingame ? "v_game_player_stats" : "v_game_players"} x JOIN v_games g ON g.game_id = x.game_id
LEFT JOIN champions c ON c.name = x.champion
WHERE ${recordScope(input, params)} AND x.${def.column} IS NOT NULL
ORDER BY value DESC, x.played_at, x.player
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.role) out.push({ key: "role", input: { ...input, role: null }, note: "Aucune partie à ce poste dans ce périmètre : tous les postes.", reason: "filtre de rôle retiré" });

    // A competition without Riot data has no lane figure: another competition's records would answer another question.
    if (input.league && !RECORD_DEFS[input.metric].ingame)
      out.push({ key: "league", input: { ...input, league: null }, note: "Aucune partie dans cette compétition : affichage de toutes les compétitions.", reason: "filtre de compétition retiré" });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(GameRecordRow).parse(sqlRows);
    const def = RECORD_DEFS[input.metric];
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input) || "toutes compétitions";
    const who = `${input.player ? ` ${of(input.player)}` : ""}${input.role ? ` (${ROLE_PLAYERS[input.role]})` : ""}`;
    const day = (s: number | null) => (s == null ? null : DAY_SHORT.format(new Date(s * 1000)));
    const event = (r: z.infer<typeof GameRecordRow>) => `${r.league_short}${r.year ? ` ${r.year}` : ""}`;
    const figure = (r: z.infer<typeof GameRecordRow>) => frNumber(r.value, def.signed);
    const params: Params = {};
    const cov = def.ingame ? coverage(db, `SELECT COUNT(*) AS games, COALESCE(SUM(has_ingame), 0) AS ingame FROM v_games s WHERE ${ingameScope(input, params)}`, params) : null;

    const line = (r: z.infer<typeof GameRecordRow>, i: number) =>
      `${i + 1}. ${r.player} : ${figure(r)} (${[r.champion, r.team && r.opponent ? `${displayTeam(r.team)} contre ${displayTeam(r.opponent)}` : null, event(r), day(r.played_at)].filter(Boolean).join(", ")})`;

    const facts =
      `Meilleures parties${who} ${scope} sur le critère ${def.unit}, une ligne par partie : ${rows.slice(0, 3).map(line).join(" ; ")}.` +
      (rows.length > 1 && rows[0].value === rows[1].value ? ` ${rows.filter((r) => r.value === rows[0].value).length} parties à égalité en tête.` : "") +
      (cov ? coverageNote(cov) : "");

    return {
      title: `Records sur une partie — ${def.label.toLowerCase()}${who}${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Rang", "Joueur", "Champion joué", "Équipe", "Adversaire", "Compétition", "Date", def.label, "K/D/A", "Durée", "Résultat"],
        rows: rows.map((r, i) => [
          i + 1,
          r.player,
          r.champion,
          r.team ? displayTeam(r.team) : null,
          r.opponent ? displayTeam(r.opponent) : null,
          event(r),
          day(r.played_at),
          r.value,
          kdaText(r.kills, r.deaths, r.assists),
          r.length_s ? clock(r.length_s) : null,
          r.win == null ? null : r.win ? "Victoire" : "Défaite",
        ]),
      },
      icons: Object.fromEntries(rows.flatMap((r) => (r.champion && r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [
        ...[...new Set(rows.slice(0, 3).map((r) => r.player))].map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })),
        ...eventSources(rows.map((r) => r.event_page).reverse(), 10),
        ...(def.ingame ? [RIOT_DATA_SOURCE] : []),
      ],
      followUps: [
        ...[...new Set(rows.map((r) => r.player))].slice(0, 2).map((p) => `Dernières parties de ${p}`),
        ...(input.player ? [] : [`Joueurs avec le plus de kills ${inLeague(league) || "aux Worlds"}`]),
      ],
      totals: {
        leader: rows[0]?.player ?? "",
        leader_value: rows[0]?.value ?? "n/d",
        leader_champion: rows[0]?.champion ?? "",
        leader_event: rows[0] ? event(rows[0]) : "",
        rows: rows.length,
        metric: input.metric,
      },
    };
  },
  normalize: (db, input) => {
    if (!input.player) return input;
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// 14. A player's latest games ------------------------------------------------------------------

const RECENT_DEFAULT = 10;

const RecentGameRow = z.object({
  played_at: z.number(),
  league_short: Text,
  year: z.number().nullable(),
  event_page: Text,
  tab: NullableText,
  team: NullableText,
  opponent: NullableText,
  champion: NullableText,
  icon: NullableText,
  win: z.number().nullable(),
  kills: z.number().nullable(),
  deaths: z.number().nullable(),
  assists: z.number().nullable(),
  cs: z.number().nullable(),
  damage: z.number().nullable(),
  length_s: z.number().nullable(),
});

const playerRecentGames: ToolDef<PlayerRecentInput> = {
  name: "player_recent_games",
  label: "dernières parties d'un joueur",
  description:
    "A player's latest games, newest first (10 by default): date, event, team, opponent, champion, result, K/D/A, CS, damage and duration, " +
    "with the record, the KDA and the current streak over those games. Use it for 'forme récente de Faker', 'dernières parties de Caps', " +
    "'last 5 games of Chovy', 'comment joue Ruler en ce moment'. For a whole event or career use player_event_history.",
  plan: (_db, input) => {
    const params: Params = {};

    params.player = input.player;
    const league = input.league ? `AND ${leagueFilter("p.league", input, params)}` : "";

    return {
      params,
      sql: tidy(`SELECT p.played_at, p.league_short, p.year, p.event_page, g.tab, p.team,
       CASE WHEN p.team = g.blue_team THEN g.red_team ELSE g.blue_team END AS opponent,
       p.champion, c.icon_url AS icon, p.win, p.kills, p.deaths, p.assists, p.cs, p.damage, g.length_s
FROM v_game_players p JOIN v_games g ON g.game_id = p.game_id
LEFT JOIN champions c ON c.name = p.champion
WHERE p.player = :player AND p.stage IN (${COMPETITION_STAGES}) AND p.played_at IS NOT NULL ${league} ${periodFilter("p.year", input, params)}
ORDER BY p.played_at DESC, p.game_id DESC
LIMIT ${input.count ?? RECENT_DEFAULT}`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, "toutes les saisons"));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: "Aucune partie dans cette compétition : affichage de toutes les compétitions.", reason: "filtre de compétition retiré" });
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({ key: `player:${other}`, input: { ...input, player: other }, note: `« ${resolved!.mention} » désigne aussi ${other} : parties de ${other}.`, reason: `alias homonyme essayé : ${other}` });

    return out;
  },
  format: (db, input, sqlRows): ToolOutput => {
    const rows = z.array(RecentGameRow).parse(sqlRows);
    const league = leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const day = (s: number) => DAY_SHORT.format(new Date(s * 1000));
    const decided = rows.filter((r) => r.win != null);
    const wins = decided.filter((r) => r.win).length;
    const scored = rows.filter((r) => r.kills != null && r.deaths != null && r.assists != null);
    const sum = (pick: (r: z.infer<typeof RecentGameRow>) => number | null) => scored.reduce((n, r) => n + (pick(r) ?? 0), 0);
    const [kills, deaths, assists] = [sum((r) => r.kills), sum((r) => r.deaths), sum((r) => r.assists)];
    const kda = scored.length ? Math.round((100 * (kills + assists)) / Math.max(1, deaths)) / 100 : null;
    const per = (n: number) => frNumber(Math.round((10 * n) / Math.max(1, scored.length)) / 10);
    // The streak the latest game is part of.
    const streak = decided.findIndex((r) => r.win !== decided[0].win);
    const run = decided.length ? (streak < 0 ? decided.length : streak) : 0;
    const champions = new Map<string, number>();

    for (const r of rows) if (r.champion) champions.set(r.champion, (champions.get(r.champion) ?? 0) + 1);
    const played = [...champions].toSorted((a, b) => b[1] - a[1]);
    const last = rows[0];
    const first = rows[rows.length - 1];

    const facts =
      `${input.player} : ses ${rows.length} dernières parties${scope ? ` ${scope}` : ""}${first && last ? ` (du ${day(first.played_at)} au ${day(last.played_at)})` : ""} : ` +
      `${wins} victoire${wins > 1 ? "s" : ""}, ${decided.length - wins} défaite${decided.length - wins > 1 ? "s" : ""}, KDA ${frNumber(kda)} (${per(kills)} / ${per(deaths)} / ${per(assists)} par partie).` +
      (run > 1 ? ` Série en cours : ${run} ${decided[0].win ? "victoires" : "défaites"} de suite.` : "") +
      (played.length ? ` Champions joués : ${played.slice(0, 4).map(([c, n]) => `${c} ×${n}`).join(", ")}.` : "") +
      (last ? ` Dernière partie : ${last.win == null ? "résultat n/d" : last.win ? "victoire" : "défaite"}${last.opponent ? ` contre ${displayTeam(last.opponent)}` : ""}${last.champion ? ` sur ${last.champion}` : ""} (${last.league_short}${last.year ? ` ${last.year}` : ""}).` : "");

    return {
      title: `${input.player} — ${rows.length} dernières parties${league === "toutes compétitions" ? "" : ` (${league})`}`,
      table: {
        columns: ["Date", "Compétition", "Équipe", "Adversaire", "Champion joué", "Résultat", "K/D/A", "CS", "Dégâts", "Durée"],
        rows: rows.map((r) => [
          day(r.played_at),
          [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · "),
          r.team ? displayTeam(r.team) : null,
          r.opponent ? displayTeam(r.opponent) : null,
          r.champion,
          r.win == null ? null : r.win ? "Victoire" : "Défaite",
          kdaText(r.kills, r.deaths, r.assists),
          r.cs,
          r.damage,
          r.length_s ? clock(r.length_s) : null,
        ]),
      },
      icons: Object.fromEntries(rows.flatMap((r) => (r.champion && r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [{ label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) }, ...eventSources(rows.map((r) => r.event_page).reverse(), 8)],
      followUps: [`Champion pool de ${input.player}`, `Stats in-game de ${input.player}`, `Résultats de ${input.player} ${input.league ? inLeague(league) : "aux Worlds"}`],
      totals: {
        games: rows.length,
        wins,
        losses: decided.length - wins,
        kda: kda ?? "n/d",
        streak: run,
        streak_kind: decided.length ? (decided[0].win ? "wins" : "losses") : "",
        last_champion: last?.champion ?? "",
        last_opponent: last?.opponent ? displayTeam(last.opponent) : "",
      },
    };
  },
  normalize: (db, input) => {
    const p = resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

// Registry ----------------------------------------------------------------------------

/** Capture each tool's input/implementation relationship once, before indexing the heterogeneous registry. */
function defineTool<S extends z.ZodType>(input: S, def: ToolDef<z.infer<S>>) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the registry parsing boundary.
  const bind = (db: DatabaseSync, raw: unknown): BoundTool => {
    const value = input.parse(raw);
    const plan = def.plan(db, value);

    return {
      // SAFETY: defineTool captures this definition with its own validated schema.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript erases the captured heterogeneous pair.
      call: { tool: def.name, input: value } as unknown as ToolCall,
      label: def.label,
      ...plan,
      relaxations: (entities) => def.relaxations(value, entities).map((r) => ({ ...r, next: () => bind(db, r.input) })),
      format: (formatDb, rows) => def.format(formatDb, value, rows),
    };
  };

  return { input, bind, ai: tool({ description: def.description, inputSchema: input }),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The schema parses dynamic SDK input here.
    normalize: (db: DatabaseSync, raw: unknown): ToolCall | null => {
      const value = def.normalize(db, input.parse(raw));

      // SAFETY: normalize preserves the definition's input type and tool name.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript erases the captured heterogeneous pair.
      return value == null ? null : { tool: def.name, input: value } as unknown as ToolCall;
    },
  };
}

export const TOOLS = {
  player_event_history: defineTool(PlayerHistoryInput, playerEventHistory),
  team_history: defineTool(TeamHistoryInput, teamHistory),
  team_roster: defineTool(TeamRosterInput, teamRoster),
  head_to_head: defineTool(HeadToHeadInput, headToHead),
  player_comparison: defineTool(PlayerComparisonInput, playerComparison),
  champion_event_stats: defineTool(ChampionStatsInput, championEventStats),
  champion_ranking: defineTool(ChampionRankingInput, championRanking),
  champion_pool: defineTool(ChampionPoolInput, championPool),
  player_leaderboard: defineTool(PlayerLeaderboardInput, playerLeaderboard),
  tournament_standings: defineTool(StandingsInput, tournamentStandings),
  player_ingame_stats: defineTool(PlayerIngameInput, playerIngameStats),
  ingame_leaderboard: defineTool(LeaderboardInput, ingameLeaderboard),
  team_ingame_stats: defineTool(TeamIngameInput, teamIngameStats),
  game_timeline: defineTool(GameTimelineInput, gameTimeline),
  series: defineTool(SeriesInput, series),
  team_leaderboard: defineTool(TeamLeaderboardInput, teamLeaderboard),
  champion_matchup: defineTool(ChampionMatchupInput, championMatchup),
  game_records: defineTool(GameRecordsInput, gameRecords),
  player_recent_games: defineTool(PlayerRecentInput, playerRecentGames),
};

export function bindTool(db: DatabaseSync, call: ToolCall): BoundTool {
  return TOOLS[call.tool].bind(db, call.input);
}

type AiTools = { [K in ToolName]: (typeof TOOLS)[K]["ai"] };

// SAFETY: entries preserve each registry key and its own AI SDK tool.
export const aiTools = Object.fromEntries(Object.entries(TOOLS).map(([name, def]) => [name, def.ai])) as AiTools;

export function normalizeToolCall(db: DatabaseSync, call: StaticToolCall<typeof aiTools>): ToolCall | null {
  return TOOLS[call.toolName].normalize(db, call.input);
}
