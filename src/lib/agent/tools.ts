import { answerLocale, type Phrase, phrase, say, tr } from "./messages";
import { dateFormat, NO_DATA, numberFormat } from "../locale";
import { DRAGON_ICON_FILES, dragonLabel, isDragonKind, PLAIN_DRAGON_ICON_FILE } from "../domain/dragons";
import { runeIcon } from "../domain/rune-icons";
import { displayTeam } from "../domain/teams";
import { wikiImageUrl } from "../domain/wiki-images";
import { ITEM_KINDS } from "../domain/items";
import { englishIn, frenchIn, frenchOf, LEAGUES, leagueMembers, ROSTER_EXCLUDED } from "../domain/leagues";
import { YEAR_MIN } from "../domain/years";
import { type StaticToolCall, tool } from "ai";
import { z } from "zod";
import { type Db, selectAll, selectOne, type SqlRow } from "../db";
import { DDRAGON_BASE } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { clock, type EventDetail, type ParsedTimeline, type RiotTeam, type TowerTier } from "../sources/timeline";
import { loadTimeline } from "../storage/timelines";
import { MAX_ROWS } from "./guard";
import {
  type ChampionItems,
  type ChampionPlayer,
  type ChampionPool,
  type ChampionPoolLine,
  type ChampionProfile,
  type ChampionSetups,
  type Entities,
  type GameScoreboard,
  LEAGUE_NAMES,
  type PlayerProfile,
  type PlayerRunes,
  type ResultRow,
  RUNE_KINDS,
  type RuneKind,
  type RunePage,
  type RuneTree,
  type ScoreboardPlayer,
  type ScoreboardTeam,
  type Side,
  type AnswerTable,
  type Source,
  type SeriesDetail,
  type SeriesList,
  type SeriesGame,
  type SeriesPick,
  type Split,
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
import { playerPhoto } from "../domain/player-photos";
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

const COMPETITION_STAGES = "'main_event', 'play_in', 'season', 'playoffs'";

const atLeast = (n: number, expr: string) => `(CASE WHEN (${expr}) IS NULL THEN NULL ELSE GREATEST(${n}, ${expr}) END)`;

const latest = (column: string, at: string) => `(ARRAY_AGG(${column} ORDER BY ${at} DESC NULLS LAST))[1]`;

const STANDINGS_STAGES = "'event', 'main_event', 'season', 'playoffs'";

const regularSeason = (t: string) =>
  `(${t}.stage = 'season'
    AND NOT EXISTS (SELECT 1 FROM v_games f WHERE f.tournament_page = ${t}.tournament_page AND f.tab ILIKE '%final%')
    AND (EXISTS (SELECT 1 FROM v_tournaments p WHERE p.league = ${t}.league AND p.year = ${t}.year AND p.stage = 'playoffs' AND COALESCE(p.split, '') = COALESCE(${t}.split, ''))
      OR (EXISTS (SELECT 1 FROM v_games w WHERE w.tournament_page = ${t}.tournament_page AND w.tab ILIKE 'Week %')
        AND EXISTS (SELECT 1 FROM v_tournaments p WHERE p.league = ${t}.league AND p.year = ${t}.year AND p.tournament_page <> ${t}.tournament_page
              AND (p.stage = 'playoffs' OR (p.stage = 'season' AND EXISTS (SELECT 1 FROM v_games f WHERE f.tournament_page = p.tournament_page AND f.tab ILIKE '%final%')))))))`;

const League = z.enum(LEAGUE_NAMES).describe("Leaguepedia League value. Worlds = World Championship, LCK = LoL Champions Korea.");
const Year = z.number().int().min(YEAR_MIN).nullable();
const Period = { yearFrom: Year.describe("First season (inclusive), null for all"), yearTo: Year.describe("Last season (inclusive), null for all") };

export const MAP_SIDES = ["blue", "red"] as const;

export type MapSide = (typeof MAP_SIDES)[number];

const MapSideInput = z.enum(MAP_SIDES).nullable().describe("Only the games played on this side of the map ('côté bleu', 'red side'), null for both sides");

const RankingSplitInput = z.enum(["Spring", "Summer", "Winter"]).nullish().describe("Restrict to one split of the season ('LEC Spring 2024', 'au printemps'), null for the whole season");

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
  kind: z.enum(["team"]),
  sideA: z.string().min(1),
  sideB: z.string().min(1),
  league: League.nullable(),
  ...Period,
});

const MinuteInput = z
  .union([z.literal(10), z.literal(15), z.literal(20)])
  .nullable()
  .describe("Minute of the snapshot for gold/CS/XP metrics (10, 15 or 20), null for 15");

export const COMPARISON_END_STATS = ["kills", "deaths", "assists", "damage", "vision"] as const;

export type ComparisonEndStat = (typeof COMPARISON_END_STATS)[number];

export const COMPARISON_METRICS = [...PLAYER_METRICS, ...COMPARISON_END_STATS] as const;

export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

export const PlayerComparisonInput = z.object({
  playerA: z.string().min(1).describe("First player's handle or Leaguepedia page"),
  playerB: z.string().min(1).describe("Second player's handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  metric: z
    .enum(COMPARISON_METRICS)
    .nullable()
    .describe("The statistic the question names (penta_kills, solo_kills, first_bloods, deaths...), shown first; null for the overview"),
  minute: MinuteInput,
});

export const CHAMPION_FOCUS = ["items", "runes", "spells"] as const;

export type ChampionFocus = (typeof CHAMPION_FOCUS)[number];

export const ChampionStatsInput = z.object({
  champion: z.string().min(1).describe("Champion name (Ahri, Lee Sin, Kai'Sa...)"),
  league: League,
  ...Period,
  focus: z.enum(CHAMPION_FOCUS).nullable().default(null).describe("What the question is about, when it names one: the champion's items, runes or summoner spells. The profile shows that part first."),
});

export const CHAMPION_AVERAGE_SORTS = ["kills", "deaths", "assists", "gold", "cs", "damage", "vision"] as const;

export type ChampionAverageSort = (typeof CHAMPION_AVERAGE_SORTS)[number];

export const CHAMPION_EXTRA_SORTS = ["dpm", "gpm", "cspm", "gold_diff_15", "cs_diff_15", "xp_diff_15", "first_blood", "solo_kills", "players"] as const;

export type ChampionExtraSort = (typeof CHAMPION_EXTRA_SORTS)[number];

export const CHAMPION_MULTIKILL_SORTS = ["penta_kills", "quadra_kills", "triple_kills", "double_kills"] as const;

export const CHAMPION_SORTS = ["picks", "bans", "presence", "winrate", "kda", ...CHAMPION_AVERAGE_SORTS, ...CHAMPION_EXTRA_SORTS, ...CHAMPION_MULTIKILL_SORTS] as const;

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
  split: RankingSplitInput,
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
  split: RankingSplitInput,
});

export type PlayerLeaderboardInput = z.infer<typeof PlayerLeaderboardInput>;

export const StandingsInput = z.object({
  league: League,
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable(),
  full: z.boolean().describe("true: every placement of the event(s); false: champion and finalist of each event"),
});

const ROLES = ["Top", "Jungle", "Mid", "Bot", "Support"] as const;

export const PlayerIngameInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page"),
  league: League.nullable().describe("Restrict to one competition, null for every competition with in-game data"),
  ...Period,
  metric: z.enum(PLAYER_METRICS).nullable().describe("The metric the question is about, shown first; null for the overview"),
  minute: MinuteInput,
});

export const PlayerRunesInput = z.object({
  player: z.string().min(1).describe("Player handle or Leaguepedia page (Faker, Chovy...)"),
  league: League.nullable().describe("Restrict to one competition, null for every competition"),
  ...Period,
  split: z.enum(["Spring", "Summer", "Winter"]).nullable().describe("Restrict to one split of the season, null for the whole season"),
  champion: z.string().min(1).nullable().describe("Only the player's games on this champion ('runes de Faker sur Azir'), null for every champion"),
  role: z.enum(ROLES).nullable().describe("Only the player's games in this role, null for every role"),
});

export type PlayerRunesInput = z.infer<typeof PlayerRunesInput>;

export const LeaderboardInput = z.object({
  subject: z.enum(["player", "team"]),
  metric: z.enum([...new Set([...PLAYER_METRICS, ...TEAM_METRICS])]).describe(
    "Player metrics: solo_kills, penta_kills, quadra_kills, triple_kills, double_kills, first_bloods, kills_before_10, gold_diff, cs_diff, xp_diff, gold, cs, xp, wards_placed, wards_killed, control_wards, plates. " +
      "Team metrics: first_blood, first_tower, first_dragon, first_herald, first_baron, gold_diff, kills_before_10, plates, dragon_soul (share of games with the dragon soul), elder_dragons.",
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
  metric: z.enum(TEAM_METRICS).nullable().default(null).describe("The metric the question is about, brought out in the answer; null for the overview"),
  minute: MinuteInput,
});

export const DragonStatsInput = z.object({
  team: z.string().min(1).nullable().describe("Team name or shorthand (T1, Gen.G, G2...), null for every team of the scope"),
  league: League.nullable(),
  ...Period,
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

export type DragonStatsInput = z.infer<typeof DragonStatsInput>;

export type PlayerHistoryInput = z.infer<typeof PlayerHistoryInput>;

export type TeamHistoryInput = z.infer<typeof TeamHistoryInput>;

export type TeamRosterInput = z.infer<typeof TeamRosterInput>;

export type HeadToHeadInput = z.infer<typeof HeadToHeadInput>;

export type PlayerComparisonInput = z.infer<typeof PlayerComparisonInput>;

export type ChampionStatsInput = z.infer<typeof ChampionStatsInput>;

export type StandingsInput = z.infer<typeof StandingsInput>;

export type ToolName = keyof typeof TOOLS;

export type ToolCall = { [K in ToolName]: { tool: K; input: z.infer<(typeof TOOLS)[K]["input"]> } }[ToolName];

export type ToolInput = ToolCall["input"];

type Params = Record<string, string | number>;

type Plan = { sql: string; params: Params };

type Relaxation<I> = { key: string; input: I; note: string; reason: string };

export type ToolTrace = { status: TraceStatus; title: string; detail?: string };

export type ToolOutput = {
  title: string;
  rows?: ResultRow[];
  table?: AnswerTable;
  timeline?: TimelineView;
  scoreboard?: GameScoreboard;
  versus?: VersusView;
  teams?: TeamHeadToHead;
  roster?: TeamRoster;
  champion?: ChampionProfile;
  pool?: ChampionPool;
  runes?: PlayerRunes;
  series?: SeriesList;
  icons?: Record<string, string>;
  period?: { yearFrom: number | null; yearTo: number | null };
  trace?: ToolTrace[];
  notes?: string[];
  facts: string;
  sources: Source[];
  followUps: string[];
  totals: Record<string, string | number>;
};

type ToolDef<I> = {
  name: string;
  label: Phrase;
  description: string;
  plan: (db: Db, input: I) => Plan | Promise<Plan>;
  relaxations: (input: I, entities: Entities) => Relaxation<I>[];
  format: (db: Db, input: I, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
  normalize: (db: Db, input: I) => I | null | Promise<I | null>;
};

export type BoundTool = {
  call: ToolCall;
  label: string;
  sql: string;
  params: Params;
  relaxations: (entities: Entities) => { key: string; note: string; reason: string; next: () => Promise<BoundTool> }[];
  format: (db: Db, rows: SqlRow[]) => ToolOutput | Promise<ToolOutput>;
};

function inList(prefix: string, values: string[], params: Params): string {
  if (!values.length) return "NULL";

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

function competitionScope(alias: string, input: { league: string | null; role?: string | null; side?: MapSide | null } & Period, params: Params): string {
  const league = input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "";
  const role = input.role ? `AND ${alias}.role = :role` : "";
  const side = input.side ? `AND ${alias}.side = ${SIDE_ID[input.side]}` : "";

  if (input.role) params.role = input.role;

  return `${alias}.stage IN (${COMPETITION_STAGES}) ${league} ${role} ${side} ${periodFilter(`${alias}.year`, input, params)}`;
}

const SIDE_ID: Record<MapSide, number> = { blue: 1, red: 2 };

const sideLabel = (side: MapSide | null) => (side ? say(` côté ${side === "blue" ? "bleu" : "rouge"}`, ` ${side} side`) : "");

const leagueAndPeriod = (input: { league: string | null } & Period) => ({ league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

const YearColumn = z.number().catch(0);

const PlayerCounts = z.array(z.object({ player: z.string(), games: z.number() }));

const tidy = (sql: string) => sql.replace(/\n\s*\n/g, "\n");
const hasPeriod = (i: Period) => i.yearFrom != null || i.yearTo != null;

const titlePeriod = (i: Period) => (hasPeriod(i) ? scopeLabel(null, i).replace(/^(en|in) /, "") : "");

const titleScope = (league: string | null, i: Period, open: " — " | " (") => {
  const scope = [league ?? "", titlePeriod(i)].filter(Boolean).join(" ");

  return scope ? `${open}${scope}${open === " (" ? ")" : ""}` : "";
};

const noPeriod = <I extends Period>(input: I, what: string): Relaxation<I> => ({
  key: "period",
  input: { ...input, yearFrom: null, yearTo: null },
  note: say(`Rien entre ${input.yearFrom ?? "…"} et ${input.yearTo ?? "…"} : affichage de ${what}.`, `Nothing between ${input.yearFrom ?? "…"} and ${input.yearTo ?? "…"}: showing ${what}.`),
  reason: say("filtre de période retiré", "period filter removed"),
});

const pct = (w: number, n: number) => Math.round((100 * w) / Math.max(1, n));
const span = (years: number[]) => (years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "");

const ordinal = (place: string) => place.replace(/\d+/g, (n) => `${n}${/(?<!1)1$/.test(n) ? "st" : /(?<!1)2$/.test(n) ? "nd" : /(?<!1)3$/.test(n) ? "rd" : "th"}`);

export function placeLabel(place: string | null, isRegularSeason = false): string {
  if (!place) return say("Classement non publié", "Standings not published");

  if (isRegularSeason) return say(place === "1" ? "1er de la saison régulière" : `${place}e de la saison régulière`, `${ordinal(place)} in the regular season`);

  if (place === "1") return "Champion";

  if (place === "2") return say("Finaliste", "Runner-up");

  if (place === "3-4") return say("Demi-finale", "Semifinal");

  if (place === "5-8") return say("Quart de finale", "Quarterfinal");

  return say(`Éliminé (${place}e)`, `Eliminated (${ordinal(place)})`);
}

const allCompetitions = () => say("toutes compétitions", "all competitions");

const dayFormat = () => dateFormat(answerLocale(), { day: "numeric", month: "long", year: "numeric" });

async function leagueShortName(db: Db, league: string | null): Promise<string | null> {
  if (!league) return null;

  return (await selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league]))?.short_name ?? league;
}

const leagueLabel = (short: string | null) => short ?? allCompetitions();

const inLeague = (short: string | null) => (short ? say(frenchIn(short), englishIn(short)) : "");

const lastPages = (pages: string[], kept: string[]) => [...pages.filter((p) => !kept.includes(p)), ...kept];

function eventSources(pages: string[], max = 12): Source[] {
  const unique = [...new Set(pages)];

  return unique.slice(-max).map((page) => ({ label: `Leaguepedia — ${page}`, url: wikiUrl(page) }));
}

async function teamMembers(db: Db, team: string): Promise<{ team: string; members: string[] }> {
  const t = await resolveTeam(db, team);

  return t ? { team: t.team, members: t.members } : { team, members: [team] };
}

async function franchiseName(db: Db, column: string, params: Params): Promise<string> {
  const whens = (await renamedTeams(db)).map((f, i) => {
    params[`fr${i}`] = f.team;

    return `WHEN ${column} IN (${inList(`fr${i}_`, f.members, params)}) THEN :fr${i}`;
  });

  return whens.length ? `CASE ${whens.join(" ")} ELSE ${column} END` : column;
}

const Text = z.string();
const NullableText = z.string().nullable();

const pageList = z.array(z.string()).nullable().transform((v) => v ?? []);

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
  champions: z.array(z.object({ name: z.string(), games: z.number(), wins: z.number(), icon: z.string().nullable() })),
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
  schedule_series: z.number(),
  schedule_forfeits: z.number(),
});

const HeadToHeadRow = z.object({
  year: YearColumn,
  league_short: Text,
  event_page: Text,
  tournament: NullableText,
  wins_a: z.number(),
  wins_b: z.number(),
  schedule_series: z.number(),
  schedule_forfeits: z.number(),
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
  players: PlayerCounts,
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

const playerEventHistory: ToolDef<PlayerHistoryInput> = {
  name: "player_event_history",
  label: phrase("historique joueur × compétition", "player history × competition"),
  description:
    "A player's results in one competition, edition by edition: team, final place, game record (W-L) and champions played.",
  plan: async (_db, input) => {
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
       ANY_VALUE(tr.place) AS place, ANY_VALUE(tr.place_number) AS place_number,
       MAX(CASE WHEN ${regularSeason("t")} THEN 1 ELSE 0 END) AS regular_season,
       (SELECT COALESCE(json_agg(json_build_object('name', c.champion, 'games', c.games, 'wins', c.wins,
                                            'icon', ch.icon_url)
                ORDER BY c.games DESC, c.wins DESC, c.champion), '[]'::json)
          FROM champ_counts c LEFT JOIN champions ch ON ch.name = c.champion
         WHERE c.event_page = pg.event_page AND c.team = pg.team) AS champions
FROM player_games pg
LEFT JOIN v_tournament_results tr
  ON tr.event_page = pg.event_page AND tr.team = pg.team
LEFT JOIN v_tournaments t ON t.tournament_page = pg.event_page
GROUP BY pg.year, pg.event_page, pg.team
ORDER BY pg.year NULLS FIRST, MIN(pg.played_at) NULLS FIRST, pg.event_page`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les éditions", "every edition")));
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({
          key: `player:${other}`,
          input: { ...input, player: other },
          note: say(`« ${resolved!.mention} » désigne aussi ${other} : résultats de ${other}.`, `"${resolved!.mention}" also names ${other}: results of ${other}.`),
          reason: say(`alias homonyme essayé : ${other}`, `homonym alias tried: ${other}`),
        });

    return out;
  },
  format: async (db, input, raw): Promise<ToolOutput> => {
    const league = await leagueShortName(db, input.league);

    const rows: ResultRow[] = z.array(PlayerHistoryRow).parse(raw).map((r) => ({
      year: r.year,
      event: r.event_page,
      team: r.team,
      place: r.place,
      placeLabel: placeLabel(r.place, r.regular_season === 1),
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

    const perYear = new Set(rows.map((r) => r.year)).size === events;
    const what = perYear ? say("éditions", events === 1 ? "edition" : "editions") : say("tournois", events === 1 ? "tournament" : "tournaments");

    let facts =
      say(`${input.player} a disputé ${events} ${what} ${frenchOf(leagueLabel(league))} (${span(rows.map((r) => r.year))}) `, `${input.player} played ${events} ${what} of ${leagueLabel(league)} (${span(rows.map((r) => r.year))}) `) +
      say(`avec ${teams.length} équipe${teams.length > 1 ? "s" : ""} (${teams.join(", ")}), `, `with ${teams.length} team${teams.length === 1 ? "" : "s"} (${teams.join(", ")}), `) +
      say(`pour un bilan de ${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %).`, `for a record of ${wins} wins and ${losses} losses in games (${pct(wins, wins + losses)}%).`);

    if (bestRows.length)
      facts += say(
        ` Meilleur résultat : ${placeLabel(bestRows[0].place).toLowerCase()} en ${bestRows.map((r) => `${r.year} (${displayTeam(r.team)})`).join(", ")}.`,
        ` Best result: ${placeLabel(bestRows[0].place).toLowerCase()} in ${bestRows.map((r) => `${r.year} (${displayTeam(r.team)})`).join(", ")}.`,
      );

    if (unranked.length) facts += say(` Classement final ${unranked.map((r) => r.year).join(", ")} pas encore publié sur Leaguepedia.`, ` Final standings of ${unranked.map((r) => r.year).join(", ")} not yet published on Leaguepedia.`);

    const latest = rows[rows.length - 1];

    const teammates = (await selectAll(
      db,
      z.object({ player: z.string() }),
      `SELECT player, COUNT(*) AS n FROM v_game_players
       WHERE event_page = ? AND team = ? AND player <> ? AND stage <> 'qualifier'
       GROUP BY player ORDER BY n DESC, player LIMIT 2`,
      [latest.event, latest.team, input.player],
    )).map((r) => r.player);

    return {
      title: `${input.player} — ${[leagueLabel(league), titlePeriod(input)].filter(Boolean).join(" ")}`,
      rows,
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(rows.map((r) => r.event), 30),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: [
        `${input.player} ${inLeague(league)} ${bestRows[0]?.year ?? latest.year}`,
        ...teammates.map((m) => say(`Résultats de ${m} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`, `${m}'s results ${league === "Worlds" ? "at every Worlds" : inLeague(league)}`)),
      ],
      totals: { events, wins, losses, titles, best_place: bestRows[0]?.place ?? "" },
    };
  },
  normalize: async (db, input) => {
    const p = await resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

const scheduleScore = (s: string, team: string, whose: "own" | "other") => {
  const [mine, theirs] = whose === "own" ? ["team1_score", "team2_score"] : ["team2_score", "team1_score"];

  return `CASE WHEN ${s}.forfeited_by IS NOT NULL THEN 0 WHEN ${s}.team1 IN (${team}) THEN COALESCE(${s}.${mine}, 0) ELSE COALESCE(${s}.${theirs}, 0) END`;
};

const scheduleForfeit = (s: string) => `CASE WHEN ${s}.forfeited_by IS NOT NULL THEN 1 ELSE 0 END`;

function scheduleNotes(count: number, forfeits: number, tournaments: string[]): string[] {
  if (!count) return [];
  const unique = [...new Set(tournaments)];
  const where = unique.length ? ` (${unique.slice(0, 5).join(", ")}${unique.length > 5 ? ", …" : ""})` : "";

  const one = count === 1;

  return [
    say(
      `${one ? "1 série n'a que son" : `${count} séries n'ont que leur`} résultat, tiré du calendrier de Leaguepedia${where} : aucune stat de partie, seulement le score.` +
        (forfeits ? ` ${forfeits === 1 ? "Un forfait" : `${forfeits} forfaits`} : la série compte, sans partie jouée.` : ""),
      `${one ? "1 series has only its" : `${count} series have only their`} result, from Leaguepedia's match schedule${where}: no game statistic, just the score.` +
        (forfeits ? ` ${forfeits === 1 ? "One forfeit" : `${forfeits} forfeits`}: the series counts, with no game played.` : ""),
    ),
  ];
}

const teamHistory: ToolDef<TeamHistoryInput> = {
  name: "team_history",
  label: phrase("historique d'équipe", "team history"),
  description:
    "A team's history tournament by tournament (all competitions or one): final place and game record. Renamed teams are merged (SK Telecom T1 → T1).",
  plan: async (db, input) => {
    const { members } = await teamMembers(db, input.team);
    const params: Params = {};
    const t = inList("t", members, params);
    const league = (alias: string) => (input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "");
    const period = (alias: string) => periodFilter(`${alias}.year`, input, params);

    return {
      params,
      sql: tidy(`WITH team_games AS (
  SELECT g.year, g.league_short, g.event_page, g.stage, g.tournament, g.played_at,
         CASE WHEN g.blue_team IN (${t}) THEN g.blue_team ELSE g.red_team END AS team,
         CASE WHEN g.winner IN (${t}) THEN 1 ELSE 0 END AS win,
         CASE WHEN g.winner IN (${t}) THEN 0 ELSE 1 END AS loss,
         0 AS schedule, 0 AS forfeit
  FROM v_games g
  WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t}))
    AND g.stage IN (${COMPETITION_STAGES})
    ${league("g")}
    ${period("g")}
  UNION ALL
  SELECT sr.year, sr.league_short, sr.event_page, sr.stage, sr.tournament, sr.played_at,
         CASE WHEN sr.team1 IN (${t}) THEN sr.team1 ELSE sr.team2 END,
         ${scheduleScore("sr", t, "own")}, ${scheduleScore("sr", t, "other")}, 1, ${scheduleForfeit("sr")}
  FROM v_series_results sr
  WHERE (sr.team1 IN (${t}) OR sr.team2 IN (${t}))
    AND sr.stage IN (${COMPETITION_STAGES})
    ${league("sr")}
    ${period("sr")}
)
SELECT tg.year, ANY_VALUE(tg.league_short) AS league_short, tg.event_page, MIN(tg.stage) AS stage,
       COALESCE(ANY_VALUE(tr.tournament), MIN(tg.tournament)) AS tournament, tg.team,
       SUM(tg.win) AS wins, SUM(tg.loss) AS losses, SUM(tg.schedule) AS schedule_series, SUM(tg.forfeit) AS schedule_forfeits,
       ANY_VALUE(tr.place) AS place, ANY_VALUE(tr.place_number) AS place_number,
       MAX(CASE WHEN ${regularSeason("t")} THEN 1 ELSE 0 END) AS regular_season
FROM team_games tg
LEFT JOIN v_tournament_results tr ON tr.event_page = tg.event_page AND tr.team = tg.team
LEFT JOIN v_tournaments t ON t.tournament_page = tg.event_page
GROUP BY tg.year, tg.event_page, tg.team
ORDER BY tg.year NULLS FIRST, MIN(tg.played_at) NULLS FIRST, tg.event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toute son histoire", "its whole history")));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: say(`Aucune partie de ${input.team} dans cette compétition : affichage de toutes les compétitions.`, `No game of ${input.team} in this competition: showing all competitions.`),
        reason: say("filtre de compétition retiré", "competition filter removed"),
      });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const raw = z.array(TeamHistoryRow).parse(sqlRows);
    const { team, members } = await teamMembers(db, input.team);
    const league = await leagueShortName(db, input.league);
    const wins = raw.reduce((n, r) => n + Number(r.wins), 0);
    const losses = raw.reduce((n, r) => n + Number(r.losses), 0);
    const titles = raw.filter((r) => r.place === "1" && r.regular_season !== 1);
    const leagues = [...new Set(raw.map((r) => String(r.league_short)))];
    const names = [...new Set(raw.map((r) => String(r.team)))];
    const intl = titles.filter((r) => LEAGUES.some((l) => l.short === r.league_short && l.international));

    let facts =
      say(`${team} : ${raw.length} tournois ${inLeague(league) || `(${leagues.join(", ")})`} entre ${span(raw.map((r) => Number(r.year))).replace("–", " et ")}, `, `${team}: ${raw.length} tournaments ${inLeague(league) || `(${leagues.join(", ")})`} between ${span(raw.map((r) => Number(r.year))).replace("–", " and ")}, `) +
      say(`${wins} victoires et ${losses} défaites en parties (${pct(wins, wins + losses)} %). `, `${wins} wins and ${losses} losses in games (${pct(wins, wins + losses)}%). `) +
      say(`${titles.length} titre${titles.length > 1 ? "s" : ""}`, `${titles.length} title${titles.length === 1 ? "" : "s"}`);

    if (intl.length) facts += say(`, dont ${intl.map((r) => r.tournament ?? r.event_page).join(", ")}`, `, including ${intl.map((r) => r.tournament ?? r.event_page).join(", ")}`);
    facts += ".";

    if (names.length > 1) facts += say(` Noms pris en compte : ${names.map(displayTeam).join(", ")}.`, ` Names counted: ${names.map(displayTeam).join(", ")}.`);

    const scheduled = raw.filter((r) => r.schedule_series > 0);
    const scheduledCount = scheduled.reduce((n, r) => n + r.schedule_series, 0);

    const notes = scheduleNotes(
      scheduledCount,
      scheduled.reduce((n, r) => n + r.schedule_forfeits, 0),
      scheduled.map((r) => r.tournament ?? r.event_page),
    );

    return {
      title: `${team} — ${[league ?? say("historique", "history"), titlePeriod(input)].filter(Boolean).join(" ")}`,
      notes,
      table: {
        columns: [say("Année", "Year"), say("Compétition", "Competition"), say("Tournoi", "Tournament"), ...(names.length > 1 ? [say("Équipe", "Team")] : []), "Place", say("V-D", "W-L"), "%"],
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
        ...eventSources(lastPages([...titles.map((r) => String(r.event_page)), ...raw.slice(-8).map((r) => String(r.event_page))], scheduled.slice(-5).map((r) => r.event_page)), 25),
      ],
      followUps: [
        input.league ? say(`Historique de ${team}`, `${team} history`) : say(`${team} aux Worlds`, `${team} at Worlds`),
        say(`Palmarès ${league ?? "des Worlds"}`, `${league ?? "Worlds"} winners`),
      ],
      totals: { events: raw.length, wins, losses, titles: titles.length, schedule_series: scheduledCount },
    };
  },
  normalize: async (db, input) => {
    const t = await resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

const RosterEvent = z.object({ event: z.string(), tournament: z.string().nullable(), team: z.string(), games: z.number(), at: z.number().nullable() });

const RosterRow = z.object({
  player: Text,
  role: Text,
  games: z.number(),
  wins: z.number(),
  first_played: z.number().nullable(),
  last_played: z.number().nullable(),
  events: z.array(RosterEvent),
});

const RosterTournamentRow = z.object({ event_page: Text, tournament: NullableText, games: z.number(), wins: z.number(), at: z.number().nullable() });

const roleRank = (role: string) => {
  const i = ROLE_ORDER.indexOf(role);

  return i < 0 ? ROLE_ORDER.length : i;
};

function splitFilter(column: string, input: { split?: string | null }, params: Params): string {
  if (!input.split) return "";
  params.split = input.split;

  return `AND ${column} IN (SELECT split_scope.tournament_page FROM v_tournaments split_scope WHERE split_scope.split = :split)`;
}

function rankingScope(alias: string, input: { league: string | null; role?: string | null; side?: MapSide | null; split?: string | null } & Period, params: Params): string {
  return `${competitionScope(alias, input, params)} ${splitFilter(`${alias}.tournament_page`, input, params)}`.trimEnd();
}

const rankingScopeLabel = (league: string | null, input: Period & { split?: string | null }) =>
  [input.split ? say(`au split ${input.split}`, `in the ${input.split} split`) : "", scopeLabel(league, input)].filter(Boolean).join(" ");

const rankingTitleScope = (league: string | null, input: Period & { split?: string | null }, open: " — " | " (") => {
  const scope = titleScope(league, input, open);

  if (!input.split) return scope;

  return scope ? (open === " (" ? scope.replace(/\)$/, ` ${input.split})`) : `${scope} ${input.split}`) : `${open}${input.split}${open === " (" ? ")" : ""}`;
};

const rosterLeague = (column: string, input: TeamRosterInput, params: Params) =>
  input.league ? `AND ${leagueFilter(column, input, params)}` : `AND ${column} NOT IN (${inList("rosterExcluded", [...ROSTER_EXCLUDED], params)})`;

async function rosterScope(db: Db, input: TeamRosterInput, params: Params): Promise<string> {
  const t = inList("t", (await teamMembers(db, input.team)).members, params);
  const league = rosterLeague("gp.league", input, params);

  return `gp.team IN (${t}) AND gp.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("gp.year", input, params)} ${splitFilter("gp.tournament_page", input, params)}`;
}

async function rosterSeason(db: Db, input: TeamRosterInput): Promise<TeamRosterInput & { latest: boolean }> {
  if (input.yearFrom != null || input.yearTo != null) return { ...input, latest: false };
  const params: Params = {};
  const t = inList("t", (await teamMembers(db, input.team)).members, params);
  const league = rosterLeague("g.league", input, params);

  const year = (await selectOne(
    db,
    z.object({ year: z.number().nullable() }),
    `SELECT MAX(g.year) AS year FROM v_games g
     WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t})) AND g.stage IN (${COMPETITION_STAGES}) ${league} ${splitFilter("g.tournament_page", input, params)}`,
    params,
  ))?.year;

  return year == null ? { ...input, latest: false } : { ...input, yearFrom: year, yearTo: year, latest: true };
}

async function rosterTournaments(db: Db, input: TeamRosterInput) {
  const params: Params = {};
  const t = inList("t", (await teamMembers(db, input.team)).members, params);
  const league = rosterLeague("g.league", input, params);

  return await selectAll(
    db,
    RosterTournamentRow,
    `SELECT g.event_page, MIN(g.tournament) AS tournament, COUNT(*) AS games,
            SUM(CASE WHEN g.winner IN (${t}) THEN 1 ELSE 0 END) AS wins, MIN(g.played_at) AS at
     FROM v_games g
     WHERE (g.blue_team IN (${t}) OR g.red_team IN (${t})) AND g.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("g.year", input, params)}
       ${splitFilter("g.tournament_page", input, params)}
     GROUP BY g.event_page
     ORDER BY MIN(g.played_at) NULLS FIRST, g.event_page`,
    params,
  );
}

const teamRoster: ToolDef<TeamRosterInput> = {
  name: "team_roster",
  label: phrase("roster d'équipe", "team roster"),
  description:
    "A team's roster over a period or a competition: every player who played for it, by role (Top, Jungle, Mid, Bot, Support), " +
    "with their games and the tournaments they played. Renamed teams are merged (Samsung Ozone → Samsung White, SK Telecom T1 → T1).",
  plan: async (db, asked) => {
    const params: Params = {};
    const input = await rosterSeason(db, asked);

    return {
      params,
      sql: tidy(`WITH lines AS (
  SELECT gp.player, gp.role, gp.event_page, MIN(gp.tournament) AS tournament, MIN(gp.team) AS team,
         COUNT(*) AS games, SUM(gp.win) AS wins, MIN(gp.played_at) AS first_played, MAX(gp.played_at) AS last_played
  FROM v_game_players gp
  WHERE ${await rosterScope(db, input, params)}
  GROUP BY gp.player, gp.role, gp.event_page
)
SELECT player, role, SUM(games) AS games, SUM(wins) AS wins, MIN(first_played) AS first_played, MAX(last_played) AS last_played,
       COALESCE(json_agg(json_build_object('event', event_page, 'tournament', tournament, 'team', team, 'games', games, 'at', first_played) ORDER BY first_played NULLS FIRST), '[]'::json) AS events
FROM lines
GROUP BY player, role
ORDER BY role, SUM(games) DESC, player`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.split)
      out.push({ key: "split", input: { ...input, split: null }, note: say(`Aucune partie de ${input.team} au split ${input.split} : affichage de toute la saison.`, `No game of ${input.team} in the ${input.split} split: showing the whole season.`), reason: say("filtre de split retiré", "split filter removed") });

    if (hasPeriod(input)) out.push(noPeriod({ ...input, split: null }, say("tous les joueurs de son histoire", "every player in its history")));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null },
        note: say(`Aucune partie de ${input.team} dans cette compétition : affichage de toutes les compétitions.`, `No game of ${input.team} in this competition: showing all competitions.`),
        reason: say("filtre de compétition retiré", "competition filter removed"),
      });

    return out;
  },
  format: async (db, asked, sqlRows): Promise<ToolOutput> => {
    const input = await rosterSeason(db, asked);
    const raw = z.array(RosterRow).parse(sqlRows);
    const { team, members } = await teamMembers(db, input.team);
    const league = await leagueShortName(db, input.league);
    const scope = [input.split ? say(`au split ${input.split}`, `in the ${input.split} split`) : "", scopeLabel(league, input)].filter(Boolean).join(" ");
    const events = await rosterTournaments(db, input);
    const games = events.reduce((n, e) => n + e.games, 0);
    const wins = events.reduce((n, e) => n + e.wins, 0);
    const names = [...new Set(raw.flatMap((r) => r.events.map((e) => e.team)))].map(displayTeam);
    const label = (e: { event: string; tournament: string | null }) => e.tournament ?? e.event;

    const top = new Map<string, number>();

    for (const r of raw) top.set(r.role, Math.max(top.get(r.role) ?? 0, r.games));

    const photos = await Promise.all(raw.map((r) => playerPhoto(db, r.player, r.last_played)));

    const players = raw
      .map((r, i): RosterPlayer => ({
        player: r.player,
        role: r.role,
        games: r.games,
        wins: r.wins,
        starter: false,
        tournaments: r.events.map(label),
        firstPlayed: r.first_played,
        lastPlayed: r.last_played,
        photo: photos[i],
        source: { label: `Leaguepedia — ${r.player}`, url: wikiUrl(r.player) },
      }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role) || b.games - a.games || a.player.localeCompare(b.player));

    for (const p of players) p.starter = p.games === top.get(p.role);

    const starters = players.filter((p) => p.starter);
    const others = players.filter((p) => !p.starter);
    const roleName = (role: string) => ROLE_LABEL_BY_NAME.get(role) ?? role;
    const where = scope ? ` ${scope}` : "";
    const historyScope = scopeLabel(league, input);
    const historyWhere = historyScope ? ` ${historyScope}` : "";

    const inRole = input.role ? players.filter((p) => p.role === input.role) : [];

    const answer = input.role
      ? inRole.length
        ? say(`${roleName(input.role).replace(/^./, (c) => c.toUpperCase())} de ${team}${where} : ${inRole.map((p) => `${p.player} (${p.games} partie${p.games > 1 ? "s" : ""}${p.starter ? "" : ", remplaçant"})`).join(", ")}. `, `${roleName(input.role).replace(/^./, (c) => c.toUpperCase())} of ${team}${where}: ${inRole.map((p) => `${p.player} (${p.games} game${p.games === 1 ? "" : "s"}${p.starter ? "" : ", substitute"})`).join(", ")}. `)
        : say(`Aucun ${roleName(input.role)} de ${team} aligné${where}. `, `No ${roleName(input.role)} fielded by ${team}${where}. `)
      : "";

    let facts =
      answer +
      say(`${team}${where} : ${games} parties (${wins} victoires) sur ${events.length} tournoi${events.length > 1 ? "s" : ""}. `, `${team}${where}: ${games} games (${wins} wins) over ${events.length} tournament${events.length === 1 ? "" : "s"}. `) +
      say(`Joueurs avec le plus de parties à chaque poste : ${starters.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`, `Players with the most games in each role: ${starters.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`);

    if (others.length) facts += say(` Aussi alignés : ${others.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`, ` Also fielded: ${others.map((p) => `${p.player} (${roleName(p.role)}, ${p.games})`).join(", ")}.`);

    if (names.length > 1) facts += say(` Noms pris en compte : ${names.join(", ")}.`, ` Names counted: ${names.join(", ")}.`);

    return {
      title: `${team} — roster${where}`,
      period: { yearFrom: input.yearFrom, yearTo: input.yearTo },
      table: {
        columns: [say("Poste", "Role"), say("Joueur", "Player"), say("Statut", "Status"), say("Parties", "Games"), say("V-D", "W-L"), say("Tournois", "Tournaments")],
        rows: players.map((p) => [roleName(p.role), p.player, p.starter ? say("titulaire", "starter") : say("remplaçant", "substitute"), p.games, `${p.wins}-${p.games - p.wins}`, p.tournaments.join(", ")]),
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
        ...(input.latest ? [say(`Aucune période précisée : roster de la saison la plus récente de ${team} (${input.yearFrom}).`, `No period given: roster of ${team}'s most recent season (${input.yearFrom}).`)] : []),
        say("Seuls les joueurs alignés en match figurent ici : la base ne contient ni les coachs ni les remplaçants qui n'ont pas joué.", "Only players fielded in a game are listed here: the database holds neither coaches nor substitutes who did not play."),
      ],
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(events.map((e) => e.event_page), 12),
        ...starters.map((p) => p.source),
      ],
      followUps: [say(`Historique de ${team}${historyWhere}`, `${team} history${historyWhere}`), ...starters.slice(0, 2).map((p) => `${p.player}${historyWhere}`)].slice(0, 3),
      totals: { season: input.latest ? (input.yearFrom ?? nd()) : "asked", players: players.length, starters: starters.length, games, wins, events: events.length, ...Object.fromEntries(starters.toReversed().map((p) => [p.role.toLowerCase(), p.player])) },
    };
  },
  normalize: async (db, input) => {
    const t = await resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

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
  won_a: z.number().nullable(),
  schedule: z.number(),
  forfeited_by: NullableText,
});

const MAX_SERIES = 100;

async function teamSeries(db: Db, input: HeadToHeadInput) {
  const params: Params = {};
  const A = inList("a", (await teamMembers(db, input.sideA)).members, params);
  const B = inList("b", (await teamMembers(db, input.sideB)).members, params);
  const league = (alias: string) => (input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "");
  const winsA = `SUM(CASE WHEN g.winner IN (${A}) THEN 1 ELSE 0 END)`;
  const winsB = `SUM(CASE WHEN g.winner IN (${B}) THEN 1 ELSE 0 END)`;

  const rows = await selectAll(
    db,
    SeriesRow,
    `SELECT * FROM (
     SELECT g.tournament_page, g.tab, MIN(g.league_short) AS league_short, MIN(g.year) AS year, MIN(g.played_at) AS played_at,
            MIN(CASE WHEN g.blue_team IN (${A}) THEN g.blue_team ELSE g.red_team END) AS team_a,
            MIN(CASE WHEN g.blue_team IN (${A}) THEN g.red_team ELSE g.blue_team END) AS team_b,
            ${winsA} AS wins_a, ${winsB} AS wins_b,
            CASE WHEN ${winsA} > ${winsB} THEN 1 WHEN ${winsA} < ${winsB} THEN 0 END AS won_a,
            0 AS schedule, NULL::text AS forfeited_by
     FROM v_games g
     WHERE ((g.blue_team IN (${A}) AND g.red_team IN (${B})) OR (g.blue_team IN (${B}) AND g.red_team IN (${A})))
       AND g.stage IN (${COMPETITION_STAGES}) ${league("g")} ${periodFilter("g.year", input, params)}
     GROUP BY g.tournament_page, g.tab, g.match_n
     UNION ALL
     SELECT sr.tournament_page, sr.tab, sr.league_short, sr.year, sr.played_at,
            CASE WHEN sr.team1 IN (${A}) THEN sr.team1 ELSE sr.team2 END, CASE WHEN sr.team1 IN (${A}) THEN sr.team2 ELSE sr.team1 END,
            CASE WHEN sr.team1 IN (${A}) THEN COALESCE(sr.team1_score, 0) ELSE COALESCE(sr.team2_score, 0) END,
            CASE WHEN sr.team1 IN (${A}) THEN COALESCE(sr.team2_score, 0) ELSE COALESCE(sr.team1_score, 0) END,
            CASE WHEN sr.winner IN (${A}) THEN 1 ELSE 0 END, 1, sr.forfeited_by
     FROM v_series_results sr
     WHERE ((sr.team1 IN (${A}) AND sr.team2 IN (${B})) OR (sr.team1 IN (${B}) AND sr.team2 IN (${A})))
       AND sr.stage IN (${COMPETITION_STAGES}) ${league("sr")} ${periodFilter("sr.year", input, params)}
     ) series ORDER BY played_at DESC NULLS LAST`,
    params,
  );

  return {
    count: rows.length,
    seriesA: rows.filter((r) => r.won_a === 1).length,
    seriesB: rows.filter((r) => r.won_a === 0).length,
    scheduleOnly: rows.filter((r) => r.schedule === 1).length,
    series: rows.slice(0, MAX_SERIES).map((r): TeamSeries => ({
      playedAt: r.played_at,
      label: [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · "),
      teamA: displayTeam(r.team_a),
      teamB: displayTeam(r.team_b),
      winsA: r.wins_a,
      winsB: r.wins_b,
      winner: r.won_a == null ? null : displayTeam(r.won_a === 1 ? r.team_a : r.team_b),
      scheduleOnly: r.schedule === 1,
      forfeitedBy: r.forfeited_by ? displayTeam(r.forfeited_by) : null,
      source: { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) },
    })),
  };
}

const headToHead: ToolDef<HeadToHeadInput> = {
  name: "head_to_head",
  label: phrase("confrontations", "head-to-head"),
  description:
    "Games between two teams, tournament by tournament (wins of each side). For two players, use player_comparison.",
  plan: async (db, input) => {
    const params: Params = {};
    const A = inList("a", (await teamMembers(db, input.sideA)).members, params);
    const B = inList("b", (await teamMembers(db, input.sideB)).members, params);
    const league = (alias: string) => (input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "");

    return {
      params,
      sql: tidy(`WITH meetings AS (
  SELECT g.year, g.league_short, g.event_page, g.tournament, g.played_at,
         CASE WHEN g.winner IN (${A}) THEN 1 ELSE 0 END AS wins_a,
         CASE WHEN g.winner IN (${B}) THEN 1 ELSE 0 END AS wins_b,
         0 AS schedule, 0 AS forfeit
  FROM v_games g
  WHERE ((g.blue_team IN (${A}) AND g.red_team IN (${B})) OR (g.blue_team IN (${B}) AND g.red_team IN (${A})))
    AND g.stage IN (${COMPETITION_STAGES})
    ${league("g")}
    ${periodFilter("g.year", input, params)}
  UNION ALL
  SELECT sr.year, sr.league_short, sr.event_page, sr.tournament, sr.played_at,
         ${scheduleScore("sr", A, "own")}, ${scheduleScore("sr", A, "other")}, 1, ${scheduleForfeit("sr")}
  FROM v_series_results sr
  WHERE ((sr.team1 IN (${A}) AND sr.team2 IN (${B})) OR (sr.team1 IN (${B}) AND sr.team2 IN (${A})))
    AND sr.stage IN (${COMPETITION_STAGES})
    ${league("sr")}
    ${periodFilter("sr.year", input, params)}
)
SELECT year, ANY_VALUE(league_short) AS league_short, event_page, MIN(tournament) AS tournament, SUM(wins_a) AS wins_a, SUM(wins_b) AS wins_b,
       SUM(schedule) AS schedule_series, SUM(forfeit) AS schedule_forfeits
FROM meetings
GROUP BY year, event_page
ORDER BY year NULLS FIRST, MIN(played_at) NULLS FIRST, event_page`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les années", "every year")));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: say("Aucune confrontation dans cette compétition : affichage de toutes les compétitions.", "No meeting in this competition: showing all competitions."),
        reason: say("filtre de compétition retiré", "competition filter removed"),
      });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const raw = z.array(HeadToHeadRow).parse(sqlRows);
    const a = await teamMembers(db, input.sideA);
    const b = await teamMembers(db, input.sideB);
    const winsA = raw.reduce((n, r) => n + Number(r.wins_a), 0);
    const winsB = raw.reduce((n, r) => n + Number(r.wins_b), 0);
    const league = await leagueShortName(db, input.league);
    const last = raw[raw.length - 1];
    const leader = winsA === winsB ? say("à égalité", "tied") : say(`avantage ${winsA > winsB ? a.team : b.team}`, `${winsA > winsB ? a.team : b.team} ahead`);

    const series = await teamSeries(db, input);
    const latest = series.series[0];
    const seriesLeader = series.seriesA === series.seriesB ? say("à égalité", "tied") : say(`avantage ${series.seriesA > series.seriesB ? a.team : b.team}`, `${series.seriesA > series.seriesB ? a.team : b.team} ahead`);

    const facts =
      say(`${[`${a.team} – ${b.team}`, inLeague(league)].filter(Boolean).join(" ")} : `, `${[`${a.team} – ${b.team}`, inLeague(league)].filter(Boolean).join(" ")}: `) +
      say(`${series.count} séries (${span(raw.map((r) => Number(r.year)))}), ${series.seriesA} gagnées par ${a.team} et ${series.seriesB} par ${b.team} (${seriesLeader}) ; `, `${series.count} series (${span(raw.map((r) => Number(r.year)))}), ${series.seriesA} won by ${a.team} and ${series.seriesB} by ${b.team} (${seriesLeader}); `) +
      say(`${winsA} victoires à ${winsB} en parties sur ${raw.length} tournois, ${leader}. `, `${winsA} wins to ${winsB} in games over ${raw.length} tournaments, ${leader}. `) +
      (latest
        ? say(`Dernière rencontre : ${latest.label}${latest.playedAt ? ` (${dayFormat().format(new Date(latest.playedAt * 1000))})` : ""}, ${latest.forfeitedBy ? `victoire de ${latest.winner} par forfait` : `${latest.teamA} ${latest.winsA}-${latest.winsB} ${latest.teamB}`}.`, `Latest meeting: ${latest.label}${latest.playedAt ? ` (${dayFormat().format(new Date(latest.playedAt * 1000))})` : ""}, ${latest.forfeitedBy ? `${latest.winner} won by forfeit` : `${latest.teamA} ${latest.winsA}-${latest.winsB} ${latest.teamB}`}.`)
        : say(`Dernière confrontation : ${last.tournament ?? last.event_page} (${last.wins_a}-${last.wins_b}).`, `Latest head-to-head: ${last.tournament ?? last.event_page} (${last.wins_a}-${last.wins_b}).`));

    const scheduled = raw.filter((r) => r.schedule_series > 0);
    const notes = scheduleNotes(series.scheduleOnly, scheduled.reduce((n, r) => n + r.schedule_forfeits, 0), scheduled.map((r) => r.tournament ?? r.event_page));

    return {
      notes,
      title: `${a.team} vs ${b.team}${titleScope(league, input, " — ")}`,
      table: {
        columns: [say("Année", "Year"), say("Compétition", "Competition"), say("Tournoi", "Tournament"), a.team, b.team],
        rows: raw.map((r) => [r.year, r.league_short, r.tournament ?? r.event_page, r.wins_a, r.wins_b]),
      },
      facts,
      sources: [
        ...[...a.members, ...b.members].map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(lastPages(raw.map((r) => String(r.event_page)), scheduled.slice(-5).map((r) => r.event_page)), 15),
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
      followUps: [say(`Historique de ${a.team}`, `${a.team} history`), say(`Historique de ${b.team}`, `${b.team} history`)],
      totals: { wins_a: winsA, wins_b: winsB, events: raw.length, series: series.count, series_a: series.seriesA, series_b: series.seriesB, schedule_series: series.scheduleOnly },
    };
  },
  normalize: async (db, input) => {
    const a = await resolveTeam(db, input.sideA);
    const b = await resolveTeam(db, input.sideB);

    return a && b ? { ...input, sideA: a.team, sideB: b.team } : null;
  },
};

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
  focus_total: z.number().nullable(),
  focus_avg: z.number().nullable(),
  focus_games: z.number(),
  pages: pageList,
});

type ComparisonRow = z.infer<typeof ComparisonRow>;

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

type ComparisonFocus = { label: string; ingame: boolean; aggregate: "sum" | "avg"; stat: string; column: string; digits: number; signed: boolean };

const END_STAT_FOCUS: Record<ComparisonEndStat, { label: Phrase; digits: number }> = {
  kills: { label: phrase("kills", "kills"), digits: 2 },
  deaths: { label: phrase("morts", "deaths"), digits: 2 },
  assists: { label: phrase("assists", "assists"), digits: 2 },
  damage: { label: phrase("dégâts aux champions", "damage to champions"), digits: 0 },
  vision: { label: phrase("score de vision", "vision score"), digits: 1 },
};

function comparisonFocus(input: PlayerComparisonInput): ComparisonFocus | null {
  const end = COMPARISON_END_STATS.find((s) => s === input.metric);

  if (end) return { label: tr(END_STAT_FOCUS[end].label), ingame: false, aggregate: "avg", stat: end, column: `avg_${end}`, digits: END_STAT_FOCUS[end].digits, signed: false };
  const metric = PLAYER_METRICS.find((m) => m === input.metric);

  if (!metric) return null;
  const def = PLAYER_METRIC_DEFS[metric];
  const stat = metricColumn(def, input.minute);
  const sum = def.aggregate === "sum";

  return { label: metricLabel(def, input.minute), ingame: true, aggregate: sum ? "sum" : "avg", stat, column: sum ? metric : `avg_${stat}`, digits: /gold|xp/.test(stat) ? 0 : 1, signed: /_diff_/.test(stat) };
}

const focusValue = (r: ComparisonRow, f: ComparisonFocus) => (r.focus_games === 0 ? null : f.aggregate === "sum" ? r.focus_total : roundTo(r.focus_avg, f.digits));

function focusFacts(f: ComparisonFocus, pair: string, names: [string, string], faced: ComparisonRow[], rows: ComparisonRow[]): string {
  if (f.ingame && [...rows, ...faced].every((r) => r.focus_games === 0)) return say(`${pair}, ${f.label} : n/d, aucune partie avec données Riot dans ce périmètre. `, `${pair}, ${f.label}: n/a, no game with Riot data in this scope. `);

  const one = (name: string, r: ComparisonRow | undefined) => {
    if (!r) return say(`${name} n/d`, `${name} n/a`);

    if (r.focus_games === 0) return say(`${name} n/d (aucune partie avec données Riot)`, `${name} n/a (no game with Riot data)`);
    const v = frNumber(focusValue(r, f), f.signed);
    const shown = f.aggregate === "sum" ? v : say(`${v} ${f.ingame ? "en moyenne" : "par partie"}${f.ingame ? "" : ` (${frNumber(r.focus_total)} au total)`}`, `${v} ${f.ingame ? "on average" : "per game"}${f.ingame ? "" : ` (${frNumber(r.focus_total)} in total)`}`);

    return say(`${name} ${shown}${f.ingame && r.focus_games < r.games ? ` (sur ${r.focus_games} partie${r.focus_games > 1 ? "s" : ""} avec données Riot)` : ""}`, `${name} ${shown}${f.ingame && r.focus_games < r.games ? ` (over ${r.focus_games} game${r.focus_games === 1 ? "" : "s"} with Riot data)` : ""}`);
  };

  const both = (list: ComparisonRow[]) => names.map((n) => one(n, list.find((r) => r.player === n))).join(", ");

  return say(`${pair}, ${f.label} : ${faced.length ? `face à face, ${both(faced)} ; ` : ""}sur toutes leurs parties, ${both(rows)}. `, `${pair}, ${f.label}: ${faced.length ? `head to head, ${both(faced)}; ` : ""}over all their games, ${both(rows)}. `);
}

const MAX_VERSUS_GAMES = 200;

const fr1 = (n: number) => numberFormat(answerLocale(), 1).format(Math.round(n * 10) / 10);

const FACED = `EXISTS (SELECT 1 FROM v_game_players o
    WHERE o.game_id = p.game_id AND o.team <> p.team AND o.player = CASE p.player WHEN :a THEN :b ELSE :a END)`;

function comparisonSql(input: PlayerComparisonInput, params: Params, faced: boolean): string {
  const focus = comparisonFocus(input);
  const focusSql = focus == null ? "NULL::integer" : focus.ingame ? "st.focus" : `p.${focus.stat}`;

  return tidy(`WITH st AS (
  SELECT game_id, player, gold_diff_15, cs_diff_15, solo_kills${focus?.ingame ? `, ${focus.stat} AS focus` : ""} FROM v_game_player_stats WHERE player IN (:a, :b)
), g AS (
  SELECT p.player, p.event_page, p.win, p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision,
         st.gold_diff_15, st.cs_diff_15, st.solo_kills, (st.game_id IS NOT NULL)::integer AS ingame, ${focusSql} AS focus
  FROM v_game_players p
  LEFT JOIN st ON st.game_id = p.game_id AND st.player = p.player
  WHERE p.player IN (:a, :b) AND ${competitionScope("p", input, params)}${faced ? `\n    AND ${FACED}` : ""}
)
SELECT player, COUNT(*) AS games, SUM(win) AS wins,
       ROUND(AVG(kills), 2) AS avg_kills, ROUND(AVG(deaths), 2) AS avg_deaths, ROUND(AVG(assists), 2) AS avg_assists,
       ROUND(AVG(gold), 0) AS avg_gold, ROUND(AVG(cs), 1) AS avg_cs, ROUND(AVG(damage), 0) AS avg_damage, ROUND(AVG(vision), 1) AS avg_vision,
       ROUND(AVG(gold_diff_15), 0) AS avg_gold_diff_15, ROUND(AVG(cs_diff_15), 1) AS avg_cs_diff_15,
       ROUND(AVG(solo_kills), 2) AS avg_solo_kills, SUM(solo_kills) AS solo_kills,
       SUM(ingame) AS ingame_games, SUM(focus) AS focus_total, ROUND(AVG(focus), 2) AS focus_avg, COUNT(focus) AS focus_games,
       COALESCE(json_agg(DISTINCT event_page), '[]'::json) AS pages
FROM g GROUP BY player
ORDER BY player = :a DESC`);
}

function comparisonTable(rows: ComparisonRow[], focus: ComparisonFocus | null) {
  const lead = focus ? [focus.column, ...(focus.ingame ? ["ingame_games"] : [])] : [];
  const [head, rest] = [COMPARISON_COLUMNS.slice(0, 3), COMPARISON_COLUMNS.slice(3).filter((c) => !lead.includes(c))];

  const cell = (r: ComparisonRow, c: string) => {
    if (focus && c === focus.column) return focusValue(r, focus);

    if (c === "ingame_games") return r.focus_games;
    const known = COMPARISON_COLUMNS.find((k) => k === c);

    return known == null ? null : known === "player" ? r.player : r[known];
  };

  const columns = [...head, ...lead, ...rest];

  return { columns, rows: rows.map((r) => columns.map((c) => cell(r, c))) };
}

export function scopeLabel(league: string | null, input: Period): string {
  const { yearFrom: from, yearTo: to } = input;

  const period =
    from != null && from === to
      ? say(`en ${from}`, `in ${from}`)
      : from != null && to != null
        ? say(`entre ${from} et ${to}`, `between ${from} and ${to}`)
        : from != null
          ? say(`depuis ${from}`, `since ${from}`)
          : to != null
            ? say(`jusqu'en ${to}`, `until ${to}`)
            : "";

  return [inLeague(league), period].filter(Boolean).join(" ");
}

const pairGames = (scope: string) => `WITH p AS MATERIALIZED (SELECT * FROM v_game_players p WHERE p.player = :a AND ${scope}),
     o AS MATERIALIZED (SELECT * FROM v_game_players WHERE player = :b)`;

async function versusGames(db: Db, input: PlayerComparisonInput): Promise<VersusGame[]> {
  const params: Params = {};

  Object.assign(params, { a: input.playerA, b: input.playerB });

  const rows = await selectAll(
    db,
    VersusGameRow,
    `${pairGames(competitionScope("p", input, params))}
     SELECT g.played_at, g.league_short, g.year, g.tab, g.game_n, g.tournament_page, r.stats_page,
            p.team AS team_a, o.team AS team_b, p.role AS role_a, o.role AS role_b, p.win AS win_a,
            p.champion AS champion_a, ca.icon_url AS icon_a, p.kills AS kills_a, p.deaths AS deaths_a, p.assists AS assists_a,
            o.champion AS champion_b, cb.icon_url AS icon_b, o.kills AS kills_b, o.deaths AS deaths_b, o.assists AS assists_b
     FROM p JOIN o ON o.game_id = p.game_id AND o.team <> p.team
     JOIN v_games g ON g.game_id = p.game_id
     LEFT JOIN game_riot r ON r.game_id = p.game_id
     LEFT JOIN champions ca ON ca.name = p.champion
     LEFT JOIN champions cb ON cb.name = o.champion
     ORDER BY g.played_at DESC NULLS LAST
     LIMIT ${MAX_VERSUS_GAMES}`,
    params,
  );

  return rows.map((r) => {
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

async function sameLane(db: Db, input: PlayerComparisonInput): Promise<VersusView["lanes"]> {
  const params: Params = {};

  Object.assign(params, { a: input.playerA, b: input.playerB });

  const roles = await selectAll(
    db,
    z.object({ role: Text, games: z.number() }),
    `${pairGames(competitionScope("p", input, params))}
     SELECT p.role, COUNT(*) AS games FROM p JOIN o ON o.game_id = p.game_id AND o.team <> p.team AND o.role = p.role
     WHERE p.role IS NOT NULL
     GROUP BY p.role ORDER BY games DESC, p.role`,
    params,
  );

  return { same: roles.reduce((n, r) => n + r.games, 0), roles };
}

function laneFacts(lanes: VersusView["lanes"], met: number, profiles: [string | null, string | null], names: [string, string]): string {
  if (!met) return "";

  if (lanes.same === met) return say(` Toutes ces parties se sont jouées dans la même lane (${lanes.roles.map((r) => r.role).join(", ")}).`, ` All those games were played in the same lane (${lanes.roles.map((r) => r.role).join(", ")}).`);

  if (lanes.same) return say(` Dont ${lanes.same} dans la même lane (${lanes.roles.map((r) => `${r.role} ${r.games}`).join(", ")}).`, ` Of which ${lanes.same} in the same lane (${lanes.roles.map((r) => `${r.role} ${r.games}`).join(", ")}).`);

  const [ra, rb] = profiles;

  return say(` Jamais dans la même lane${ra && rb && ra !== rb ? ` (${names[0]} joue ${ra}, ${names[1]} ${rb})` : ""}.`, ` Never in the same lane${ra && rb && ra !== rb ? ` (${names[0]} plays ${ra}, ${names[1]} ${rb})` : ""}.`);
}

const playerComparison: ToolDef<PlayerComparisonInput> = {
  name: "player_comparison",
  label: phrase("comparaison de deux joueurs", "comparison of two players"),
  description:
    "Sets two players against each other in a competition and period: their statistics in the games they played against each other " +
    "(record, average kills/deaths/assists, gold, CS, damage, vision, gold and CS difference at 15 min, solo kills), the list of those games, " +
    "and their statistics over every game of the scope. When the question names a statistic (pentakills, solo kills, first bloods, deaths, " +
    "gold difference at 10 min...), set metric: it is shown first. Use it for any question opposing two players: 'compare X and Y', 'X vs Y', " +
    "'X contre Y', 'X or Y who is better', 'head to head', 'h2h', 'confrontations'.",
  plan: async (_db, input) => {
    const params: Params = {};

    Object.assign(params, { a: input.playerA, b: input.playerB });

    return { params, sql: comparisonSql(input, params, false) };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null, yearFrom: null, yearTo: null },
        note: say("Aucune partie des deux joueurs dans cette compétition : comparaison sur toutes les compétitions.", "No game of the two players in this competition: comparison over all competitions."),
        reason: say("filtre de compétition retiré", "competition filter removed"),
      });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(ComparisonRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const params: Params = {};

    Object.assign(params, { a: input.playerA, b: input.playerB });

    const faced = await selectAll(db, ComparisonRow, comparisonSql(input, params, true), params);
    const games = faced.length ? await versusGames(db, input) : [];
    const met = faced.find((r) => r.player === input.playerA)?.games ?? 0;
    const winsA = faced.find((r) => r.player === input.playerA)?.wins ?? 0;
    const lanes = met ? await sameLane(db, input) : { same: 0, roles: [] };
    const mainRole = (player: string) => games.find((g) => g.a.role)?.[player === input.playerA ? "a" : "b"].role ?? null;

    const line = (r: ComparisonRow) => {
      const kda = r.avg_kills != null && r.avg_deaths && r.avg_assists != null ? `, KDA ${fr1((r.avg_kills + r.avg_assists) / r.avg_deaths)}` : "";

      const solo = r.solo_kills == null ? "" : say(`, ${r.solo_kills} solo kill${r.solo_kills > 1 ? "s" : ""}`, `, ${r.solo_kills} solo kill${r.solo_kills === 1 ? "" : "s"}`);

      return say(`${r.player} ${r.games} parties, ${r.wins} victoires (${pct(r.wins, r.games)} %)${kda}${solo}`, `${r.player} ${r.games} games, ${r.wins} wins (${pct(r.wins, r.games)}%)${kda}${solo}`);
    };

    const missing = [input.playerA, input.playerB].filter((p) => !rows.some((r) => r.player === p));
    const pair = say(`${input.playerA} et ${input.playerB}${scope ? ` ${scope}` : ""}`, `${input.playerA} and ${input.playerB}${scope ? ` ${scope}` : ""}`);
    const focus = comparisonFocus(input);

    const valueOf = (list: ComparisonRow[], player: string) => {
      const r = list.find((x) => x.player === player);

      return (focus && r && focusValue(r, focus)) ?? nd();
    };

    const facts =
      (focus ? focusFacts(focus, pair, [input.playerA, input.playerB], met ? faced : [], rows) : "") +
      (met
        ? say(`${pair} se sont affrontés sur ${met} parties : ${input.playerA} ${winsA} – ${met - winsA} ${input.playerB} ; face à face, ${faced.map(line).join(" ; ")}. `, `${pair} faced each other in ${met} games: ${input.playerA} ${winsA} – ${met - winsA} ${input.playerB}; head to head, ${faced.map(line).join("; ")}. `) +
          say(`Sur toutes leurs parties : ${rows.map(line).join(" ; ")}.`, `Over all their games: ${rows.map(line).join("; ")}.`) +
          laneFacts(lanes, met, [mainRole(input.playerA), mainRole(input.playerB)], [input.playerA, input.playerB])
        : say(`${pair} ne se sont jamais affrontés. Sur toutes leurs parties : ${rows.map(line).join(" ; ")}.`, `${pair} have never faced each other. Over all their games: ${rows.map(line).join("; ")}.`)) +
      (missing.length ? say(` Aucune partie de ${missing.join(" ni de ")} dans ce périmètre.`, ` No game of ${missing.join(" or ")} in this scope.`) : "") +
      ([...rows, ...faced].every((r) => r.ingame_games === 0)
        ? say(" Écarts à 15 min et solo kills : n/d, aucune partie avec données Riot dans ce périmètre.", " Differences at 15 min and solo kills: n/a, no game with Riot data in this scope.")
        : [...rows, ...faced].some((r) => r.ingame_games < r.games) ? say(" Écarts à 15 min et solo kills calculés sur les parties avec données Riot seulement.", " Differences at 15 min and solo kills computed over the games with Riot data only.") : "");

    return {
      title: `${input.playerA} vs ${input.playerB}${titleScope(league, input, " — ")}`,
      table: comparisonTable(rows, focus),
      versus: {
        playerA: input.playerA,
        playerB: input.playerB,
        scope,
        focus: focus?.column ?? null,
        global: comparisonTable(rows, focus),
        h2h: met ? comparisonTable(faced, focus) : null,
        lanes,
        games,
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.playerA}`, url: wikiUrl(input.playerA) },
        { label: `Leaguepedia — ${input.playerB}`, url: wikiUrl(input.playerB) },
        ...eventSources(rows.flatMap((r) => r.pages), 10),
      ],
      followUps: [say(`Résultats de ${input.playerA}${scope ? ` ${scope}` : " à tous les Worlds"}`, `${input.playerA}'s results${scope ? ` ${scope}` : " at every Worlds"}`), say(`Résultats de ${input.playerB}${scope ? ` ${scope}` : " à tous les Worlds"}`, `${input.playerB}'s results${scope ? ` ${scope}` : " at every Worlds"}`)],
      totals: {
        games_a: rows.find((r) => r.player === input.playerA)?.games ?? 0,
        games_b: rows.find((r) => r.player === input.playerB)?.games ?? 0,
        wins_a: rows.find((r) => r.player === input.playerA)?.wins ?? 0,
        wins_b: rows.find((r) => r.player === input.playerB)?.wins ?? 0,
        h2h_games: met,
        h2h_wins_a: winsA,
        h2h_listed: games.length,
        h2h_same_lane: lanes.same,
        solo_kills_a: (met ? faced : rows).find((r) => r.player === input.playerA)?.solo_kills ?? nd(),
        solo_kills_b: (met ? faced : rows).find((r) => r.player === input.playerB)?.solo_kills ?? nd(),
        ...(focus && {
          metric_a: valueOf(rows, input.playerA),
          metric_b: valueOf(rows, input.playerB),
          h2h_metric_a: valueOf(faced, input.playerA),
          h2h_metric_b: valueOf(faced, input.playerB),
        }),
      },
    };
  },
  normalize: async (db, input) => {
    const scope = { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo };
    const a = await resolvePlayer(db, input.playerA, scope);
    const b = await resolvePlayer(db, input.playerB, scope);

    return a && b && a.player !== b.player ? { ...input, playerA: a.player, playerB: b.player } : null;
  },
};

const kdaOf = (ka: number | null, deaths: number | null) => (ka == null || deaths == null ? null : Math.round((100 * ka) / Math.max(1, deaths)) / 100);

const kaSum = (alias: string) => `SUM(CASE WHEN ${alias}.deaths IS NOT NULL THEN ${alias}.kills + ${alias}.assists END)`;
const deathsSum = (alias: string) => `SUM(CASE WHEN ${alias}.kills IS NOT NULL AND ${alias}.assists IS NOT NULL THEN ${alias}.deaths END)`;

export const ROLE_LABEL: Record<(typeof ROLES)[number], string> = { Top: "top", Jungle: "jungle", Mid: "mid", Bot: "ADC", Support: "support" };

const ROLE_LABEL_BY_NAME = new Map<string, string>(Object.entries(ROLE_LABEL));

const ROLE_PLAYERS: Record<(typeof ROLES)[number], Phrase> = {
  Top: phrase("toplaners", "top laners"),
  Jungle: phrase("junglers", "junglers"),
  Mid: phrase("mids", "mids"),
  Bot: phrase("ADC", "ADCs"),
  Support: phrase("supports", "supports"),
};

const unitEn = (unit: string | undefined) => (unit === " %" ? "%" : (unit ?? ""));

function championScope(input: ChampionStatsInput, params: Params): string {
  params.champion = input.champion;

  return `gp.champion = :champion AND ${leagueFilter("gp.league", input, params)} AND gp.stage IN (${COMPETITION_STAGES}) ${periodFilter("gp.year", input, params)}`;
}

const CHAMPION_AVERAGES = [
  { key: "kills", label: phrase("kills", "kills"), digits: 1 },
  { key: "deaths", label: phrase("morts", "deaths"), digits: 1 },
  { key: "assists", label: phrase("assists", "assists"), digits: 1 },
  { key: "gold", label: phrase("or", "gold"), digits: 0 },
  { key: "cs", label: phrase("CS", "CS"), digits: 1 },
  { key: "damage", label: phrase("dégâts", "damage"), digits: 0 },
  { key: "vision", label: phrase("score de vision", "vision score"), digits: 1 },
] as const;

const CHAMPION_INGAME = [
  { key: "gold_diff_15", label: phrase("écart d'or @15", "gold diff @15"), digits: 0 },
  { key: "cs_diff_15", label: phrase("écart CS @15", "CS diff @15"), digits: 1 },
] as const;

const Averages = z.record(z.string(), z.number().nullable());

const ChampionPlayerRow = z.object({ player: Text, team: NullableText, games: z.number(), wins: z.number(), ka: z.number().nullable(), deaths: z.number().nullable() });

const roundTo = (n: number | null, digits: number) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

export const frNumber = (n: number | null, signedValue = false) =>
  n == null ? nd() : `${signedValue && n > 0 ? "+" : n < 0 ? "−" : ""}${numberFormat(answerLocale(), 2).format(Math.abs(n)).replace(/[\u202f\u00a0]/g, " ")}`;

const nd = () => NO_DATA[answerLocale()];

const BOT_BOOTS_SLOT_YEAR = 2026;

const itemsSource = (): Source => ({
  label: say("Leaguepedia — inventaires de fin de partie (ScoreboardPlayers)", "Leaguepedia — end-of-game inventories (ScoreboardPlayers)"),
  url: wikiUrl("Special:CargoTables/ScoreboardPlayers"),
});

const ChampionItemRow = z.object({ item: Text, icon: Text, kind: z.enum(ITEM_KINDS).nullable(), games: z.number(), wins: z.number() });

async function championItems(db: Db, input: ChampionStatsInput, picks: number): Promise<ChampionItems> {
  const params: Params = {};
  const where = championScope(input, params);
  const owned = "pi.game_id = gp.game_id AND pi.player = gp.player";

  const items = await selectAll(
    db,
    ChampionItemRow,
    `SELECT pi.item, ANY_VALUE(pi.icon_url) AS icon, ANY_VALUE(pi.kind) AS kind, COUNT(DISTINCT gp.game_id) AS games, COUNT(DISTINCT CASE WHEN gp.win = 1 THEN gp.game_id END) AS wins
     FROM v_game_players gp CROSS JOIN LATERAL (SELECT * FROM v_player_items pi WHERE ${owned} OFFSET 0) pi
     WHERE ${where}
     GROUP BY pi.item ORDER BY games DESC, pi.item`,
    params,
  );

  const counts = await selectOne(
    db,
    z.object({ games: z.number(), bot_slot: z.number() }),
    `SELECT COUNT(CASE WHEN EXISTS (SELECT 1 FROM v_player_items pi WHERE ${owned}) THEN 1 END) AS games,
            COUNT(CASE WHEN gp.role = 'Bot' AND gp.year >= ${BOT_BOOTS_SLOT_YEAR} THEN 1 END) AS bot_slot
     FROM v_game_players gp WHERE ${where}`,
    params,
  ) ?? { games: 0, bot_slot: 0 };

  const notes: string[] = [];

  if (picks && !counts.games) notes.push(say("Leaguepedia ne liste aucun inventaire de fin de partie pour ces parties.", "Leaguepedia lists no end-of-game inventory for these games."));
  else if (counts.games < picks) notes.push(say(`Inventaire connu pour ${counts.games} parties sur ${picks}.`, `Inventory known for ${counts.games} games out of ${picks}.`));

  if (counts.bot_slot) notes.push(say(`Depuis ${BOT_BOOTS_SLOT_YEAR}, les bottes des ADC (emplacement de quête de rôle) ne figurent pas dans l'inventaire listé par Leaguepedia.`, `Since ${BOT_BOOTS_SLOT_YEAR}, ADC boots (role quest slot) are not in the inventory Leaguepedia lists.`));

  return { games: counts.games, items, notes };
}

function itemsFacts(p: ChampionProfile): string {
  const complete = p.items.items.filter((i) => i.kind === "complete").slice(0, 3);

  if (!complete.length) return p.items.notes.length ? say(` Items : ${p.items.notes.join(" ")}`, ` Items: ${p.items.notes.join(" ")}`) : "";

  return (
    say(` Items complets les plus fréquents en fin de partie : ${complete.map((i) => `${i.item} (${i.games}/${p.items.games} parties, ${pct(i.games, p.items.games)} %)`).join(", ")}.`, ` Most frequent completed items at the end of the game: ${complete.map((i) => `${i.item} (${i.games}/${p.items.games} games, ${pct(i.games, p.items.games)}%)`).join(", ")}.`) +
    (p.items.notes.length ? ` ${p.items.notes.join(" ")}` : "")
  );
}

const setupsSource = (): Source => ({
  label: say("Leaguepedia — sorts d'invocateur et runes (ScoreboardPlayers)", "Leaguepedia — summoner spells and runes (ScoreboardPlayers)"),
  url: wikiUrl("Special:CargoTables/ScoreboardPlayers"),
});

const ChampionSpellsRow = z.object({ spell1: Text, spell2: NullableText, icon1: NullableText, icon2: NullableText, games: z.number(), wins: z.number() });

const ChampionRuneRow = z.object({ rune: Text, kind: z.enum(RUNE_KINDS), tree: NullableText, icon: NullableText, games: z.number(), wins: z.number() });

type ScopeRunes = Pick<ChampionSetups, "keystoneGames" | "pageGames" | "runes" | "notes">;

async function scopeRunes(db: Db, scope: (params: Params) => string | Promise<string>, picks: number): Promise<ScopeRunes> {
  const params: Params = {};
  const where = await scope(params);

  const runes = await selectAll(
    db,
    ChampionRuneRow,
    `SELECT r.rune, r.kind, ANY_VALUE(r.tree) AS tree, ANY_VALUE(r.icon_url) AS icon, COUNT(DISTINCT gp.game_id) AS games, COUNT(DISTINCT CASE WHEN gp.win = 1 THEN gp.game_id END) AS wins
     FROM v_game_players gp CROSS JOIN LATERAL (SELECT * FROM v_player_runes r WHERE r.game_id = gp.game_id AND r.player = gp.player OFFSET 0) r
     WHERE ${where}
     GROUP BY r.kind, r.rune ORDER BY games DESC, MIN(r.slot), r.rune`,
    params,
  );

  const counts = await selectOne(
    db,
    z.object({ keystones: z.number(), pages: z.number() }),
    `SELECT COUNT(gp.keystone) AS keystones,
            COUNT(CASE WHEN EXISTS (SELECT 1 FROM v_player_runes r WHERE r.game_id = gp.game_id AND r.player = gp.player AND r.slot = 2) THEN 1 END) AS pages
     FROM v_game_players gp WHERE ${where}`,
    params,
  ) ?? { keystones: 0, pages: 0 };

  const notes: string[] = [];

  if (picks && !counts.keystones) notes.push(say("Leaguepedia ne liste aucune rune pour ces parties (aucune avant la saison 2018).", "Leaguepedia lists no rune for these games (none before the 2018 season)."));
  else if (counts.keystones < picks) notes.push(say(`Keystone connue pour ${counts.keystones} parties sur ${picks} (aucune avant la saison 2018).`, `Keystone known for ${counts.keystones} games out of ${picks} (none before the 2018 season).`));

  if (counts.keystones && counts.pages < counts.keystones)
    notes.push(
      counts.pages
        ? say(`Page de runes complète pour ${counts.pages} parties sur ${picks} (keystone seule en 2018, 2019 et sur une partie de 2020).`, `Full rune page for ${counts.pages} games out of ${picks} (keystone only in 2018, 2019 and part of 2020).`)
        : say("Seule la keystone est listée pour ces parties (page de runes complète listée à partir de 2020).", "Only the keystone is listed for these games (full rune page listed from 2020)."),
    );

  return { keystoneGames: counts.keystones, pageGames: counts.pages, runes: runes.map((r) => ({ ...r, icon: runeIcon(r.rune, r.icon) })), notes };
}

async function championSetups(db: Db, input: ChampionStatsInput, picks: number): Promise<ChampionSetups> {
  const params: Params = {};
  const where = championScope(input, params);

  const spells = await selectAll(
    db,
    ChampionSpellsRow,
    `SELECT gp.spell1, gp.spell2, ANY_VALUE(s1.icon_url) AS icon1, ANY_VALUE(s2.icon_url) AS icon2, COUNT(*) AS games, COALESCE(SUM(gp.win), 0) AS wins
     FROM v_game_players gp LEFT JOIN summoner_spells s1 ON s1.name = gp.spell1 LEFT JOIN summoner_spells s2 ON s2.name = gp.spell2
     WHERE ${where} AND gp.spell1 IS NOT NULL
     GROUP BY gp.spell1, gp.spell2 ORDER BY games DESC, gp.spell1, gp.spell2`,
    params,
  );

  return {
    spellGames: spells.reduce((n, s) => n + s.games, 0),
    spells: spells.map((s) => ({
      spells: [{ name: s.spell1, iconUrl: s.icon1 }, ...(s.spell2 ? [{ name: s.spell2, iconUrl: s.icon2 }] : [])],
      games: s.games,
      wins: s.wins,
    })),
    ...(await scopeRunes(db, (p) => championScope(input, p), picks)),
  };
}

function setupsFacts(p: ChampionProfile): string {
  const s = p.setups;
  const line = (name: string, games: number, of: number) => say(`${name} (${games}/${of} parties, ${pct(games, of)} %)`, `${name} (${games}/${of} games, ${pct(games, of)}%)`);
  const keystones = s.runes.filter((r) => r.kind === "keystone").slice(0, 3);

  return (
    (s.spells.length ? say(` Sorts d'invocateur les plus fréquents : ${s.spells.slice(0, 3).map((x) => line(x.spells.map((sp) => sp.name).join(" + "), x.games, s.spellGames)).join(", ")}.`, ` Most frequent summoner spells: ${s.spells.slice(0, 3).map((x) => line(x.spells.map((sp) => sp.name).join(" + "), x.games, s.spellGames)).join(", ")}.`) : "") +
    (keystones.length ? say(` Keystones les plus fréquentes : ${keystones.map((r) => line(r.rune, r.games, s.keystoneGames)).join(", ")}.`, ` Most frequent keystones: ${keystones.map((r) => line(r.rune, r.games, s.keystoneGames)).join(", ")}.`) : "") +
    (s.notes.length ? say(` Runes : ${s.notes.join(" ")}`, ` Runes: ${s.notes.join(" ")}`) : "")
  );
}

async function championProfile(db: Db, input: ChampionStatsInput, scope: string, games: number, bans: number, icon: string | null): Promise<ChampionProfile> {
  const params: Params = {};
  const where = championScope(input, params);
  const ends = CHAMPION_AVERAGES.map((a) => `AVG(gp.${a.key}) AS ${a.key}, COUNT(gp.${a.key}) AS n_${a.key}`).join(", ");

  const totals = await selectOne(
    db,
    Averages,
    `SELECT COUNT(*) AS picks, COALESCE(SUM(gp.win), 0) AS wins,
            ${kaSum("gp")} AS ka,
            ${deathsSum("gp")} AS kda_deaths, ${ends}
     FROM v_game_players gp WHERE ${where}`,
    params,
  ) ?? {};

  const ingameParams: Params = {};

  const ingame = await selectOne(
    db,
    Averages,
    `SELECT ${CHAMPION_INGAME.map((a) => `AVG(gp.${a.key}) AS ${a.key}, COUNT(gp.${a.key}) AS n_${a.key}`).join(", ")}
     FROM v_game_player_stats gp WHERE ${championScope(input, ingameParams)}`,
    ingameParams,
  ) ?? {};

  const players = await selectAll(
    db,
    ChampionPlayerRow,
    `SELECT gp.player, ${latest("gp.team", "gp.played_at")} AS team, MAX(gp.played_at) AS last_game, COUNT(*) AS games, SUM(gp.win) AS wins,
            ${kaSum("gp")} AS ka,
            ${deathsSum("gp")} AS deaths
     FROM v_game_players gp WHERE ${where}
     GROUP BY gp.player ORDER BY games DESC, wins DESC, gp.player LIMIT 5`,
    params,
  );

  const roles = await selectAll(
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
      ...CHAMPION_AVERAGES.map((a) => ({ key: a.key, label: tr(a.label), value: roundTo(totals[a.key] ?? null, a.digits), counted: totals[`n_${a.key}`] ?? 0 })),
      ...CHAMPION_INGAME.map((a) => ({ key: a.key, label: tr(a.label), value: roundTo(ingame[a.key] ?? null, a.digits), signed: true, counted: ingame[`n_${a.key}`] ?? 0 })),
    ],
    players: players.map((p) => ({ player: p.player, team: p.team && displayTeam(p.team), games: p.games, wins: p.wins, kda: kdaOf(p.ka, p.deaths) })),
    roles,
    focus: input.focus,
    items: await championItems(db, input, picks),
    setups: await championSetups(db, input, picks),
  };
}

function averagesFacts(p: ChampionProfile): string {
  const shown = p.averages.map((a) => `${a.label} ${frNumber(a.value, a.signed)}`).join(", ");
  const partial = p.averages.filter((a) => a.counted > 0 && a.counted < p.picks);
  const ingame = p.averages.find((a) => a.key === "gold_diff_15");

  return (
    say(`Moyennes par partie : ${shown}.`, `Averages per game: ${shown}.`) +
    (partial.length ? say(` Calculés sur une partie des parties seulement (les autres n'ont pas la donnée) : ${partial.map((a) => `${a.label} sur ${a.counted}`).join(", ")}.`, ` Computed over part of the games only (the others lack the data): ${partial.map((a) => `${a.label} over ${a.counted}`).join(", ")}.`) : "") +
    (ingame && ingame.counted === 0 ? say(" Écarts à 15 min n/d : aucune partie avec données Riot dans ce périmètre.", " Differences at 15 min n/a: no game with Riot data in this scope.") : "")
  );
}

const championEventStats: ToolDef<ChampionStatsInput> = {
  name: "champion_event_stats",
  label: phrase("stats d'un champion × compétition", "champion stats × competition"),
  description:
    "One champion in one competition and period: picks, bans, presence, win rate, KDA, average kills/deaths/assists, gold, CS, damage, vision " +
    "and gold/CS difference at 15 min, the players who played it most (games, win rate, KDA), the roles it was played in, its most built items, " +
    "its summoner spells and runes (keystones, primary and secondary runes, shards), and its editions one by one.",
  plan: async (_db, input) => {
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
SELECT ev.year, ANY_VALUE(ev.league_short) AS league_short, ev.event_page, MIN(ev.tournament) AS tournament,
       COUNT(*) AS games, COUNT(p.game_id) AS picks, COALESCE(SUM(p.win), 0) AS wins, COUNT(b.game_id) AS bans,
       (SELECT COUNT(*) FROM ev) AS scope_games, (SELECT MIN(year) FROM ev) AS scope_from, (SELECT MAX(year) FROM ev) AS scope_to,
       (SELECT COALESCE(json_agg(json_build_object('player', pc.player, 'games', pc.n) ORDER BY pc.n DESC, pc.player), '[]'::json)
          FROM player_counts pc WHERE pc.event_page = ev.event_page) AS players
FROM ev
LEFT JOIN picks p ON p.game_id = ev.game_id
LEFT JOIN bans b ON b.game_id = ev.game_id
GROUP BY ev.year, ev.event_page
HAVING COUNT(p.game_id) + COUNT(b.game_id) > 0
ORDER BY ev.year NULLS FIRST, MIN(ev.played_at) NULLS FIRST, ev.event_page`),
    };
  },
  relaxations: (input) => {
    if (!hasPeriod(input)) return [];
    const { yearFrom: from, yearTo: to } = input;
    const when = from != null && from === to ? say(`en ${from}`, `in ${from}`) : from != null && to != null ? say(`entre ${from} et ${to}`, `between ${from} and ${to}`) : from != null ? say(`depuis ${from}`, `since ${from}`) : say(`jusqu'en ${to}`, `until ${to}`);

    return [{ ...noPeriod(input, say("toutes les éditions", "every edition")), note: say(`${input.champion} n'a été ni pické ni banni ${when} dans cette compétition (qualifications exclues) : affichage de toutes les éditions.`, `${input.champion} was neither picked nor banned ${when} in this competition (qualifiers excluded): showing every edition.`) }];
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const raw = z.array(ChampionStatsRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const sum = (k: "picks" | "bans" | "wins") => raw.reduce((n, r) => n + r[k], 0);
    const picks = sum("picks");
    const bans = sum("bans");
    const wins = sum("wins");
    const first = raw[0];
    const games = first?.scope_games ?? 0;
    const years = raw.map((r) => Number(r.year));

    const scopeYears =
      first?.scope_from != null && first.scope_to != null && (first.scope_from < Math.min(...years) || first.scope_to > Math.max(...years))
        ? `, ${yearSpan([first.scope_from, first.scope_to])}`
        : "";

    const icon = (await selectOne(db, z.object({ icon_url: z.string().nullable() }), "SELECT icon_url FROM champions WHERE name = ?", [
      input.champion,
    ]))?.icon_url ?? null;

    const scope = scopeLabel(league, input);
    const profile = await championProfile(db, input, scope, games, bans, icon);
    const playerLine = (p: ChampionPlayer) => say(`${p.player} (${p.games} partie${p.games > 1 ? "s" : ""}, ${pct(p.wins, p.games)} % de victoires, KDA ${frNumber(p.kda)})`, `${p.player} (${p.games} game${p.games === 1 ? "" : "s"}, ${pct(p.wins, p.games)}% wins, KDA ${frNumber(p.kda)})`);

    const facts =
      say(`${input.champion} ${inLeague(league)} (${yearSpan(years)}) : ${picks} picks et ${bans} bans `, `${input.champion} ${inLeague(league)} (${yearSpan(years)}): ${picks} picks and ${bans} bans `) +
      say(`sur les ${games} parties du périmètre${scopeYears} (présence ${pct(picks + bans, games)} %), ${wins} victoires pour ${picks - wins} défaites `, `over the ${games} games of the scope${scopeYears} (presence ${pct(picks + bans, games)}%), ${wins} wins for ${picks - wins} losses `) +
      say(`(${pct(wins, picks)} % de victoires)`, `(${pct(wins, picks)}% wins)`) +
      (picks ? `, KDA ${frNumber(profile.kda)}. ${averagesFacts(profile)}` : ".") +
      (profile.roles.length ? say(` Rôles : ${profile.roles.map((r) => `${r.role} (${r.games})`).join(", ")}.`, ` Roles: ${profile.roles.map((r) => `${r.role} (${r.games})`).join(", ")}.`) : "") +
      (profile.players.length ? say(` Joueurs les plus fréquents (classés par parties jouées) : ${profile.players.slice(0, 3).map(playerLine).join(", ")}.`, ` Most frequent players (ranked by games played): ${profile.players.slice(0, 3).map(playerLine).join(", ")}.`) : "") +
      (picks ? itemsFacts(profile) + setupsFacts(profile) : "");

    return {
      title: `${input.champion} — ${[leagueLabel(league), titlePeriod(input)].filter(Boolean).join(" ")}`,
      champion: profile,
      table: {
        columns: [say("Année", "Year"), say("Tournoi", "Tournament"), say("Parties", "Games"), "Picks", "Bans", say("Présence %", "Presence %"), say("V-D", "W-L"), say("% victoire", "Win %"), say("Joueurs", "Players")],
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
        ...(profile.averages.some((a) => a.key === "gold_diff_15" && a.counted > 0) ? [riotDataSource()] : []),
        { label: "Riot Data Dragon — champions", url: icon ?? `${DDRAGON_BASE}/api/versions.json` },
        ...(profile.items.items.length ? [itemsSource(), { label: "Riot Data Dragon — items", url: `${DDRAGON_BASE}/api/versions.json` }] : []),
        ...(profile.setups.spells.length || profile.setups.runes.length ? [setupsSource()] : []),
      ],
      followUps: [
        say(`Champions les plus joués ${inLeague(league) || "aux Worlds"}${hasPeriod(input) ? ` ${input.yearFrom ?? ""}`.trimEnd() : ""}`, `Most played champions ${inLeague(league) || "at Worlds"}${hasPeriod(input) ? ` ${input.yearFrom ?? ""}`.trimEnd() : ""}`),
        ...profile.players.slice(0, 2).map((p) => say(`Résultats de ${p.player} ${league === "Worlds" ? "à tous les Worlds" : inLeague(league)}`, `${p.player}'s results ${league === "Worlds" ? "at every Worlds" : inLeague(league)}`)),
      ],
      totals: {
        picks,
        bans,
        wins,
        games,
        events: raw.length,
        kda: profile.kda ?? nd(),
        top_player: profile.players[0]?.player ?? "",
        top_player_games: profile.players[0]?.games ?? 0,
        main_role: profile.roles[0]?.role ?? "",
        avg_gold: profile.averages.find((a) => a.key === "gold")?.value ?? nd(),
        avg_damage: profile.averages.find((a) => a.key === "damage")?.value ?? nd(),
        gold_diff_15: profile.averages.find((a) => a.key === "gold_diff_15")?.value ?? nd(),
        item_games: profile.items.games,
        top_item: profile.items.items.find((i) => i.kind === "complete")?.item ?? "",
        top_item_games: profile.items.items.find((i) => i.kind === "complete")?.games ?? 0,
        top_spells: profile.setups.spells[0]?.spells.map((s) => s.name).join(" + ") ?? "",
        top_spells_games: profile.setups.spells[0]?.games ?? 0,
        keystone_games: profile.setups.keystoneGames,
        top_keystone: profile.setups.runes.find((r) => r.kind === "keystone")?.rune ?? "",
        top_keystone_games: profile.setups.runes.find((r) => r.kind === "keystone")?.games ?? 0,
        page_games: profile.setups.pageGames,
        top_primary: profile.setups.runes.find((r) => r.kind === "primary")?.rune ?? "",
        top_primary_games: profile.setups.runes.find((r) => r.kind === "primary")?.games ?? 0,
      },
    };
  },
  normalize: async (db, input) => {
    const c = await resolveChampion(db, input.champion);

    return c ? { ...input, champion: c.champion } : null;
  },
};

const CHAMPION_SORT_LABEL: Record<ChampionSort, { title: Phrase; criterion: Phrase }> = {
  picks: { title: phrase("Champions les plus joués", "Most played champions"), criterion: phrase("nombre de picks", "number of picks") },
  bans: { title: phrase("Champions les plus bannis", "Most banned champions"), criterion: phrase("nombre de bans", "number of bans") },
  presence: { title: phrase("Champions les plus présents", "Most present champions"), criterion: phrase("présence, (picks + bans) / parties", "presence, (picks + bans) / games") },
  winrate: { title: phrase("Champions au meilleur taux de victoire", "Champions with the best win rate"), criterion: phrase("victoires / picks", "wins / picks") },
  kda: { title: phrase("Champions au meilleur KDA", "Champions with the best KDA"), criterion: phrase("KDA, (kills + assists) / morts", "KDA, (kills + assists) / deaths") },
  kills: { title: phrase("Champions avec le plus de kills par partie", "Champions with the most kills per game"), criterion: phrase("kills par partie, en moyenne", "kills per game, on average") },
  deaths: { title: phrase("Champions avec le plus de morts par partie", "Champions with the most deaths per game"), criterion: phrase("morts par partie, en moyenne", "deaths per game, on average") },
  assists: { title: phrase("Champions avec le plus d'assists par partie", "Champions with the most assists per game"), criterion: phrase("assists par partie, en moyenne", "assists per game, on average") },
  gold: { title: phrase("Champions avec le plus d'or par partie", "Champions with the most gold per game"), criterion: phrase("or par partie, en moyenne", "gold per game, on average") },
  cs: { title: phrase("Champions avec le plus de CS par partie", "Champions with the most CS per game"), criterion: phrase("CS par partie, en moyenne", "CS per game, on average") },
  damage: { title: phrase("Champions avec le plus de dégâts par partie", "Champions with the most damage per game"), criterion: phrase("dégâts aux champions par partie, en moyenne", "damage to champions per game, on average") },
  vision: { title: phrase("Champions avec le plus de vision par partie", "Champions with the most vision per game"), criterion: phrase("score de vision par partie, en moyenne", "vision score per game, on average") },
  dpm: { title: phrase("Champions avec le plus de dégâts par minute", "Champions with the most damage per minute"), criterion: phrase("dégâts aux champions par minute", "damage to champions per minute") },
  gpm: { title: phrase("Champions avec le plus d'or par minute", "Champions with the most gold per minute"), criterion: phrase("or gagné par minute", "gold earned per minute") },
  cspm: { title: phrase("Champions avec le plus de CS par minute", "Champions with the most CS per minute"), criterion: phrase("CS par minute", "CS per minute") },
  gold_diff_15: { title: phrase("Champions au meilleur écart d'or à 15 min", "Champions with the best gold difference at 15 min"), criterion: phrase("écart d'or moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot", "average gold difference at 15 min against the lane opponent, over the games with Riot data") },
  cs_diff_15: { title: phrase("Champions au meilleur écart de CS à 15 min", "Champions with the best CS difference at 15 min"), criterion: phrase("écart de CS moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot", "average CS difference at 15 min against the lane opponent, over the games with Riot data") },
  xp_diff_15: { title: phrase("Champions au meilleur écart d'XP à 15 min", "Champions with the best XP difference at 15 min"), criterion: phrase("écart d'XP moyen à 15 min face à l'adversaire direct, sur les parties avec données Riot", "average XP difference at 15 min against the lane opponent, over the games with Riot data") },
  first_blood: { title: phrase("Champions qui prennent le plus souvent le first blood", "Champions that take first blood most often"), criterion: phrase("part des parties où le champion fait le first blood, sur les parties avec données Riot", "share of the games where the champion takes first blood, over the games with Riot data") },
  solo_kills: { title: phrase("Champions avec le plus de solo kills par partie", "Champions with the most solo kills per game"), criterion: phrase("solo kills par partie, sur les parties avec données Riot", "solo kills per game, over the games with Riot data") },
  players: { title: phrase("Champions joués par le plus de joueurs", "Champions played by the most players"), criterion: phrase("nombre de joueurs différents à l'avoir joué", "number of different players who played it") },
  penta_kills: { title: phrase("Champions avec le plus de pentakills", "Champions with the most pentakills"), criterion: phrase("pentakills au total, sur les parties avec données Riot", "pentakills in total, over the games with Riot data") },
  quadra_kills: { title: phrase("Champions avec le plus de quadrakills", "Champions with the most quadrakills"), criterion: phrase("quadrakills au total, sur les parties avec données Riot", "quadrakills in total, over the games with Riot data") },
  triple_kills: { title: phrase("Champions avec le plus de triple kills", "Champions with the most triple kills"), criterion: phrase("triple kills au total, sur les parties avec données Riot", "triple kills in total, over the games with Riot data") },
  double_kills: { title: phrase("Champions avec le plus de double kills", "Champions with the most double kills"), criterion: phrase("double kills au total, sur les parties avec données Riot", "double kills in total, over the games with Riot data") },
};


function ingameTotal(metric: keyof typeof PLAYER_METRIC_DEFS) {
  const { column, label, en } = PLAYER_METRIC_DEFS[metric];

  return { ingame: true, column, title: phrase(`Champions avec le plus de ${label}`, `Champions with the most ${en}`), unit: phrase(label, en), one: phrase(label.replace(/s$/, ""), en.replace(/s$/, "")) };
}

const CHAMPION_TOTAL: Record<ChampionTotalSort, { ingame: boolean; column: string; title: Phrase; unit: Phrase; one?: Phrase }> = {
  kills: { ingame: false, column: "kills", title: phrase("Champions avec le plus de kills", "Champions with the most kills"), unit: phrase("kills", "kills"), one: phrase("kill", "kill") },
  deaths: { ingame: false, column: "deaths", title: phrase("Champions avec le plus de morts", "Champions with the most deaths"), unit: phrase("morts", "deaths"), one: phrase("mort", "death") },
  assists: { ingame: false, column: "assists", title: phrase("Champions avec le plus d'assists", "Champions with the most assists"), unit: phrase("assists", "assists"), one: phrase("assist", "assist") },
  gold: { ingame: false, column: "gold", title: phrase("Champions avec le plus d'or", "Champions with the most gold"), unit: phrase("d'or", "gold") },
  cs: { ingame: false, column: "cs", title: phrase("Champions avec le plus de CS", "Champions with the most CS"), unit: phrase("CS", "CS") },
  damage: { ingame: false, column: "damage", title: phrase("Champions avec le plus de dégâts", "Champions with the most damage"), unit: phrase("de dégâts", "damage") },
  vision: { ingame: false, column: "vision", title: phrase("Champions avec le plus de score de vision", "Champions with the most vision score"), unit: phrase("de score de vision", "vision score") },
  solo_kills: ingameTotal("solo_kills"),
  first_blood: ingameTotal("first_bloods"),
  penta_kills: ingameTotal("penta_kills"),
  quadra_kills: ingameTotal("quadra_kills"),
  triple_kills: ingameTotal("triple_kills"),
  double_kills: ingameTotal("double_kills"),
};

const totalSortOf = (input: Pick<ChampionRankingInput, "sort" | "total">): ChampionTotalSort | null =>
  input.total ? (CHAMPION_TOTAL_SORTS.find((s) => s === input.sort) ?? null) : null;

const totalText = (sort: ChampionTotalSort, n: number | null) => {
  const t = CHAMPION_TOTAL[sort];

  return `${frNumber(n)} ${tr(say(t.one && (n ?? 0) < 2 ? t.one : t.unit, t.one && n === 1 ? t.one : t.unit))}`;
};

const totalCriterion = (sort: ChampionTotalSort) =>
  say(`${tr(CHAMPION_TOTAL[sort].unit)} au total sur le périmètre${CHAMPION_TOTAL[sort].ingame ? ", sur les parties avec données Riot" : ""}`, `${tr(CHAMPION_TOTAL[sort].unit)} in total over the scope${CHAMPION_TOTAL[sort].ingame ? ", over the games with Riot data" : ""}`);

const CHAMPION_EXTRA_TEXT: Record<ChampionExtraSort, (v: number | null) => string> = {
  dpm: (v) => say(`${frNumber(v)} dégâts/min`, `${frNumber(v)} damage/min`),
  gpm: (v) => say(`${frNumber(v)} d'or/min`, `${frNumber(v)} gold/min`),
  cspm: (v) => `${frNumber(v)} CS/min`,
  gold_diff_15: (v) => say(`${frNumber(v, true)} d'or à 15 min`, `${frNumber(v, true)} gold at 15 min`),
  cs_diff_15: (v) => say(`${frNumber(v, true)} CS à 15 min`, `${frNumber(v, true)} CS at 15 min`),
  xp_diff_15: (v) => say(`${frNumber(v, true)} d'XP à 15 min`, `${frNumber(v, true)} XP at 15 min`),
  first_blood: (v) => say(`first blood dans ${frNumber(v)} % des parties`, `first blood in ${frNumber(v)}% of games`),
  solo_kills: (v) => say(`${frNumber(v)} solo kills par partie`, `${frNumber(v)} solo kills per game`),
  players: (v) => say(`${frNumber(v)} joueurs`, `${frNumber(v)} players`),
};

const extraSortOf = (sort: ChampionSort): ChampionExtraSort | null => CHAMPION_EXTRA_SORTS.find((s) => s === sort) ?? null;

const CHAMPION_INGAME_SORTS: ChampionSort[] = ["gold_diff_15", "cs_diff_15", "xp_diff_15", "first_blood", "solo_kills", ...CHAMPION_MULTIKILL_SORTS];

const CHAMPION_AVERAGE_UNIT: Record<ChampionAverageSort, { unit: Phrase; digits: number }> = {
  kills: { unit: phrase("kills", "kills"), digits: 2 },
  deaths: { unit: phrase("morts", "deaths"), digits: 2 },
  assists: { unit: phrase("assists", "assists"), digits: 2 },
  gold: { unit: phrase("d'or", "gold"), digits: 0 },
  cs: { unit: phrase("CS", "CS"), digits: 1 },
  damage: { unit: phrase("de dégâts", "damage"), digits: 0 },
  vision: { unit: phrase("de vision", "vision"), digits: 1 },
};

const averageSortOf = (sort: ChampionSort): ChampionAverageSort | null => CHAMPION_AVERAGE_SORTS.find((s) => s === sort) ?? null;

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
  ingame_picks: z.number(),
  ingame_games: z.number(),
  sort_value: z.number().nullable(),
  min_picks: z.number(),
});

const DEFAULT_MIN_PICKS = atLeast(3, "(n.games + 49) / 50");

const DEFAULT_MIN_PICKS_AVERAGE = atLeast(5, "(n.games + 49) / 50");

const rankedChampionsScope = (input: ChampionRankingInput) => ({ ...leagueAndPeriod(input), split: input.split });

const needsMinPicks = (input: Pick<ChampionRankingInput, "sort" | "total">) => !["picks", "bans", "presence", "players"].includes(input.sort) && !totalSortOf(input);

const championRanking: ToolDef<ChampionRankingInput> = {
  name: "champion_ranking",
  label: phrase("classement de champions", "champion ranking"),
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
  plan: async (_db, input) => {
    const params: Params = {};
    const mine = (alias: string) => [input.role ? `${alias}.role = :role` : "", input.side ? `${alias}.side = ${SIDE_ID[input.side]}` : ""].filter(Boolean).join(" AND ") || "TRUE";
    const role = mine("gp");
    const side = (alias: string) => (input.side ? `${alias}.side = ${SIDE_ID[input.side]}` : "TRUE");

    const perMinuteOf = (column: string) =>
      `60.0 * SUM(CASE WHEN ${role} AND ev.length_s > 0 THEN gp.${column} END) / SUM(CASE WHEN ${role} AND ev.length_s > 0 AND gp.${column} IS NOT NULL THEN ev.length_s END)`;

    if (input.role) params.role = input.role;

    if (input.minPicks != null) params.minPicks = input.minPicks;
    const totalSort = totalSortOf(input);
    const total = totalSort ? CHAMPION_TOTAL[totalSort] : null;
    const average = totalSort ? null : averageSortOf(input.sort);
    const minPicks = input.minPicks != null ? ":minPicks" : totalSort ? "0" : average || extraSortOf(input.sort) ? DEFAULT_MIN_PICKS_AVERAGE : DEFAULT_MIN_PICKS;
    const order = totalSort ? "total" : average ? "average" : input.sort;
    const ingame = CHAMPION_INGAME_SORTS.includes(input.sort);

    return {
      params,
      sql: tidy(`WITH ev AS (
  SELECT g.game_id, g.length_s FROM v_games g WHERE ${rankingScope("g", rankedChampionsScope(input), params)}
),
n AS (SELECT COUNT(*) AS games FROM ev),
picks AS (
  SELECT gp.champion, SUM((${side("gp")})::integer) AS all_picks, SUM((${role})::integer) AS picks,
         SUM(CASE WHEN ${role} THEN gp.win END) AS wins,
         SUM(CASE WHEN ${role} AND gp.deaths IS NOT NULL THEN gp.kills + gp.assists END) AS ka,
         SUM(CASE WHEN ${role} AND gp.kills IS NOT NULL AND gp.assists IS NOT NULL THEN gp.deaths END) AS deaths,
         ${average ? `AVG(CASE WHEN ${role} THEN gp.${average} END)` : "NULL"} AS average,
         ${total && !total.ingame ? `SUM(CASE WHEN ${role} THEN gp.${total.column} END)` : "NULL"} AS total,
         ${perMinuteOf("damage")} AS dpm, ${perMinuteOf("gold")} AS gpm, ${perMinuteOf("cs")} AS cspm,
         COUNT(DISTINCT CASE WHEN ${role} THEN gp.player END) AS players
  FROM v_game_players gp JOIN ev ON ev.game_id = gp.game_id WHERE ${rankingScope("gp", rankedChampionsScope(input), params)}
  GROUP BY gp.champion
),
ig AS (
  SELECT s.champion, SUM((${mine("s")})::integer) AS ingame_picks,
         AVG(CASE WHEN ${mine("s")} THEN s.gold_diff_15 END) AS gold_diff_15, AVG(CASE WHEN ${mine("s")} THEN s.cs_diff_15 END) AS cs_diff_15,
         AVG(CASE WHEN ${mine("s")} THEN s.xp_diff_15 END) AS xp_diff_15, 100.0 * AVG(CASE WHEN ${mine("s")} THEN s.first_blood_kill END) AS first_blood,
         AVG(CASE WHEN ${mine("s")} THEN s.solo_kills END) AS solo_kills,
         ${total?.ingame ? `SUM(CASE WHEN ${mine("s")} THEN s.${total.column} END)` : "NULL"} AS total
  FROM v_game_player_stats s WHERE ${rankingScope("s", rankedChampionsScope(input), params)}
  GROUP BY s.champion
),
ign AS (SELECT COUNT(DISTINCT s.game_id) AS games FROM v_game_player_stats s WHERE ${rankingScope("s", rankedChampionsScope(input), params)}),
bans AS (
  SELECT d.champion, COUNT(DISTINCT d.game_id) AS bans FROM v_draft d JOIN ev ON ev.game_id = d.game_id WHERE d.kind = 'ban' AND ${side("d")} GROUP BY d.champion
),
lines AS (
  SELECT c.name AS champion, c.icon_url AS icon, COALESCE(p.picks, 0) AS picks, COALESCE(p.all_picks, 0) AS all_picks,
         COALESCE(b.bans, 0) AS bans, n.games, COALESCE(p.wins, 0) AS wins,
         ROUND(100.0 * (COALESCE(p.all_picks, 0) + COALESCE(b.bans, 0)) / ${atLeast(1, `n.games`)}, 1) AS presence,
         CASE WHEN p.picks > 0 THEN ROUND(100.0 * p.wins / p.picks, 1) END AS winrate,
         CASE WHEN p.picks > 0 AND p.ka IS NOT NULL THEN ROUND(1.0 * p.ka / ${atLeast(1, `p.deaths`)}, 2) END AS kda,
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
      out.push({ key: "minPicks", input: { ...input, minPicks: 1 }, note: say("Trop peu de picks par champion dans ce périmètre : seuil abaissé à 1 pick.", "Too few picks per champion in this scope: threshold lowered to 1 pick."), reason: say("seuil de picks abaissé", "pick threshold lowered") });

    if (hasPeriod(input)) out.push(noPeriod(input, input.split ? say(`toutes les saisons (split ${input.split})`, `every season (${input.split} split)`) : say("toutes les saisons", "every season")));

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const all = z.array(ChampionRankingRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const scope = rankingScopeLabel(league, input);
    const totalSort = totalSortOf(input);
    const label = totalSort ? { title: tr(CHAMPION_TOTAL[totalSort].title), criterion: totalCriterion(totalSort) } : { title: tr(CHAMPION_SORT_LABEL[input.sort].title), criterion: tr(CHAMPION_SORT_LABEL[input.sort].criterion) };
    const games = all[0]?.games ?? 0;
    const minPicks = all[0]?.min_picks ?? 0;
    const ingameGames = all[0]?.ingame_games ?? 0;
    const average = totalSort ? null : averageSortOf(input.sort);
    const extra = totalSort ? null : extraSortOf(input.sort);
    const role = `${input.role ? say(` en ${ROLE_LABEL[input.role]}`, ` in ${ROLE_LABEL[input.role]}`) : ""}${sideLabel(input.side)}`;
    const params: Params = {};
    const absent = CHAMPION_INGAME_SORTS.includes(input.sort) && ingameGames === 0;
    const rows = absent ? [] : totalSort ? all.filter((r) => (r.total ?? 0) > 0) : all;
    const ingamePicks = rows.reduce((n, r) => n + r.ingame_picks, 0);

    const counted =
      totalSort && CHAMPION_TOTAL[totalSort].ingame ? say(`${ingameGames}${ingameGames < games ? ` sur ${games}` : ""} parties avec données Riot`, `${ingameGames}${ingameGames < games ? ` out of ${games}` : ""} games with Riot data`) : say(`${games} parties`, `${games} games`);

    const pages = (await selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT g.event_page FROM v_games g WHERE ${rankingScope("g", rankedChampionsScope(input), params)} GROUP BY g.event_page ORDER BY MAX(g.played_at) DESC NULLS LAST LIMIT 12`,
      params,
    )).map((r) => r.event_page);

    const ongoingParams: Params = {};
    const ongoing = await inProgressNote(db, rankingScope("g", rankedChampionsScope(input), ongoingParams), ongoingParams);

    const line = (r: z.infer<typeof ChampionRankingRow>, i: number) =>
      `${i + 1}. ${r.champion} (${totalSort ? `${totalText(totalSort, r.total)}, ` : ""}` +
      say(`${average ? `${frNumber(r.average)} ${tr(CHAMPION_AVERAGE_UNIT[average].unit)} par partie, ` : ""}${extra ? `${CHAMPION_EXTRA_TEXT[extra](r[extra])}, ` : ""}`, `${average ? `${frNumber(r.average)} ${tr(CHAMPION_AVERAGE_UNIT[average].unit)} per game, ` : ""}${extra ? `${CHAMPION_EXTRA_TEXT[extra](r[extra])}, ` : ""}`) +
      say(`${r.picks} pick${r.picks > 1 ? "s" : ""}, ${r.bans} ban${r.bans > 1 ? "s" : ""}, présence ${frNumber(r.presence)} %, `, `${r.picks} pick${r.picks === 1 ? "" : "s"}, ${r.bans} ban${r.bans === 1 ? "" : "s"}, presence ${frNumber(r.presence)}%, `) +
      say(`${r.winrate == null ? "winrate n/d" : `${frNumber(r.winrate)} % de victoires`}, KDA ${frNumber(r.kda)})`, `${r.winrate == null ? "win rate n/a" : `${frNumber(r.winrate)}% wins`}, KDA ${frNumber(r.kda)})`);

    const threshold = minPicks ? `, minimum ${minPicks} picks` : "";
    const head = `${label.title}${role} ${scope || allCompetitions()}`;

    const ranking = absent
      ? say(`Aucune partie ${scope || "de ce périmètre"} n'a de données Riot sur Leaguepedia (${games} parties) : pas de ${tr(CHAMPION_SORT_LABEL[input.sort].criterion).split(",")[0]} par champion.`, `No game ${scope || "of this scope"} has Riot data on Leaguepedia (${games} games): no ${tr(CHAMPION_SORT_LABEL[input.sort].criterion).split(",")[0]} per champion.`)
      : totalSort && !rows.length
        ? say(`Aucun ${tr(CHAMPION_TOTAL[totalSort].one ?? CHAMPION_TOTAL[totalSort].unit)}${role} ${scope || allCompetitions()} : 0 au total sur les ${counted}${threshold}.`, `No ${tr(CHAMPION_TOTAL[totalSort].one ?? CHAMPION_TOTAL[totalSort].unit)}${role} ${scope || allCompetitions()}: 0 in total over the ${counted}${threshold}.`)
        : say(`${head} (${counted}) : ${rows.slice(0, 3).map(line).join(", ")}. Critère : ${label.criterion}${threshold}.`, `${head} (${counted}): ${rows.slice(0, 3).map(line).join(", ")}. Criterion: ${label.criterion}${threshold}.`);

    const facts =
      ranking +
      (rows.length && input.role
        ? say(` Picks, victoires, KDA et moyennes${role} seulement ; bans et présence${sideLabel(input.side)} tous rôles confondus.`, ` Picks, wins, KDA and averages${role} only; bans and presence${sideLabel(input.side)} across all roles.`)
        : rows.length && input.side
          ? say(` Picks, bans et présence${role} seulement, sur les ${games} parties.`, ` Picks, bans and presence${role} only, over the ${games} games.`)
          : "") +
      (ongoing ? ` ${ongoing}` : "");

    const multikill = CHAMPION_MULTIKILL_SORTS.findIndex((m) => m === totalSort);
    const lowerMultikill = multikill >= 0 ? (CHAMPION_MULTIKILL_SORTS[multikill + 1] ?? null) : null;
    const where = `${inLeague(league) || say("aux Worlds", "at Worlds")}${input.yearFrom != null && input.yearFrom === input.yearTo ? ` ${input.yearFrom}` : ""}`;

    const figure = totalSort ? `total_${totalSort}` : average;

    const out: ToolOutput = {
      title: `${label.title}${role}${rankingTitleScope(league, input, " — ")}`,
      icons: Object.fromEntries(rows.flatMap((r) => (r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [
        ...eventSources(pages, 12),
        ...(ingamePicks || (totalSort && CHAMPION_TOTAL[totalSort].ingame && ingameGames) ? [riotDataSource()] : []),
        { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps: rows.length
        ? rows.slice(0, 2).map((r) => say(`Stats de ${r.champion} ${where}`, `${r.champion} stats ${where}`))
        : [
            ...(lowerMultikill ? [say(`Champions avec le plus de ${tr(CHAMPION_TOTAL[lowerMultikill].unit)} ${where}`, `Champions with the most ${tr(CHAMPION_TOTAL[lowerMultikill].unit)} ${where}`)] : []),
            say(`Champions les plus joués ${where}`, `Most played champions ${where}`),
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

    if (!absent && (rows.length || !totalSort))
      out.table = {
        columns: figure ? ["rank", "champion", figure, ...CHAMPION_RANKING_COLUMNS.slice(2)] : [...CHAMPION_RANKING_COLUMNS],
        rows: rows.map((r, i) => [i + 1, r.champion, ...(figure ? [totalSort ? r.total : r.average] : []), r.picks, r.bans, r.presence, r.winrate, r.kda, ...CHAMPION_EXTRA_SORTS.map((c) => r[c])]),
      };

    return out;
  },
  normalize: (_db, input) => ({
    ...input,
    total: CHAMPION_TOTAL_SORTS.some((s) => s === input.sort) && (input.total === true || CHAMPION_MULTIKILL_SORTS.some((s) => s === input.sort)),
    minPicks: input.minPicks != null && input.minPicks >= 3 ? input.minPicks : null,
  }),
};

export const CHAMPION_POOL_COLUMNS = ["rank", "champion", "games", "wins", "losses", "winrate", "kda", "share"] as const;

const ChampionPoolRow = z.object({
  champion: Text,
  icon: NullableText,
  games: z.number(),
  wins: z.number(),
  kda: z.number().nullable(),
  players: z.array(z.object({ player: z.string(), games: z.number() })),
  total_games: z.number(),
  total_wins: z.number(),
  total_picks: z.number(),
  unique_champions: z.number(),
});

async function poolScope(db: Db, input: ChampionPoolInput, params: Params): Promise<string> {
  const who =
    input.subject === "player"
      ? ((params.player = input.name), "gp.player = :player")
      : `gp.team IN (${inList("team", (await teamMembers(db, input.name)).members, params)})`;

  const league = input.league ? `AND ${leagueFilter("gp.league", input, params)}` : "";

  return `${who} AND gp.champion IS NOT NULL AND gp.stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("gp.year", input, params)} ${splitFilter("gp.tournament_page", input, params)}`;
}

const championPool: ToolDef<ChampionPoolInput> = {
  name: "champion_pool",
  label: phrase("champion pool", "champion pool"),
  description:
    "The champion pool of one player, or of one team (every champion its players picked), in a competition, period and split: games, " +
    "W-L, win rate and KDA on each champion, its share of the pool, and the pool's diversity (distinct champions, share of the three most played). " +
    "Use it for 'champion pool de Faker', 'quels champions joue Keria', 'champions joués par T1 aux Worlds 2023'.",
  plan: async (db, input) => {
    const params: Params = {};

    return {
      params,
      sql: tidy(`WITH picks AS (
  SELECT gp.game_id, gp.champion, gp.player, gp.win, gp.kills, gp.deaths, gp.assists
  FROM v_game_players gp
  WHERE ${await poolScope(db, input, params)}
),
tot AS (
  SELECT COUNT(DISTINCT game_id) AS total_games, COUNT(DISTINCT CASE WHEN win = 1 THEN game_id END) AS total_wins,
         COUNT(*) AS total_picks, COUNT(DISTINCT champion) AS unique_champions
  FROM picks
),
by_player AS (SELECT champion, player, COUNT(*) AS games FROM picks GROUP BY champion, player),
pool_players AS (
  SELECT b.champion, COALESCE(json_agg(json_build_object('player', b.player, 'games', b.games) ORDER BY b.games DESC, b.player), '[]'::json) AS players
  FROM by_player b GROUP BY b.champion
)
SELECT p.champion, ANY_VALUE(c.icon_url) AS icon, COUNT(*) AS games, SUM(p.win) AS wins,
       ROUND(1.0 * ${kaSum("p")}
             / ${atLeast(1, deathsSum("p"))}, 2) AS kda,
       ANY_VALUE(pp.players) AS players, ANY_VALUE(tot.total_games) AS total_games, ANY_VALUE(tot.total_wins) AS total_wins,
       ANY_VALUE(tot.total_picks) AS total_picks, ANY_VALUE(tot.unique_champions) AS unique_champions
FROM picks p JOIN pool_players pp ON pp.champion = p.champion CROSS JOIN tot
LEFT JOIN champions c ON c.name = p.champion
GROUP BY p.champion
ORDER BY games DESC, wins DESC, p.champion
LIMIT 200`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.split) out.push({ key: "split", input: { ...input, split: null }, note: say(`Aucune partie en ${input.split} : toute la saison.`, `No game in ${input.split}: the whole season.`), reason: say("filtre de split retiré", "split filter removed") });

    if (hasPeriod(input)) out.push(noPeriod({ ...input, split: null }, say("toutes les saisons", "every season")));

    if (input.subject !== "player") return out;
    const resolved = entities.players.find((p) => p.player === input.name || p.otherCandidates.includes(input.name));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.name)
        out.push({
          key: `player:${other}`,
          input: { ...input, name: other },
          note: say(`« ${resolved!.mention} » désigne aussi ${other} : champion pool de ${other}.`, `"${resolved!.mention}" also names ${other}: champion pool of ${other}.`),
          reason: say(`alias homonyme essayé : ${other}`, `homonym alias tried: ${other}`),
        });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(ChampionPoolRow).parse(sqlRows);
    const first = rows[0];
    const league = await leagueShortName(db, input.league);
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

    const pages = (await selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT gp.event_page FROM v_game_players gp WHERE ${await poolScope(db, input, params)} GROUP BY gp.event_page ORDER BY MAX(gp.played_at) DESC NULLS LAST LIMIT 12`,
      params,
    )).map((r) => r.event_page);

    const line = (l: ChampionPoolLine) =>
      say(`${l.champion} (${l.games} partie${l.games > 1 ? "s" : ""}, ${l.wins}-${l.losses}, ${frNumber(l.winrate)} % de victoires, KDA ${frNumber(l.kda)}`, `${l.champion} (${l.games} game${l.games === 1 ? "" : "s"}, ${l.wins}-${l.losses}, ${frNumber(l.winrate)}% wins, KDA ${frNumber(l.kda)}`) +
      `${team && l.players[0] ? say(`, surtout ${l.players[0].player}`, `, mostly ${l.players[0].player}`) : ""})`;

    const facts =
      say(`Champion pool de ${name}${scope ? ` ${scope}` : " toutes compétitions"} : ${pool.unique} champion${pool.unique > 1 ? "s" : ""} différent${pool.unique > 1 ? "s" : ""} `, `Champion pool of ${name}${scope ? ` ${scope}` : " all competitions"}: ${pool.unique} different champion${pool.unique === 1 ? "" : "s"} `) +
      say(`sur ${pool.games} partie${pool.games > 1 ? "s" : ""} (${pool.wins} victoire${pool.wins > 1 ? "s" : ""}, ${pool.losses} défaite${pool.losses > 1 ? "s" : ""})${team ? `, ${pool.picks} picks` : ""}. `, `over ${pool.games} game${pool.games === 1 ? "" : "s"} (${pool.wins} win${pool.wins === 1 ? "" : "s"}, ${pool.losses} loss${pool.losses === 1 ? "" : "es"})${team ? `, ${pool.picks} picks` : ""}. `) +
      say(`Les plus joués : ${lines.slice(0, 3).map(line).join(", ")}. `, `Most played: ${lines.slice(0, 3).map(line).join(", ")}. `) +
      say(`Les ${Math.min(3, lines.length)} premiers font ${frNumber(top3Share)} % du pool.`, `The top ${Math.min(3, lines.length)} make up ${frNumber(top3Share)}% of the pool.`);

    const ongoingParams: Params = {};
    const ongoing = await inProgressNote(db, `g.game_id IN (SELECT gp.game_id FROM v_game_players gp WHERE ${await poolScope(db, input, ongoingParams)})`, ongoingParams);
    const period = input.yearFrom != null && input.yearFrom === input.yearTo ? ` ${input.yearFrom}` : "";
    const where = inLeague(league);

    return {
      title: `Champion pool — ${name}${titleScope(league, input, " — ")}${input.split ? ` ${input.split}` : ""}`,
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
        ...lines.slice(0, 1).map((l) => say(`Stats ${/^[AEIOUYH]/i.test(l.champion) ? "d'" : "de "}${l.champion} ${where || "aux Worlds"}${period}`, `${l.champion} stats ${where || "at Worlds"}${period}`)),
        team ? say(`Historique de ${name}${where ? ` ${where}` : ""}`, `${name} history${where ? ` ${where}` : ""}`) : say(`Résultats de ${name} ${where || "à tous les Worlds"}`, `${name}'s results ${where || "at every Worlds"}`),
        say(`Champions les plus joués ${where || "aux Worlds"}${period}`, `Most played champions ${where || "at Worlds"}${period}`),
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
        top_kda: lines[0]?.kda ?? nd(),
        rows: lines.length,
      },
    };
  },
  normalize: async (db, input) => {
    if (input.subject === "team") {
      const t = await resolveTeam(db, input.name);

      return t ? { ...input, name: t.team } : null;
    }

    const p = await resolvePlayer(db, input.name, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, name: p.player } : null;
  },
};

async function playerRunesScope(db: Db, input: PlayerRunesInput, params: Params): Promise<string> {
  const pool = await poolScope(db, { subject: "player", name: input.player, league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo, split: input.split }, params);
  const champion = input.champion ? ((params.champion = input.champion), "AND gp.champion = :champion") : "";
  const role = input.role ? ((params.role = input.role), "AND gp.role = :role") : "";

  return `${pool} ${champion} ${role}`;
}

const PlayerRunesChampionRow = z.object({ champion: Text, icon: NullableText, games: z.number(), wins: z.number() });

const RunePageRow = z.object({ page: Text, games: z.number(), wins: z.number() });

const RUNE_PAGES = 5;

const slotKind = (slot: number): RuneKind => (slot === 1 ? "keystone" : slot <= 4 ? "primary" : slot <= 6 ? "secondary" : "shard");

async function scopePages(db: Db, input: PlayerRunesInput, runes: PlayerRunes["runes"]): Promise<{ pages: RunePage[]; secondary: RuneTree[] }> {
  const params: Params = {};
  const where = await playerRunesScope(db, input, params);

  const rows = await selectAll(
    db,
    RunePageRow,
    `WITH pages AS (
       SELECT gp.game_id, MAX(gp.win) AS win, STRING_AGG(LEAST(r.slot, 5) || '=' || r.rune, '|' ORDER BY LEAST(r.slot, 5), r.rune) AS page
       FROM v_game_players gp CROSS JOIN LATERAL (SELECT * FROM v_player_runes r WHERE r.game_id = gp.game_id AND r.player = gp.player AND r.slot <= 6 OFFSET 0) r
       WHERE ${where}
       GROUP BY gp.game_id, gp.player
       HAVING MIN(r.slot) = 1 AND COUNT(CASE WHEN r.slot = 2 THEN 1 END) = 1
     )
     SELECT page, COUNT(*) AS games, COALESCE(SUM(win), 0) AS wins FROM pages GROUP BY page ORDER BY games DESC, wins DESC, page`,
    params,
  );

  const known = new Map(runes.map((r) => [r.rune, r]));

  const pages = rows.map((row) => ({
    games: row.games,
    wins: row.wins,
    runes: row.page.split("|").map((part) => {
      const at = part.indexOf("=");
      const rune = part.slice(at + 1);

      return { rune, kind: slotKind(Number(part.slice(0, at))), tree: known.get(rune)?.tree ?? null, icon: known.get(rune)?.icon ?? runeIcon(rune, null) };
    }),
  }));

  const secondary = new Map<string, RuneTree>();

  for (const p of pages) {
    const tree = p.runes.find((r) => r.kind === "secondary")?.tree;

    if (!tree) continue;
    const t = secondary.get(tree) ?? { tree, part: "secondary", games: 0, wins: 0 };
    t.games += p.games;
    t.wins += p.wins;
    secondary.set(tree, t);
  }

  return { pages: pages.slice(0, RUNE_PAGES), secondary: [...secondary.values()].sort((a, b) => b.games - a.games || a.tree.localeCompare(b.tree)) };
}

function primaryTrees(runes: PlayerRunes["runes"]): RuneTree[] {
  const trees = new Map<string, RuneTree>();

  for (const r of runes) {
    if (r.kind !== "keystone" || !r.tree) continue;
    const t = trees.get(r.tree) ?? { tree: r.tree, part: "primary", games: 0, wins: 0 };
    t.games += r.games;
    t.wins += r.wins;
    trees.set(r.tree, t);
  }

  return [...trees.values()].sort((a, b) => b.games - a.games || a.tree.localeCompare(b.tree));
}

const runeLine = (name: string, games: number, wins: number, of: number) =>
  say(`${name} (${games}/${of} parties, ${pct(games, of)} %, ${pct(wins, games)} % de victoires)`, `${name} (${games}/${of} games, ${pct(games, of)}%, ${pct(wins, games)}% wins)`);

const playerRunes: ToolDef<PlayerRunesInput> = {
  name: "player_runes",
  label: phrase("runes d'un joueur", "player runes"),
  description:
    "One player's runes in a competition, period and split, optionally on one champion and in one role: keystones with games, wins and win rate, " +
    "the primary and secondary trees, the primary and secondary runes and the stat shards, and the most frequent rune pages. " +
    "Use it for 'runes de Faker aux Worlds 2019', 'keystones de Chovy en LCK 2025', 'runes de Faker sur Azir', \"Faker's runes at Worlds 2019\". " +
    "A champion's runes without a player go to champion_event_stats.",
  plan: async (db, input) => {
    const params: Params = {};

    return {
      params,
      sql: tidy(`SELECT gp.champion, ANY_VALUE(c.icon_url) AS icon, COUNT(*) AS games, COALESCE(SUM(gp.win), 0) AS wins
FROM v_game_players gp LEFT JOIN champions c ON c.name = gp.champion
WHERE ${await playerRunesScope(db, input, params)}
GROUP BY gp.champion
ORDER BY games DESC, wins DESC, gp.champion`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.split) out.push({ key: "split", input: { ...input, split: null }, note: say(`Aucune partie en ${input.split} : toute la saison.`, `No game in ${input.split}: the whole season.`), reason: say("filtre de split retiré", "split filter removed") });

    if (hasPeriod(input)) out.push(noPeriod({ ...input, split: null }, say("toutes les saisons", "every season")));

    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({
          key: `player:${other}`,
          input: { ...input, player: other },
          note: say(`« ${resolved!.mention} » désigne aussi ${other} : runes de ${other}.`, `"${resolved!.mention}" also names ${other}: runes of ${other}.`),
          reason: say(`alias homonyme essayé : ${other}`, `homonym alias tried: ${other}`),
        });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const champions = z.array(PlayerRunesChampionRow).parse(sqlRows);
    const games = champions.reduce((n, c) => n + c.games, 0);
    const wins = champions.reduce((n, c) => n + c.wins, 0);
    const league = await leagueShortName(db, input.league);
    const scope = [scopeLabel(league, input), input.split ? `(${input.split})` : ""].filter(Boolean).join(" ");
    const runes = await scopeRunes(db, (p) => playerRunesScope(db, input, p), games);
    const { pages, secondary } = runes.pageGames ? await scopePages(db, input, runes.runes) : { pages: [], secondary: [] };
    const champion = input.champion ? { name: input.champion, icon: champions[0]?.icon ?? null } : null;
    const role = input.role ? (ROLE_LABEL_BY_NAME.get(input.role) ?? input.role) : null;

    const view: PlayerRunes = {
      player: input.player,
      scope,
      champion,
      role,
      games,
      wins,
      keystoneGames: runes.keystoneGames,
      pageGames: runes.pageGames,
      runes: runes.runes,
      trees: [...primaryTrees(runes.runes), ...secondary],
      pages,
      notes: runes.notes,
    };

    const keystones = runes.runes.filter((r) => r.kind === "keystone");
    const page = pages[0];
    const on = [champion ? say(`sur ${champion.name}`, `on ${champion.name}`) : "", role ? say(`en ${role}`, `as ${role}`) : ""].filter(Boolean).join(" ");
    const where = [scope || allCompetitions(), on].filter(Boolean).join(", ");

    const leading = keystones.slice(0, 3).map((r) => runeLine(r.rune, r.games, r.wins, runes.keystoneGames)).join(", ");

    const facts =
      (keystones.length
        ? say(`Runes de ${input.player} (${where}) sur ${games} partie${games > 1 ? "s" : ""}, keystones les plus fréquentes : ${leading}.`, `${input.player}'s runes (${where}) over ${games} game${games === 1 ? "" : "s"}, most frequent keystones: ${leading}.`)
        : say(`Runes de ${input.player} (${where}) : ${games} partie${games > 1 ? "s" : ""}.`, `${input.player}'s runes (${where}): ${games} game${games === 1 ? "" : "s"}.`)) +
      (page
        ? say(` Page la plus fréquente (hors fragments) : ${page.runes.map((r) => r.rune).join(", ")} (${page.games}/${runes.pageGames} parties).`, ` Most frequent page (shards aside): ${page.runes.map((r) => r.rune).join(", ")} (${page.games}/${runes.pageGames} games).`)
        : "") +
      (runes.notes.length ? ` ${runes.notes.join(" ")}` : "");

    const pagesParams: Params = {};

    const events = (await selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT gp.event_page FROM v_game_players gp WHERE ${await playerRunesScope(db, input, pagesParams)} GROUP BY gp.event_page ORDER BY MAX(gp.played_at) DESC NULLS LAST LIMIT 12`,
      pagesParams,
    )).map((r) => r.event_page);

    const at = inLeague(league);
    const year = input.yearFrom != null && input.yearFrom === input.yearTo ? input.yearFrom : null;
    const asked = at ? `${at}${year ? ` ${year}` : ""}` : year ? say(`en ${year}`, `in ${year}`) : "";
    const top = champions[0]?.champion;
    const of = (name: string) => (/^[AEIOUYH]/i.test(name) ? "d'" : "de ");
    const tail = asked ? ` ${asked}` : "";

    const followUps = [
      ...(runes.keystoneGames && !champion && top && champions.length > 1 ? [say(`Runes de ${input.player} sur ${top}${tail}`, `${input.player}'s runes on ${top}${tail}`)] : []),
      ...(runes.keystoneGames && top && at ? [say(`Runes ${of(top)}${top} ${asked}`, `${top} runes ${asked}`)] : []),
      say(`Champion pool de ${input.player}${tail}`, `${input.player}'s champion pool${tail}`),
      say(`Résultats de ${input.player} ${league === "Worlds" || !at ? "à tous les Worlds" : at}`, `${input.player}'s results ${league === "Worlds" || !at ? "at every Worlds" : at}`),
    ].slice(0, 3);

    const title = say(`Runes de ${input.player}`, `${input.player}'s runes`) + (champion ? say(` sur ${champion.name}`, ` on ${champion.name}`) : "") + titleScope(league, input, " — ") + (input.split ? ` ${input.split}` : "");

    return {
      title,
      runes: view,
      table: {
        columns: [say("partie de la page", "part of the page"), "rune", say("arbre", "tree"), say("parties", "games"), say("victoires", "wins"), "winrate"],
        rows: RUNE_KINDS.flatMap((kind) => runes.runes.filter((r) => r.kind === kind)).map((r) => [tr(RUNE_KIND_LABEL[r.kind]), r.rune, r.tree, r.games, r.wins, r.games ? pct(r.wins, r.games) : null]),
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(events, 12),
        setupsSource(),
        { label: "Riot Data Dragon — runes", url: `${DDRAGON_BASE}/api/versions.json` },
      ],
      followUps,
      totals: {
        games,
        wins,
        keystone_games: runes.keystoneGames,
        page_games: runes.pageGames,
        top_keystone: keystones[0]?.rune ?? "",
        top_keystone_games: keystones[0]?.games ?? 0,
        top_keystone_wins: keystones[0]?.wins ?? 0,
        keystones: keystones.length,
        top_primary_tree: view.trees.find((t) => t.part === "primary")?.tree ?? "",
        top_secondary_tree: secondary[0]?.tree ?? "",
        top_page_games: page?.games ?? 0,
        top_champion: top ?? "",
      },
    };
  },
  normalize: async (db, input) => {
    const p = await resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    if (!p) return null;

    if (!input.champion) return { ...input, player: p.player };
    const c = await resolveChampion(db, input.champion);

    return c ? { ...input, player: p.player, champion: c.champion } : null;
  },
};

const RUNE_KIND_LABEL: Record<RuneKind, Phrase> = {
  keystone: phrase("keystone", "keystone"),
  primary: phrase("primaire", "primary"),
  secondary: phrase("secondaire", "secondary"),
  shard: phrase("fragment", "shard"),
};

const tournamentStandings: ToolDef<StandingsInput> = {
  name: "tournament_standings",
  label: phrase("palmarès / classement", "winners / standings"),
  description:
    "Final standings of a competition: every placement of one edition (full), or the champion and finalist of each edition (roll of honour).",
  plan: async (_db, input) => {
    const params: Params = {};

    

    const filters: string[] = [];

    if (input.split) {
      filters.push("AND t.split = :split");
      params.split = input.split;
    }

    if (!input.full) {
      filters.push("AND tr.place_number <= 2");
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
ORDER BY t.date_start NULLS FIRST, tr.event_page, tr.place_number IS NULL, tr.place_number, tr.team`),
    };
  },
  relaxations: (input) =>
    input.split
      ? [{ key: "split", input: { ...input, split: null }, note: say(`Aucun classement pour le split ${input.split} : affichage de toute l'année.`, `No standings for the ${input.split} split: showing the whole year.`), reason: say("filtre de split retiré", "split filter removed") }]
      : [],
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const raw = z.array(StandingsRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
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
              ? say(`${name} : ${displayTeam(String(w.team))} champion${f ? `, ${displayTeam(String(f.team))} finaliste` : ""}.`, `${name}: ${displayTeam(String(w.team))} champion${f ? `, ${displayTeam(String(f.team))} runner-up` : ""}.`)
              : say(`${name} : finale pas encore publiée sur Leaguepedia.`, `${name}: final not yet published on Leaguepedia.`);
          })
          .join(" ") + say(` ${raw.length} équipes classées.`, ` ${raw.length} teams ranked.`);

      return {
        title: say(`Classement — ${pages.length === 1 ? nameOf(pages[0]) : `${leagueLabel(league)} ${span(raw.map((r) => r.year))}`}`, `Standings — ${pages.length === 1 ? nameOf(pages[0]) : `${leagueLabel(league)} ${span(raw.map((r) => r.year))}`}`),
        table: {
          columns: [...(multi ? [say("Tournoi", "Tournament")] : []), "Place", say("Équipe", "Team"), say("Gains (USD)", "Prize (USD)")],
          rows: raw.map((r) => [
            ...(multi ? [nameOf(r.event_page)] : []),
            r.place ? `${placeLabel(r.place)} (${r.place})` : "—",
            displayTeam(r.team),
            r.prize_usd == null ? null : Math.round(r.prize_usd),
          ]),
        },
        facts,
        sources,
        followUps: champions.slice(0, 2).map((w) => say(`Historique de ${displayTeam(w.team)}`, `${displayTeam(w.team)} history`)),
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
      say(`Palmarès ${frenchOf(leagueLabel(league))}${input.split ? ` (${input.split})` : ""} : ${rows.length} tournois (${span(editions.map((e) => e.year))}). `, `Winners of ${leagueLabel(league)}${input.split ? ` (${input.split})` : ""}: ${rows.length} tournaments (${span(editions.map((e) => e.year))}). `) +
      (ranking.length
        ? say(`Plus titrés : ${ranking.slice(0, 3).map(([t, n]) => `${t} (${n})`).join(", ")}. Dernier vainqueur : ${latest}.`, `Most titles: ${ranking.slice(0, 3).map(([t, n]) => `${t} (${n})`).join(", ")}. Latest winner: ${latest}.`)
        : say("Aucun vainqueur publié.", "No winner published."));

    return {
      title: say(`Palmarès — ${leagueLabel(league)}${hasPeriod(input) ? ` ${yearSpan(editions.map((e) => e.year))}` : ""}`, `Winners — ${leagueLabel(league)}${hasPeriod(input) ? ` ${yearSpan(editions.map((e) => e.year))}` : ""}`),
      table: { columns: [say("Année", "Year"), say("Tournoi", "Tournament"), say("Vainqueur", "Winner"), say("Finaliste", "Runner-up")], rows },
      facts,
      sources,
      followUps: ranking.slice(0, 2).map(([t]) => say(`Historique de ${t}`, `${t} history`)),
      totals: { events: rows.length, most_titles: ranking[0]?.[0] ?? "", most_titles_count: ranking[0]?.[1] ?? 0, latest_champion: latest },
    };
  },
  normalize: (_db, input) => input,
};

const riotDataSource = (): Source => ({
  label: say("Leaguepedia — données Riot des parties (PostgameJsonMetadata)", "Leaguepedia — Riot game data (PostgameJsonMetadata)"),
  url: wikiUrl("Special:CargoTables/PostgameJsonMetadata"),
});

const ingameFollowUp = {
  player: (name: string) => say(`Solo kills de ${name}`, `${name} solo kills`),
  team: (name: string) => {
    const words = displayTeam(name).replace(/[^\p{L}\p{N}.\-&' ]+/gu, "").replace(/\s+/g, " ").trim();

    return say(`First blood de ${words}`, `${words} first blood`);
  },
};

const yearSpan = (years: number[]) => (years.length && Math.min(...years) === Math.max(...years) ? String(years[0]) : span(years));

const signed = (n: number | null) => (n == null ? nd() : `${n > 0 ? "+" : ""}${n}`);
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

function aggregateSql(aggregate: "sum" | "avg" | "rate", column: string): string {
  if (aggregate === "sum") return `SUM(${column})`;

  if (aggregate === "rate") return `ROUND(100.0 * AVG(${column}), 1)`;

  return `ROUND(AVG(${column}), ${/gold|xp/.test(column) ? 0 : 1})`;
}

function ingameScope(input: { league: string | null } & Period, params: Params): string {
  return competitionScope("s", leagueAndPeriod(input), params);
}

async function coverage(db: Db, sql: string, params: Params) {
  return await selectOne(db, z.object({ games: z.number(), ingame: z.number() }), sql, params) ?? { games: 0, ingame: 0 };
}

const coverageNote = (c: { games: number; ingame: number }) =>
  c.ingame < c.games
    ? say(` Données in-game disponibles pour ${c.ingame} parties sur ${c.games} (Leaguepedia ne publie pas les données Riot de toutes les parties, aucune en LPL).`, ` In-game data available for ${c.ingame} games out of ${c.games} (Leaguepedia does not publish the Riot data of every game, none in the LPL).`)
    : "";

const PLAYER_OVERVIEW: PlayerMetric[] = ["solo_kills", "penta_kills", "first_bloods", "kills_before_10", "gold_diff", "cs_diff", "wards_placed"];

const PLAYER_COLUMN_LABELS: Record<PlayerMetric, Phrase> = {
  solo_kills: phrase("Solo kills", "Solo kills"),
  penta_kills: phrase("Pentakills", "Pentakills"),
  quadra_kills: phrase("Quadrakills", "Quadrakills"),
  triple_kills: phrase("Triple kills", "Triple kills"),
  double_kills: phrase("Double kills", "Double kills"),
  first_bloods: phrase("First bloods", "First bloods"),
  kills_before_10: phrase("Kills < 10 min", "Kills < 10 min"),
  gold_diff: phrase("Écart or", "Gold diff"),
  cs_diff: phrase("Écart CS", "CS diff"),
  xp_diff: phrase("Écart XP", "XP diff"),
  gold: phrase("Or", "Gold"),
  cs: phrase("CS", "CS"),
  xp: phrase("XP", "XP"),
  wards_placed: phrase("Wards / partie", "Wards / game"),
  wards_killed: phrase("Wards détruites / partie", "Wards killed / game"),
  control_wards: phrase("Control wards / partie", "Control wards / game"),
  plates: phrase("Plaques", "Plates"),
};

const playerMetricsOf = (input: PlayerIngameInput): PlayerMetric[] =>
  input.metric ? [input.metric, ...PLAYER_OVERVIEW.filter((m) => m !== input.metric)] : PLAYER_OVERVIEW;

const IngameRow = z
  .object({ year: z.number().nullable(), league_short: z.string().nullable(), games: z.number(), wins: z.number(), pages: pageList, stats_page: z.string().nullable() })
  .catchall(z.number().nullable());

const playerIngameStats: ToolDef<PlayerIngameInput> = {
  name: "player_ingame_stats",
  label: phrase("stats in-game d'un joueur", "in-game stats of a player"),
  description:
    "A player's in-game stats from the Riot game data, season by season: solo kills, multi-kills, first bloods, kills before 10 min, " +
    "gold/CS/XP and their difference with the lane opponent at 10/15/20 min, wards, plates. Not available for the LPL.",
  plan: async (_db, input) => {
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
       COALESCE(json_agg(DISTINCT s.event_page), '[]'::json) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game NULLS FIRST`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.league)
      out.push({
        key: "league",
        input: { ...input, league: null },
        note: say("Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.", "No game with in-game data in this competition: showing all competitions."),
        reason: say("filtre de compétition retiré", "competition filter removed"),
      });
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({ key: `player:${other}`, input: { ...input, player: other }, note: say(`« ${resolved!.mention} » désigne aussi ${other} : stats de ${other}.`, `"${resolved!.mention}" also names ${other}: stats of ${other}.`), reason: say(`alias homonyme essayé : ${other}`, `homonym alias tried: ${other}`) });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const metrics = playerMetricsOf(input);
    const league = await leagueShortName(db, input.league);
    const num = (r: z.infer<typeof IngameRow>, m: PlayerMetric) => (r[m] == null ? null : Number(r[m]));
    const params: Params = {};

    Object.assign(params, { player: input.player });

    const cov = await coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_game_players s JOIN v_games g USING (game_id) WHERE s.player = :player AND ${ingameScope(input, params)}`, params);
    const minute = input.minute ?? 15;
    const val = (m: PlayerMetric) => num(total, m);
    const fb = val("first_bloods");

    const parts: Record<PlayerMetric, string> = {
      solo_kills: `${val("solo_kills") ?? nd()} solo kills`,
      penta_kills: say(`${val("penta_kills") ?? nd()} pentakill${(val("penta_kills") ?? 0) > 1 ? "s" : ""}`, `${val("penta_kills") ?? nd()} pentakill${val("penta_kills") === 1 ? "" : "s"}`),
      quadra_kills: `${val("quadra_kills") ?? nd()} quadrakills`,
      triple_kills: `${val("triple_kills") ?? nd()} triple kills`,
      double_kills: `${val("double_kills") ?? nd()} double kills`,
      first_bloods: fb == null ? say("first bloods n/d", "first bloods n/a") : say(`${fb} first blood${fb > 1 ? "s" : ""} (${pct(fb, total.games)} % des parties)`, `${fb} first blood${fb === 1 ? "" : "s"} (${pct(fb, total.games)}% of games)`),
      kills_before_10: say(`${val("kills_before_10") ?? nd()} kills avant 10 min`, `${val("kills_before_10") ?? nd()} kills before 10 min`),
      gold_diff: say(`un écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min face à son adversaire direct`, `an average gold difference of ${signed(val("gold_diff"))} at ${minute} min against the lane opponent`),
      cs_diff: say(`un écart de CS moyen de ${signed(val("cs_diff"))} à ${minute} min`, `an average CS difference of ${signed(val("cs_diff"))} at ${minute} min`),
      xp_diff: say(`un écart d'XP moyen de ${signed(val("xp_diff"))} à ${minute} min`, `an average XP difference of ${signed(val("xp_diff"))} at ${minute} min`),
      gold: say(`${val("gold") ?? nd()} d'or en moyenne à ${minute} min`, `${val("gold") ?? nd()} gold on average at ${minute} min`),
      cs: say(`${val("cs") ?? nd()} CS en moyenne à ${minute} min`, `${val("cs") ?? nd()} CS on average at ${minute} min`),
      xp: say(`${val("xp") ?? nd()} XP en moyenne à ${minute} min`, `${val("xp") ?? nd()} XP on average at ${minute} min`),
      wards_placed: say(`${val("wards_placed") ?? nd()} wards posées par partie`, `${val("wards_placed") ?? nd()} wards placed per game`),
      wards_killed: say(`${val("wards_killed") ?? nd()} wards détruites par partie`, `${val("wards_killed") ?? nd()} wards killed per game`),
      control_wards: say(`${val("control_wards") ?? nd()} control wards achetées par partie`, `${val("control_wards") ?? nd()} control wards bought per game`),
      plates: say(`${val("plates") ?? nd()} plaques de tourelle`, `${val("plates") ?? nd()} turret plates`),
    };

    const facts =
      `${input.player}${league ? ` ${inLeague(league)}` : ""} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), ` +
      say(`sur ${total.games} parties avec données in-game : ${metrics.map((m) => parts[m]).join(", ")}.`, `over ${total.games} games with in-game data: ${metrics.map((m) => parts[m]).join(", ")}.`) +
      coverageNote(cov);

    const pages = rows.flatMap((r) => r.pages);
    const statsPages = rows.flatMap((r) => r.stats_page ?? []).slice(-3);

    return {
      title: `${say(`${input.player} — stats in-game`, `${input.player} — in-game stats`)}${titleScope(league, input, " (")}`,
      table: {
        columns: [say("Année", "Year"), say("Compétition", "Competition"), say("Parties", "Games"), say("V-D", "W-L"), ...metrics.map((m) => (PLAYER_METRIC_DEFS[m].snapshot ? `${tr(PLAYER_COLUMN_LABELS[m])} @${minute}` : tr(PLAYER_COLUMN_LABELS[m])))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...metrics.map((m) => num(r, m))]),
        focus: input.metric ? (PLAYER_METRIC_DEFS[metrics[0]].snapshot ? `${tr(PLAYER_COLUMN_LABELS[metrics[0]])} @${minute}` : tr(PLAYER_COLUMN_LABELS[metrics[0]])) : undefined,
      },
      facts,
      sources: [
        { label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) },
        ...eventSources(pages, 10),
        ...statsPages.map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })),
        riotDataSource(),
      ],
      followUps: [
        input.league ? say(`Joueurs avec le plus de solo kills ${inLeague(league)}`, `Players with the most solo kills ${inLeague(league)}`) : say("Joueurs avec le plus de solo kills aux Worlds", "Players with the most solo kills at Worlds"),
        say(`Résultats de ${input.player} ${input.league ? inLeague(league) : "aux Worlds"}`, `${input.player}'s results ${input.league ? inLeague(league) : "at Worlds"}`),
      ],
      totals: {
        games: total.games,
        coverage_games: cov.games,
        ...Object.fromEntries(metrics.map((m) => [m, val(m) ?? nd()])),
      },
    };
  },
  normalize: async (db, input) => {
    const p = await resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

const LeaderRow = z.object({ name: z.string(), team: z.string().nullable(), games: z.number(), counted: z.number(), total: z.number().nullable(), average: z.number().nullable() });

function leaderboardMetric(input: LeaderboardInput) {
  if (input.subject === "team") {
    const key = TEAM_METRICS.find((m) => m === input.metric);

    if (!key) throw new Error(say(`Métrique équipe invalide : ${input.metric}`, `Invalid team metric: ${input.metric}`));

    return { def: TEAM_METRIC_DEFS[key], key };
  }

  const key = PLAYER_METRICS.find((m) => m === input.metric);

  if (!key) throw new Error(say(`Métrique joueur invalide : ${input.metric}`, `Invalid player metric: ${input.metric}`));

  return { def: PLAYER_METRIC_DEFS[key], key };
}

function minGamesOf(input: LeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (leaderboardMetric(input).def.aggregate === "sum") return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  return input.league && oneSeason ? 5 : 15;
}

const ingameLeaderboard: ToolDef<LeaderboardInput> = {
  name: "ingame_leaderboard",
  label: phrase("classement sur une stat in-game", "ranking on an in-game stat"),
  description:
    "Ranks players (or teams) of a competition and period on one in-game metric from the Riot game data: solo kills, pentakills, first bloods, " +
    "kills before 10 min, gold/CS/XP difference at 10/15/20 min, wards, plates; teams: first blood/tower/dragon/herald/baron rate, gold difference, " +
    "dragon soul rate, elder dragons. " +
    "Optionally on one side of the map only. Not available for the LPL.",
  plan: async (db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOf(input) });

    const { def } = leaderboardMetric(input);
    const column = `s.${metricColumn(def, input.minute)}`;
    const view = input.subject === "team" ? "v_game_team_stats" : "v_game_player_stats";
    const name = input.subject === "team" ? await franchiseName(db, "s.team", params) : "s.player";
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
      sql: tidy(`SELECT ${name} AS name, ${input.subject === "team" ? "NULL" : latest("s.team", "s.played_at")} AS team, MAX(s.played_at) AS last_game,
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
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: say("Peu de parties par joueur dans ce périmètre : seuil abaissé à 3 parties.", "Few games per player in this scope: threshold lowered to 3 games."), reason: say("seuil de parties abaissé", "game threshold lowered") });

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(LeaderRow).parse(sqlRows);
    const { def } = leaderboardMetric(input);
    const label = metricLabel(def, input.minute);
    const league = await leagueShortName(db, input.league);
    const params: Params = {};
    const scope = ingameScope(input, params);
    const cov = await coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE ${scope}`, params);
    const pages = (await selectAll(db, z.object({ event_page: z.string() }), `SELECT s.event_page FROM v_games s WHERE ${scope} AND s.has_ingame = 1 GROUP BY s.event_page ORDER BY MAX(s.played_at) DESC NULLS LAST LIMIT 12`, params)).map((r) => r.event_page);
    const value = (r: z.infer<typeof LeaderRow>) => (def.aggregate === "sum" ? (r.total ?? 0) : round1(r.average));
    const unit = def.aggregate === "rate" ? say(" %", "%") : "";
    const displayName = (name: string) => input.subject === "team" ? displayTeam(name) : name;
    const who = input.subject === "team" ? say("Équipe", "Team") : say("Joueur", "Player");
    const minGames = minGamesOf(input);
    const years = (await selectAll(db, z.object({ year: z.number().nullable() }), `SELECT DISTINCT s.year FROM v_games s WHERE ${scope} AND s.has_ingame = 1`, params)).flatMap((r) => (r.year == null ? [] : [r.year]));
    const scopeLabel = [inLeague(league), years.length ? `(${yearSpan(years)})` : ""].filter(Boolean).join(" ");
    const roleLabel = say(`${input.role ? ` (rôle ${input.role})` : ""}${sideLabel(input.side)}`, `${input.role ? ` (${input.role} role)` : ""}${sideLabel(input.side)}`);

    const totals: ToolOutput["totals"] = {
      leader: rows[0] ? displayName(rows[0].name) : "",
      leader_value: rows[0] ? (value(rows[0]) ?? 0) : 0,
      rows: rows.length,
      ingame_games: cov.ingame,
    };

    if (def.aggregate === "rate") totals.leader_count = rows[0]?.total ?? 0;

    const facts =
      say(`${def.aggregate === "sum" ? "Total de" : def.aggregate === "rate" ? "Part des parties avec" : "Moyenne par partie de"} ${label}${roleLabel} ${scopeLabel} : `, `${def.aggregate === "sum" ? "Total" : def.aggregate === "rate" ? "Share of games with" : "Average per game of"} ${label}${roleLabel} ${scopeLabel}: `) +
      rows.slice(0, 3).map((r, i) => say(`${i + 1}. ${displayName(r.name)} (${def.aggregate === "rate" ? `${r.total ?? 0} sur ${r.counted} parties, ${value(r)}${unit}` : `${value(r)}${unit}, ${r.games} parties`})`, `${i + 1}. ${displayName(r.name)} (${def.aggregate === "rate" ? `${r.total ?? 0} out of ${r.counted} games, ${value(r)}${unit}` : `${value(r)}${unit}, ${r.games} games`})`)).join(", ") +
      say(`. ${cov.ingame} parties avec données in-game${def.aggregate === "sum" ? "" : `, minimum ${minGames} parties par ${input.subject === "team" ? "équipe" : "joueur"}`}.`, `. ${cov.ingame} games with in-game data${def.aggregate === "sum" ? "" : `, minimum ${minGames} games per ${input.subject === "team" ? "team" : "player"}`}.`) +
      coverageNote(cov);

    return {
      title: `${say(`Classement — ${label}${roleLabel}`, `Ranking — ${label}${roleLabel}`)}${titleScope(league, input, " (")}`,
      table: {
        columns: [say("Rang", "Rank"), who, ...(input.subject === "player" ? [say("Équipe (dernière)", "Team (latest)")] : []), say("Parties", "Games"), ...(def.aggregate === "rate" ? [say("Nombre", "Count")] : []), def.aggregate === "sum" ? "Total" : def.aggregate === "rate" ? "%" : say("Moyenne", "Average"), ...(def.aggregate === "sum" ? [say("Par partie", "Per game")] : [])],
        rows: rows.map((r, i) => [
          i + 1,
          displayName(r.name),
          ...(input.subject === "player" ? [r.team ? displayTeam(r.team) : null] : []),
          def.aggregate === "rate" ? r.counted : r.games,
          ...(def.aggregate === "rate" ? [r.total ?? 0] : []),
          value(r),
          ...(def.aggregate === "sum" ? [Math.round((100 * (r.total ?? 0)) / Math.max(1, r.counted)) / 100] : []),
        ]),
        focus: def.aggregate === "sum" ? "Total" : def.aggregate === "rate" ? "%" : say("Moyenne", "Average"),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.name}`, url: wikiUrl(r.name) })),
        ...eventSources(pages, 12),
        riotDataSource(),
      ],
      followUps: rows.slice(0, 2).map((r) => (input.subject === "team" ? ingameFollowUp.team(displayTeam(r.name)) : ingameFollowUp.player(r.name))),
      totals,
    };
  },
  normalize: async (_db, input) => {
    const valid = input.subject === "team" ? TEAM_METRICS.some((m) => m === input.metric) : PLAYER_METRICS.some((m) => m === input.metric);

    return valid ? input : null;
  },
};

const IN_PROGRESS_DAYS = 30;


async function inProgressNote(db: Db, scope: string, params: Params): Promise<string | null> {
  const rows = await selectAll(
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
    .map((r) => say(`${(r.tournament ?? r.event_page).replace(/ (Main Event|Season)$/, "")} en cours : chiffres sur les ${r.games} parties jouées jusqu'au ${dayFormat().format(new Date(r.last * 1000))}, sans le reste de la compétition.`, `${(r.tournament ?? r.event_page).replace(/ (Main Event|Season)$/, "")} in progress: figures over the ${r.games} games played up to ${dayFormat().format(new Date(r.last * 1000))}, without the rest of the competition.`))
    .join(" ");
}

type CriterionDef = {
  label: Phrase;
  definition: Phrase;
  sql: string;
  total?: true;
  unit?: string;
};

const perMinute = (column: string, digits: number) =>
  `ROUND(60.0 * SUM(CASE WHEN b.length_s > 0 THEN b.${column} END) / SUM(CASE WHEN b.length_s > 0 AND b.${column} IS NOT NULL THEN b.length_s END), ${digits})`;

const teamShare = (column: string) =>
  `ROUND(100.0 * SUM(CASE WHEN b.team_${column} > 0 THEN b.${column} END) / SUM(CASE WHEN b.team_${column} > 0 AND b.${column} IS NOT NULL THEN b.team_${column} END), 1)`;

export const PLAYER_CRITERION_DEFS: Record<PlayerCriterion, CriterionDef> = {
  kda: { label: phrase("KDA", "KDA"), definition: phrase("(kills + assists) / morts, sur toutes leurs parties", "(kills + assists) / deaths, over all their games"), sql: `ROUND(1.0 * ${kaSum("b")} / ${atLeast(1, deathsSum("b"))}, 2)` },
  winrate: { label: phrase("% victoires", "win %"), definition: phrase("victoires / parties", "wins / games"), sql: "ROUND(100.0 * SUM(b.win) / COUNT(*), 1)", unit: " %" },
  games: { label: phrase("parties", "games"), definition: phrase("nombre de parties jouées", "number of games played"), sql: "COUNT(*)", total: true },
  kills: { label: phrase("kills", "kills"), definition: phrase("total des kills", "total kills"), sql: "SUM(b.kills)", total: true },
  assists: { label: phrase("assists", "assists"), definition: phrase("total des assists", "total assists"), sql: "SUM(b.assists)", total: true },
  kp: {
    label: phrase("KP %", "KP %"),
    definition: phrase("participation aux kills, (kills + assists) / kills de l'équipe", "kill participation, (kills + assists) / team kills"),
    sql: "ROUND(100.0 * SUM(CASE WHEN b.team_kills > 0 THEN b.kills + b.assists END) / SUM(CASE WHEN b.team_kills > 0 AND b.kills IS NOT NULL AND b.assists IS NOT NULL THEN b.team_kills END), 1)",
    unit: " %",
  },
  dmg_share: { label: phrase("DMG %", "DMG %"), definition: phrase("part des dégâts aux champions de son équipe", "share of their team's damage to champions"), sql: teamShare("damage"), unit: " %" },
  gold_share: { label: phrase("or %", "gold %"), definition: phrase("part de l'or de son équipe", "share of their team's gold"), sql: teamShare("gold"), unit: " %" },
  dpm: { label: phrase("DPM", "DPM"), definition: phrase("dégâts aux champions par minute", "damage to champions per minute"), sql: perMinute("damage", 0) },
  cspm: { label: phrase("CS/min", "CS/min"), definition: phrase("CS par minute", "CS per minute"), sql: perMinute("cs", 2) },
  gpm: { label: phrase("or/min", "gold/min"), definition: phrase("or gagné par minute", "gold earned per minute"), sql: perMinute("gold", 0) },
  vspm: { label: phrase("vision/min", "vision/min"), definition: phrase("score de vision par minute", "vision score per minute"), sql: perMinute("vision", 2) },
};

const LEADERBOARD_COLUMNS: PlayerCriterion[] = ["kda", "winrate", "kp", "dmg_share", "gold_share", "dpm", "cspm", "gpm", "vspm"];

const PlayerLeaderRow = z
  .object({ player: Text, team: NullableText, games: z.number(), wins: z.number(), gold_diff_15: z.number().nullable(), ingame_games: z.number() })
  .catchall(z.number().nullable());

const isInternational = (league: string | null) => LEAGUES.some((l) => l.name === league && l.international);

export function minGamesOfLeaderboard(input: PlayerLeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (PLAYER_CRITERION_DEFS[input.criterion].total) return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  if (input.league && oneSeason) return isInternational(input.league) ? 5 : 10;

  return 20;
}

const playerLeaderboard: ToolDef<PlayerLeaderboardInput> = {
  name: "player_leaderboard",
  label: phrase("classement de joueurs", "player ranking"),
  description:
    "Ranks the players of a competition and period, optionally of one role (top, jungle, mid, ADC/bot, support), on an explicit criterion " +
    "from the end-of-game stats: KDA (default for 'best'), win rate, games, total kills or assists, kill participation, share of the team's damage or gold, " +
    "damage, CS, gold or vision per minute. Optionally on one side of the map only ('côté bleu', 'red side'). " +
    "A minimum of games applies to rates and averages. Use it for 'best mids LEC 2025', 'meilleur jungler', 'top 5 ADC', 'quel support a le meilleur KDA'. " +
    "For in-game metrics (gold difference at 15, solo kills, first bloods, wards) use ingame_leaderboard.",
  plan: async (_db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOfLeaderboard(input) });
    const order = PLAYER_CRITERION_DEFS[input.criterion].sql;
    const stats = [...new Set<PlayerCriterion>([input.criterion, ...LEADERBOARD_COLUMNS])];

    return {
      params,
      sql: tidy(`WITH p AS (
  SELECT p.game_id, p.player, p.team, p.played_at, p.win, p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision
  FROM v_game_players p WHERE ${rankingScope("p", input, params)}
),
team_kills AS (
  SELECT t.game_id, t.team, SUM(t.kills) AS team_kills, SUM(t.damage) AS team_damage, SUM(t.gold) AS team_gold FROM v_game_players t
  WHERE t.game_id IN (SELECT game_id FROM p) GROUP BY t.game_id, t.team
),
lengths AS (SELECT g.game_id, g.length_s FROM v_games g WHERE g.game_id IN (SELECT game_id FROM p)),
st AS (
  SELECT s.game_id, s.player, s.gold_diff_15 FROM v_game_player_stats s WHERE ${rankingScope("s", input, params)}
),
b AS (
  SELECT p.*, tk.team_kills, tk.team_damage, tk.team_gold, l.length_s, st.gold_diff_15
  FROM p LEFT JOIN team_kills tk ON tk.game_id = p.game_id AND tk.team = p.team
  LEFT JOIN lengths l ON l.game_id = p.game_id
  LEFT JOIN st ON st.game_id = p.game_id AND st.player = p.player
)
SELECT b.player, ${latest("b.team", "b.played_at")} AS team, MAX(b.played_at) AS last_game, COUNT(*) AS games, SUM(b.win) AS wins,
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
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: say("Peu de parties par joueur dans ce périmètre : seuil abaissé à 3 parties.", "Few games per player in this scope: threshold lowered to 3 games."), reason: say("seuil de parties abaissé", "game threshold lowered") });

    if (hasPeriod(input)) out.push(noPeriod(input, input.split ? say(`toutes les saisons (split ${input.split})`, `every season (${input.split} split)`) : say("toutes les saisons", "every season")));

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(PlayerLeaderRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const scope = rankingScopeLabel(league, input);
    const followUpScope = scopeLabel(league, input);
    const def = PLAYER_CRITERION_DEFS[input.criterion];
    const minGames = minGamesOfLeaderboard(input);
    const who = `${input.role ? tr(ROLE_PLAYERS[input.role]) : say("joueurs", "players")}${sideLabel(input.side)}`;
    const columns = [...new Set<PlayerCriterion>([input.criterion, ...LEADERBOARD_COLUMNS])].filter((c) => c !== "games");
    const value = (r: z.infer<typeof PlayerLeaderRow>, c: PlayerCriterion) => r[c] ?? null;
    const ingame = rows.reduce((n, r) => n + r.ingame_games, 0);
    const all = rows.reduce((n, r) => n + r.games, 0);
    const params: Params = {};

    const pages = (await selectAll(
      db,
      z.object({ event_page: Text }),
      `SELECT p.event_page FROM v_game_players p WHERE ${rankingScope("p", input, params)} GROUP BY p.event_page ORDER BY MAX(p.played_at) DESC NULLS LAST LIMIT 12`,
      params,
    )).map((r) => r.event_page);

    const gameParams: Params = {};
    const ongoing = await inProgressNote(db, rankingScope("g", { ...leagueAndPeriod(input), split: input.split }, gameParams), gameParams);

    const line = (r: z.infer<typeof PlayerLeaderRow>, i: number) =>
      say(`${i + 1}. ${r.player}${r.team ? ` (${displayTeam(r.team)})` : ""} : ${frNumber(value(r, input.criterion))}${def.unit ?? ""}${input.criterion === "games" ? " parties" : `, ${r.games} parties`}`, `${i + 1}. ${r.player}${r.team ? ` (${displayTeam(r.team)})` : ""}: ${frNumber(value(r, input.criterion))}${unitEn(def.unit)}${input.criterion === "games" ? " games" : `, ${r.games} games`}`);

    const facts =
      say(`${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} avec le plus de ${tr(def.label)}` : `Meilleurs ${who}`} ${scope || allCompetitions()} selon le critère ${tr(def.label)} (${tr(def.definition)})`, `${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} with the most ${tr(def.label)}` : `Best ${who}`} ${scope || allCompetitions()} by ${tr(def.label)} (${tr(def.definition)})`) +
      say(`${minGames > 1 ? `, minimum ${minGames} parties` : ""} : ${rows.slice(0, 3).map(line).join(" ; ")}. ${rows.length} joueurs classés.`, `${minGames > 1 ? `, minimum ${minGames} games` : ""}: ${rows.slice(0, 3).map(line).join("; ")}. ${rows.length} players ranked.`) +
      (ingame === 0
        ? say(" Écart d'or à 15 min n/d : aucune partie avec données Riot dans ce périmètre.", " Gold difference at 15 min n/a: no game with Riot data in this scope.")
        : ingame < all
          ? say(` Écart d'or à 15 min calculé sur les ${ingame} parties avec données Riot seulement (sur ${all}).`, ` Gold difference at 15 min computed over the ${ingame} games with Riot data only (out of ${all}).`)
          : "") +
      (ongoing ? ` ${ongoing}` : "");

    return {
      title: `${say(`${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} avec le plus de ${tr(def.label)}` : input.role ? `Meilleurs ${who}` : "Classement des joueurs"} — ${tr(def.label)}`, `${def.total ? `${who.replace(/^./, (c) => c.toUpperCase())} with the most ${tr(def.label)}` : input.role ? `Best ${who}` : "Player ranking"} — ${tr(def.label)}`)}${rankingTitleScope(league, input, " (")}`,
      table: {
        columns: [say("Rang", "Rank"), say("Joueur", "Player"), say("Équipe", "Team"), say("Parties", "Games"), ...columns.map((c) => tr(PLAYER_CRITERION_DEFS[c].label)), say("Écart or @15", "Gold diff @15")],
        rows: rows.map((r, i) => [i + 1, r.player, r.team ? displayTeam(r.team) : null, r.games, ...columns.map((c) => value(r, c)), r.gold_diff_15]),
        focus: input.criterion === "games" ? say("Parties", "Games") : tr(PLAYER_CRITERION_DEFS[input.criterion].label),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.player}`, url: wikiUrl(r.player) })),
        ...eventSources(pages, 12),
        ...(ingame ? [riotDataSource()] : []),
      ],
      followUps: [
        ...(rows.length >= 2 ? [`${rows[0].player} vs ${rows[1].player}${followUpScope ? ` ${followUpScope}` : ""}`] : []),
        ...(input.role && ingame > 0 ? [say(`Écart d'or à 15 min des ${tr(ROLE_PLAYERS[input.role])} ${inLeague(league) || "aux Worlds"}`, `Gold difference at 15 min of ${tr(ROLE_PLAYERS[input.role])} ${inLeague(league) || "at Worlds"}`)] : []),
        ...rows.slice(0, 1).map((r) => ingameFollowUp.player(r.player)),
      ],
      totals: {
        leader: rows[0]?.player ?? "",
        leader_value: rows[0] ? (value(rows[0], input.criterion) ?? nd()) : nd(),
        leader_games: rows[0]?.games ?? 0,
        rows: rows.length,
        min_games: minGames,
        criterion: input.criterion,
        leader_gold_diff_15: rows[0]?.gold_diff_15 ?? nd(),
        in_progress: ongoing ? "yes" : "no",
      },
    };
  },
  normalize: (_db, input) => ({ ...input, minGames: input.minGames != null && input.minGames >= 3 ? input.minGames : null }),
};

const TEAM_OVERVIEW: TeamMetric[] = ["first_blood", "first_tower", "first_dragon", "first_herald", "first_baron", "dragon_soul", "gold_diff", "kills_before_10", "plates"];

const TEAM_COLUMN_LABELS: Record<TeamMetric, Phrase> = {
  first_blood: phrase("First blood %", "First blood %"),
  first_tower: phrase("1re tour %", "1st tower %"),
  first_dragon: phrase("1er dragon %", "1st dragon %"),
  first_herald: phrase("1er héraut %", "1st herald %"),
  first_baron: phrase("1er baron %", "1st baron %"),
  gold_diff: phrase("Écart or", "Gold diff"),
  kills_before_10: phrase("Kills < 10 min", "Kills < 10 min"),
  plates: phrase("Plaques / partie", "Plates / game"),
  dragon_soul: phrase("Âme %", "Soul %"),
  elder_dragons: phrase("Dragons ancestraux", "Elder dragons"),
};

const teamIngameStats: ToolDef<TeamIngameInput> = {
  name: "team_ingame_stats",
  label: phrase("stats in-game d'une équipe", "in-game stats of a team"),
  description:
    "A team's in-game profile from the Riot game data, season by season: first blood, first tower, dragon, herald and baron rates, dragon soul rate, " +
    "team gold difference at 10/15/20 min, turret plates. Renamed teams are merged. Not available for the LPL.",
  plan: async (db, input) => {
    const params: Params = {};
    const t = inList("t", (await teamMembers(db, input.team)).members, params);
    const cols = TEAM_OVERVIEW.map((m) => `${aggregateSql(TEAM_METRIC_DEFS[m].aggregate, `s.${metricColumn(TEAM_METRIC_DEFS[m], input.minute)}`)} AS ${m}`).join(",\n         ");
    const scope = ingameScope(input, params);

    return {
      params,
      sql: tidy(`WITH base AS (
  SELECT * FROM v_game_team_stats s WHERE s.team IN (${t}) AND ${scope}
)
SELECT 0 AS is_total, s.year, s.league_short, MIN(s.played_at) AS first_game, COUNT(*) AS games, SUM(s.win) AS wins,
       ${cols},
       COALESCE(json_agg(DISTINCT s.event_page), '[]'::json) AS pages, MAX(s.stats_page) AS stats_page
FROM base s GROUP BY s.year, s.league_short
UNION ALL
SELECT 1, NULL, NULL, NULL, COUNT(*), SUM(s.win),
       ${cols},
       NULL, NULL
FROM base s
HAVING COUNT(*) > 0
ORDER BY is_total, first_game NULLS FIRST`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: say("Aucune partie avec données in-game dans cette compétition : affichage de toutes les compétitions.", "No game with in-game data in this competition: showing all competitions."), reason: say("filtre de compétition retiré", "competition filter removed") });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const all = z.array(IngameRow).parse(sqlRows);
    const total = all[all.length - 1];
    const rows = all.slice(0, -1);
    const { team, members } = await teamMembers(db, input.team);
    const league = await leagueShortName(db, input.league);
    const minute = input.minute ?? 15;
    const val = (m: TeamMetric) => (total[m] == null ? null : Number(total[m]));
    const params: Params = {};
    const t = inList("t", members, params);
    const cov = await coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE (s.blue_team IN (${t}) OR s.red_team IN (${t})) AND ${ingameScope(input, params)}`, params);

    const facts =
      say(`${team}${league ? ` ${inLeague(league)}` : ""} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), sur ${total.games} parties avec données in-game `, `${team}${league ? ` ${inLeague(league)}` : ""} (${yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year])))}), over ${total.games} games with in-game data `) +
      say(`(${total.wins} victoires) : first blood dans ${val("first_blood") ?? nd()} % des parties, première tourelle ${val("first_tower") ?? nd()} %, `, `(${total.wins} wins): first blood in ${val("first_blood") ?? nd()}% of games, first tower ${val("first_tower") ?? nd()}%, `) +
      say(`premier dragon ${val("first_dragon") ?? nd()} %, premier héraut ${val("first_herald") ?? nd()} %, premier baron ${val("first_baron") ?? nd()} %, `, `first dragon ${val("first_dragon") ?? nd()}%, first herald ${val("first_herald") ?? nd()}%, first baron ${val("first_baron") ?? nd()}%, `) +
      say(`${val("dragon_soul") == null ? "" : `âme du dragon ${val("dragon_soul")} %, `}`, `${val("dragon_soul") == null ? "" : `dragon soul ${val("dragon_soul")}%, `}`) +
      say(`écart d'or moyen de ${signed(val("gold_diff"))} à ${minute} min, ${val("kills_before_10") ?? nd()} kills avant 10 min et ${val("plates") ?? nd()} plaques de tourelle prises par partie.`, `average gold difference of ${signed(val("gold_diff"))} at ${minute} min, ${val("kills_before_10") ?? nd()} kills before 10 min and ${val("plates") ?? nd()} turret plates taken per game.`) +
      coverageNote(cov);

    return {
      title: `${say(`${team} — stats in-game`, `${team} — in-game stats`)}${titleScope(league, input, " (")}`,
      table: {
        columns: [say("Année", "Year"), say("Compétition", "Competition"), say("Parties", "Games"), say("V-D", "W-L"), ...TEAM_OVERVIEW.map((m) => (m === "gold_diff" ? say(`Écart or @${minute}`, `Gold diff @${minute}`) : tr(TEAM_COLUMN_LABELS[m])))],
        rows: rows.map((r) => [r.year, r.league_short, r.games, `${r.wins}-${r.games - r.wins}`, ...TEAM_OVERVIEW.map((m) => (r[m] == null ? null : Number(r[m])))]),
        focus: input.metric && TEAM_OVERVIEW.includes(input.metric) ? (input.metric === "gold_diff" ? say(`Écart or @${minute}`, `Gold diff @${minute}`) : tr(TEAM_COLUMN_LABELS[input.metric])) : undefined,
      },
      facts,
      sources: [
        ...members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })),
        ...eventSources(rows.flatMap((r) => r.pages), 10),
        riotDataSource(),
      ],
      followUps: [say(`Historique de ${team}`, `${team} history`), say(`Équipes qui prennent le plus souvent le first blood ${input.league ? inLeague(league) : "aux Worlds"}`, `Teams that take first blood most often ${input.league ? inLeague(league) : "at Worlds"}`)],
      totals: { games: total.games, wins: total.wins, ...Object.fromEntries(TEAM_OVERVIEW.map((m) => [m, val(m) ?? nd()])) },
    };
  },
  normalize: async (db, input) => {
    const t = await resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

const DragonRow = z.object({ kind: z.string().nullable(), dragons: z.number(), souls: z.number(), soul_wins: z.number() });

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const dragonTeams = async (db: Db, alias: string, team: string | null, params: Params) =>
  team ? `AND ${alias}.team IN (${inList("t", (await teamMembers(db, team)).members, params)})` : "";

const dragonStats: ToolDef<DragonStatsInput> = {
  name: "dragon_stats",
  label: phrase("dragons par élément et âmes", "dragons by element and souls"),
  description:
    "Dragons killed by element (infernal, ocean, mountain, cloud, hextech, chemtech, elder) and dragon souls taken, with the win rate of the teams " +
    "that got each soul, in a competition and period, for every team or for one team. From the Riot game data: elements from 2016, souls from 2020. " +
    "Not available for the LPL. For the teams that take the soul most often use ingame_leaderboard (metric dragon_soul).",
  plan: async (db, input) => {
    const params: Params = {};
    const scope = leagueAndPeriod(input);

    return {
      params,
      sql: tidy(`WITH kills AS (
  SELECT d.dragon AS kind, COUNT(*) AS dragons
  FROM v_game_dragons d
  WHERE ${competitionScope("d", scope, params)} ${await dragonTeams(db, "d", input.team, params)}
  GROUP BY d.dragon
),
souls AS (
  SELECT s.soul AS kind, COUNT(*) AS souls, SUM(s.win) AS soul_wins
  FROM v_game_team_stats s
  WHERE s.soul IS NOT NULL AND ${competitionScope("s", scope, params)} ${await dragonTeams(db, "s", input.team, params)}
  GROUP BY s.soul
)
SELECT k.kind, k.dragons, COALESCE(s.souls, 0) AS souls, COALESCE(s.soul_wins, 0) AS soul_wins
FROM kills k LEFT JOIN souls s ON s.kind = k.kind
ORDER BY (k.kind IS NULL), (k.kind = 'elder'), k.dragons DESC, k.kind`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.team && input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: say("Aucun dragon relevé dans cette compétition : affichage de toutes les compétitions.", "No dragon recorded in this competition: showing all competitions."), reason: say("filtre de compétition retiré", "competition filter removed") });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(DragonRow).parse(sqlRows);
    const team = input.team ? await teamMembers(db, input.team) : null;
    const league = await leagueShortName(db, input.league);
    const params: Params = {};
    const scope = competitionScope("s", leagueAndPeriod(input), params);
    const own = await dragonTeams(db, "s", input.team, params);

    const known = await selectOne(
      db,
      z.object({ games: z.number(), souls: z.number().nullable() }),
      `SELECT COUNT(DISTINCT s.game_id) AS games, SUM(s.dragon_soul) AS souls
       FROM v_game_team_stats s WHERE s.dragon_soul IS NOT NULL AND ${scope} ${own}`,
      params,
    );

    const games = await selectOne(
      db,
      z.object({ games: z.number(), pages: z.array(z.string()), years: z.array(z.number().nullable()) }),
      `SELECT COUNT(DISTINCT s.game_id) AS games, COALESCE(json_agg(DISTINCT s.event_page), '[]'::json) AS pages, COALESCE(json_agg(DISTINCT s.year), '[]'::json) AS years FROM v_game_dragons s WHERE ${scope} ${own}`,
      params,
    );

    const covParams: Params = {};
    const covTeam = team ? `AND (s.blue_team IN (${inList("t", team.members, covParams)}) OR s.red_team IN (${inList("t", team.members, covParams)}))` : "";
    const cov = await coverage(db, `SELECT COUNT(*) AS games, SUM(has_ingame) AS ingame FROM v_games s WHERE ${competitionScope("s", leagueAndPeriod(input), covParams)} ${covTeam}`, covParams);
    const years = (games?.years ?? []).flatMap((y) => (y == null ? [] : [y]));
    const pages = games?.pages ?? [];
    const total = rows.reduce((n, r) => n + r.dragons, 0);
    const elder = rows.find((r) => r.kind === "elder")?.dragons ?? 0;
    const elemental = rows.filter((r) => r.kind != null && r.kind !== "elder");
    const bySouls = [...elemental].filter((r) => r.souls > 0).sort((a, b) => b.souls - a.souls || a.dragons - b.dragons);
    const souls = known?.souls ?? 0;
    const soulWins = elemental.reduce((n, r) => n + r.soul_wins, 0);
    const soulGames = known?.games ?? 0;
    const who = team ? team.team : say("les équipes", "teams");
    const where = [inLeague(league), years.length ? `(${yearSpan(years)})` : ""].filter(Boolean).join(" ");
    const name = (kind: string | null) => capital(dragonLabel(kind));

    const facts =
      say(`Dragons pris par ${who}${where ? ` ${where}` : ""}, sur ${games?.games ?? 0} parties avec chronologie Riot : ${total} dragons (`, `Dragons taken by ${who}${where ? ` ${where}` : ""}, over ${games?.games ?? 0} games with a Riot timeline: ${total} dragons (`) +
      say(`${elemental.map((r) => `${dragonLabel(r.kind)} ${r.dragons}`).join(", ")}${elder ? `, ancestral ${elder}` : ""}). `, `${elemental.map((r) => `${dragonLabel(r.kind)} ${r.dragons}`).join(", ")}${elder ? `, elder ${elder}` : ""}). `) +
      (soulGames
        ? (team
            ? say(`${team.team} prend l'âme du dragon dans ${souls} de ses ${soulGames} parties (${pct(souls, soulGames)} %)`, `${team.team} takes the dragon soul in ${souls} of its ${soulGames} games (${pct(souls, soulGames)}%)`)
            : say(`L'âme du dragon est prise dans ${souls} parties sur ${soulGames} (${pct(souls, soulGames)} %)`, `The dragon soul is taken in ${souls} games out of ${soulGames} (${pct(souls, soulGames)}%)`)) +
          (souls
            ? say(`${team ? " et en gagne" : " ; l'équipe qui la prend gagne"} ${soulWins} sur ${souls} (${pct(soulWins, souls)} %). `, `${team ? " and wins" : "; the team that takes it wins"} ${soulWins} out of ${souls} (${pct(soulWins, souls)}%). `) +
              say(`Âmes : ${bySouls.map((r) => `${dragonLabel(r.kind)} ${r.souls}`).join(", ")}.`, `Souls: ${bySouls.map((r) => `${dragonLabel(r.kind)} ${r.souls}`).join(", ")}.`)
            : ".")
        : say("Aucune partie de ce périmètre où l'âme existe (elle date du patch 9.23, fin 2019) avec une chronologie.", "No game of this scope where the soul exists (it dates from patch 9.23, late 2019) with a timeline.")) +
      coverageNote(cov);

    return {
      title: `${say(`${team ? `${team.team} — dragons et âmes` : "Dragons et âmes"}`, `${team ? `${team.team} — dragons and souls` : "Dragons and souls"}`)}${titleScope(league, input, " (")}`,
      table: {
        columns: ["Dragon", say("Pris", "Taken"), say("Part %", "Share %"), say("Âmes", "Souls"), say("Victoires avec l'âme", "Wins with the soul"), say("% victoire avec l'âme", "Win % with the soul")],
        rows: rows.map((r) => {
          const soul = r.kind != null && r.kind !== "elder";

          return [name(r.kind), r.dragons, Math.round((1000 * r.dragons) / Math.max(1, total)) / 10, soul ? r.souls : null, soul ? r.soul_wins : null, soul && r.souls ? pct(r.soul_wins, r.souls) : null];
        }),
      },
      icons: Object.fromEntries(rows.map((r) => [name(r.kind), wikiImageUrl(isDragonKind(r.kind) ? DRAGON_ICON_FILES[r.kind] : PLAIN_DRAGON_ICON_FILE, 48)])),
      facts,
      sources: [...(team ? team.members.map((m) => ({ label: `Leaguepedia — ${m}`, url: wikiUrl(m) })) : []), ...eventSources(pages, 12), riotDataSource()],
      followUps: [
        say(`Équipes qui prennent le plus souvent l'âme du dragon ${input.league ? inLeague(league) : "aux Worlds"}`, `Teams that take the dragon soul most often ${input.league ? inLeague(league) : "at Worlds"}`),
        ...(team ? [ingameFollowUp.team(team.team)] : []),
      ],
      totals: {
        dragons: total,
        elder_dragons: elder,
        top_dragon: elemental[0] ? dragonLabel(elemental[0].kind) : "",
        top_dragon_count: elemental[0]?.dragons ?? 0,
        soul_games: soulGames,
        souls,
        soul_wins: soulWins,
        top_soul: bySouls[0] ? dragonLabel(bySouls[0].kind) : "",
        top_soul_count: bySouls[0]?.souls ?? 0,
      },
    };
  },
  normalize: async (db, input) => {
    if (!input.team) return { ...input, team: null };
    const t = await resolveTeam(db, input.team);

    return t ? { ...input, team: t.team } : null;
  },
};

const PHASE_SQL: Record<GamePhase, string> = {
  final: "g.tab IN ('Finals', 'Final', 'Grand Finals', 'Grand Final')",
  semifinal: "g.tab IN ('Semifinals', 'Semifinal')",
  quarterfinal: "g.tab IN ('Quarterfinals', 'Quarterfinal')",
  third_place: "g.tab ILIKE 'Third-Place%'",
  groups: "(g.tab ILIKE 'Group%' OR g.tab ILIKE 'Swiss%' OR (g.stage = 'main_event' AND (g.tab ILIKE 'Day %' OR g.tab ~ '^Round [0-9]')))",
  play_in: "(g.stage = 'play_in' OR g.tab ILIKE 'Play-In%')",
};

const PHASE_LABEL: Record<GamePhase, Phrase> = {
  final: phrase("finale", "final"),
  semifinal: phrase("demi-finale", "semifinal"),
  quarterfinal: phrase("quart de finale", "quarterfinal"),
  third_place: phrase("match pour la 3e place", "third-place match"),
  groups: phrase("phase de groupes", "group stage"),
  play_in: phrase("play-in", "play-in"),
};


const TAB_LABELS = new Map([
  ["Finals", phrase("finale", "final")],
  ["Final", phrase("finale", "final")],
  ["Grand Finals", phrase("grande finale", "grand final")],
  ["Grand Final", phrase("grande finale", "grand final")],
  ["Semifinals", phrase("demi-finale", "semifinal")],
  ["Semifinal", phrase("demi-finale", "semifinal")],
  ["Quarterfinals", phrase("quart de finale", "quarterfinal")],
  ["Quarterfinal", phrase("quart de finale", "quarterfinal")],
  ["Third-Place Match", phrase("match pour la 3e place", "third-place match")],
  ["Tiebreakers", phrase("départage", "tiebreakers")],
]);

export function tabLabel(tab: string | null): string {
  if (!tab) return "";

  const fixed = TAB_LABELS.get(tab);

  if (fixed) return tr(fixed);

  return say(frenchTab(tab), tab.replace(/^[A-Za-z-]+(?: Round)?/, (words) => words.toLowerCase()));
}

function frenchTab(tab: string): string {
  return tab
    .replace(/^Week (\d+)/, "semaine $1")
    .replace(/^Day (\d+)/, "jour $1")
    .replace(/^Bracket Round (\d+)/, "tour $1 du bracket")
    .replace(/^Round (\d+)/, "tour $1")
    .replace(/^Group Stage(?![\p{L}])/u, "phase de groupes")
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

type SeriesNaming = Pick<TimelineGameRow, "league_short" | "year" | "tab" | "tournament">;

const seriesKey = (r: Pick<TimelineGameRow, "tournament_page" | "tab" | "match_n">) => `${r.tournament_page}|${r.tab}|${r.match_n}`;

const seriesLabel = (r: SeriesNaming) => [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · ");

function seriesPhrase(r: SeriesNaming): string {
  const tab = tabLabel(r.tab);
  const event = `${r.league_short}${r.year ? ` ${r.year}` : ""}`;

  return say(
    tab ? `${/^(semaine|journée|jour|tour)/.test(tab) ? "" : /^(quart|match)/.test(tab) ? "le " : "la "}${tab} ${ofEvent(r)}` : (r.tournament ?? event),
    tab ? `${/^(week|day|round|bracket|group|tiebreak)/.test(tab) ? "" : "the "}${tab} ${ofEvent(r)}` : (r.tournament ?? event),
  );
}

const thousands = (n: number) => say(Math.abs(n).toLocaleString("fr-FR").replace(/ | /g, " "), Math.abs(n).toLocaleString("en-US"));

const signedGold = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${thousands(n)}`;

const KIND_COUNT: { kind: ParsedTimeline["events"][number]["kind"]; one: Phrase; many: Phrase }[] = [
  { kind: "tower", one: phrase("tour", "tower"), many: phrase("tours", "towers") },
  { kind: "dragon", one: phrase("dragon", "dragon"), many: phrase("dragons", "dragons") },
  { kind: "baron", one: phrase("baron", "baron"), many: phrase("barons", "barons") },
  { kind: "inhibitor", one: phrase("inhibiteur", "inhibitor"), many: phrase("inhibiteurs", "inhibitors") },
];

const TOWER_TIER_LABELS: Record<TowerTier, Phrase> = {
  outer: phrase("extérieure", "outer"),
  inner: phrase("intérieure", "inner"),
  inhibitor: phrase("d'inhibiteur", "inhibitor"),
  nexus: phrase("du Nexus", "Nexus"),
};

export function eventDetail(detail: EventDetail | null): string | null {
  if (detail == null) return null;

  if ("grubs" in detail) return say(detail.grubs === 1 ? "1 larve" : `${detail.grubs} larves`, detail.grubs === 1 ? "1 grub" : `${detail.grubs} grubs`);

  if ("dragon" in detail) return dragonLabel(detail.dragon);

  if ("tower" in detail) return [detail.tower ? tr(TOWER_TIER_LABELS[detail.tower]) : null, detail.lane].filter(Boolean).join(" ") || null;

  return detail.lane;
}

const sideOf = (team: RiotTeam, swapped: boolean): Side => ((team === 100) !== swapped ? "blue" : "red");

function timelineView(r: TimelineGameRow, t: ParsedTimeline): TimelineView {
  const swapped = r.side_swapped === 1;
  const sign = swapped ? -1 : 1;

  return {
    label: `${seriesLabel(r)}${r.game_n ? ` · game ${r.game_n}` : ""}`,
    blue: displayTeam(r.blue_team ?? say("Bleu", "Blue")),
    red: displayTeam(r.red_team ?? say("Rouge", "Red")),
    winner: t.winner ? sideOf(t.winner, swapped) : null,
    durationS: t.durationS,
    version: t.version,
    gold: t.gold.map((g) => ({ s: g.s, diff: sign * g.diff })),
    events: t.events.map((e) => ({ s: e.s, kind: e.kind, side: sideOf(e.team, swapped), detail: eventDetail(e.detail) })),
  };
}

function timelineFacts(r: TimelineGameRow, v: TimelineView): string {
  const name = (side: Side) => (side === "blue" ? v.blue : v.red);
  const winner = v.winner ? name(v.winner) : null;
  const at15 = v.gold.find((g) => g.s >= 15 * 60 - 30 && g.s <= 15 * 60 + 30);
  const peak = v.gold.reduce((best, g) => (Math.abs(g.diff) > Math.abs(best.diff) ? g : best), v.gold[0]);
  const fb = v.events.find((e) => e.kind === "first_blood");
  const lead = (diff: number) => (diff === 0 ? say("égalité", "even") : say(`${signedGold(Math.abs(diff))} pour ${name(diff > 0 ? "blue" : "red")}`, `${signedGold(Math.abs(diff))} for ${name(diff > 0 ? "blue" : "red")}`));

  const counts = (["blue", "red"] as const).map(
    (side) =>
      `${name(side)} ${KIND_COUNT.map((k) => {
        const n = v.events.filter((e) => e.side === side && (e.kind === k.kind || (k.kind === "dragon" && e.kind === "elder"))).length;

        return `${n} ${tr(say(n > 1 ? k.many : k.one, n === 1 ? k.one : k.many))}`;
      }).join(", ")}`,
  );

  return (
    say(`Game ${r.game_n ?? "?"} de ${seriesPhrase(r)}, ${v.blue} (bleu) contre ${v.red} (rouge) : `, `Game ${r.game_n ?? "?"} of ${seriesPhrase(r)}, ${v.blue} (blue) against ${v.red} (red): `) +
    say(`${winner ? `victoire de ${winner}` : "vainqueur inconnu"}${v.durationS ? ` en ${clock(v.durationS)}` : ""}`, `${winner ? `won by ${winner}` : "winner unknown"}${v.durationS ? ` in ${clock(v.durationS)}` : ""}`) +
    say(`${fb ? `, first blood pour ${name(fb.side)} à ${clock(fb.s)}` : ""}`, `${fb ? `, first blood for ${name(fb.side)} at ${clock(fb.s)}` : ""}`) +
    say(`${at15 ? `, écart d'or à 15 min : ${lead(at15.diff)}` : ""}`, `${at15 ? `, gold difference at 15 min: ${lead(at15.diff)}` : ""}`) +
    say(`${peak && peak.diff !== 0 ? `, écart maximal ${lead(peak.diff)} à ${clock(peak.s)}` : ""}. `, `${peak && peak.diff !== 0 ? `, largest lead ${lead(peak.diff)} at ${clock(peak.s)}` : ""}. `) +
    say(`Objectifs : ${counts.join(" ; ")}.`, `Objectives: ${counts.join("; ")}.`)
  );
}

const gameSources = (r: TimelineGameRow): Source[] => [
  ...(r.stats_page
    ? [
        { label: say(`Leaguepedia — page de la partie (${r.stats_page})`, `Leaguepedia — game page (${r.stats_page})`), url: wikiUrl(r.stats_page) },
        { label: say(`Leaguepedia — timeline de la partie (${r.stats_page}/Timeline)`, `Leaguepedia — game timeline (${r.stats_page}/Timeline)`), url: wikiUrl(`${r.stats_page}/Timeline`) },
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
  spell1: NullableText,
  spell2: NullableText,
  spell1_icon: NullableText,
  spell2_icon: NullableText,
});

const ScoreboardRuneRow = z.object({ player: Text, slot: z.number(), kind: z.enum(RUNE_KINDS), rune: Text, icon_url: NullableText });

const ScoreboardItemRow = z.object({ player: Text, item: Text, icon_url: Text });

const teamSum = (players: ScoreboardPlayer[], key: "kills" | "gold") =>
  players.some((p) => p[key] != null) ? players.reduce((n, p) => n + (p[key] ?? 0), 0) : null;

async function gameScoreboard(db: Db, r: TimelineGameRow): Promise<GameScoreboard | null> {
  const game = await selectOne(
    db,
    ScoreboardGameRow,
    `SELECT patch, winner_side, blue_towers, red_towers, blue_inhibitors, red_inhibitors, blue_dragons, red_dragons,
            blue_barons, red_barons, blue_heralds, red_heralds, blue_void_grubs, red_void_grubs
     FROM games WHERE id = :game`,
    { game: r.game_id },
  );

  const rows = await selectAll(
    db,
    ScoreboardPlayerRow,
    `SELECT p.side, p.role, p.player, p.champion, c.icon_url AS champion_icon,
            p.kills, p.deaths, p.assists, p.gold, p.cs, p.damage, p.vision, p.keystone,
            p.spell1, p.spell2, s1.icon_url AS spell1_icon, s2.icon_url AS spell2_icon
     FROM v_game_players p LEFT JOIN champions c ON c.name = p.champion
     LEFT JOIN summoner_spells s1 ON s1.name = p.spell1 LEFT JOIN summoner_spells s2 ON s2.name = p.spell2
     WHERE p.game_id = :game
     ORDER BY p.side NULLS FIRST, p.player`,
    { game: r.game_id },
  );

  if (!game || !rows.length) return null;

  const items = await selectAll(db, ScoreboardItemRow, "SELECT player, item, icon_url FROM v_player_items WHERE game_id = :game ORDER BY slot", { game: r.game_id });
  const runes = await selectAll(db, ScoreboardRuneRow, "SELECT player, slot, kind, rune, icon_url FROM v_player_runes WHERE game_id = :game ORDER BY slot", { game: r.game_id });
  const rank = (role: string | null) => (role && ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length);
  const dragons = await selectAll(db, z.object({ side: z.number().nullable(), dragon: NullableText }), "SELECT side, dragon FROM v_game_dragons WHERE game_id = :game ORDER BY seq", { game: r.game_id });
  const souls = await selectAll(db, z.object({ side: z.number(), soul: z.string() }), "SELECT side, soul FROM v_game_team_stats WHERE game_id = :game AND soul IS NOT NULL", { game: r.game_id });

  const photos = await Promise.all(rows.map((p) => (p.side === 1 || p.side === 2 ? playerPhoto(db, p.player, r.played_at) : null)));

  const players: ScoreboardPlayer[] = rows
    .flatMap((p, i): ScoreboardPlayer[] =>
      p.side === 1 || p.side === 2
        ? [
            {
              side: p.side === 1 ? "blue" : "red",
              role: p.role,
              player: p.player,
              photo: photos[i],
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
              keystoneIcon: p.keystone ? runeIcon(p.keystone, runes.find((x) => x.player === p.player && x.slot === 1)?.icon_url ?? null) : null,
              spells: [
                ...(p.spell1 ? [{ name: p.spell1, iconUrl: p.spell1_icon }] : []),
                ...(p.spell2 ? [{ name: p.spell2, iconUrl: p.spell2_icon }] : []),
              ],
              runes: runes.flatMap((x) => (x.player === p.player && x.slot > 1 ? [{ name: x.rune, kind: x.kind, iconUrl: runeIcon(x.rune, x.icon_url) }] : [])),
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
      dragonKinds: dragons.flatMap((d) => (d.side === SIDE_ID[side] ? [dragonLabel(d.dragon)] : [])),
      soul: souls.flatMap((s) => (s.side === SIDE_ID[side] ? [dragonLabel(s.soul)] : []))[0] ?? null,
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

const ProfileRow = z.object({ team: NullableText, role: NullableText, games: z.number(), last: z.number().nullable() });

export async function playerProfiles(db: Db, players: string[], scope: { league: string | null } & Period): Promise<PlayerProfile[]> {
  return Promise.all(players.map(async (player) => {
    const params: Params = {};

    Object.assign(params, { player });

    const league = scope.league ? `AND ${leagueFilter("league", { league: scope.league, yearFrom: scope.yearFrom, yearTo: scope.yearTo }, params)}` : "";

    const rows = await selectAll(
      db,
      ProfileRow,
      `SELECT team, role, COUNT(*) AS games, MAX(played_at) AS last FROM v_game_players
       WHERE player = :player AND stage IN (${COMPETITION_STAGES}) ${league} ${periodFilter("year", { yearFrom: scope.yearFrom, yearTo: scope.yearTo }, params)}
       GROUP BY team, role ORDER BY games DESC`,
      params,
    );

    const total = (key: "team" | "role") => {
      const games = new Map<string, number>();

      for (const r of rows) if (r[key]) games.set(r[key], (games.get(r[key]) ?? 0) + r.games);

      return [...games].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    };

    const last = rows.reduce<number | null>((m, r) => (r.last != null && (m == null || r.last > m) ? r.last : m), null);

    return { player, teams: total("team").map(displayTeam), role: total("role")[0] ?? null, photo: rows.length ? await playerPhoto(db, player, last) : null };
  }));
}

const SOURCE_LABEL = { cache: "Runtime Cache", r2: "R2", local: "cache local (data/raw/riot)" } as const;

const sourceLabel = (source: keyof typeof SOURCE_LABEL) => (source === "local" ? "local cache (data/raw/riot)" : SOURCE_LABEL[source]);

const gameTimeline: ToolDef<GameTimelineInput> = {
  name: "game_timeline",
  label: phrase("timeline d'une partie", "game timeline"),
  description:
    "The minute-by-minute story of one game: gold difference at every minute and the key events (first blood, towers, dragons, heralds, " +
    "barons, inhibitors, aces) with their time and team. The game is found by its teams, competition, season, stage of the series " +
    "(final, semifinal...) and game number. Not available for the LPL (no Riot data).",
  plan: async (db, input) => {
    const params: Params = {};
    const where = [`g.stage IN (${COMPETITION_STAGES})`];
    const a = input.teamA ? inList("a", (await teamMembers(db, input.teamA)).members, params) : null;
    const b = input.teamB ? inList("b", (await teamMembers(db, input.teamB)).members, params) : null;

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

    return {
      params,
      sql: `SELECT g.game_id, g.tournament_page, g.event_page, g.tournament, g.league_short, g.year, g.tab, g.match_n, g.game_n,
       g.played_at, g.blue_team, g.red_team, g.winner, g.length_s,
       r.riot_key, r.stats_page, r.has_timeline, r.side_swapped
FROM v_games g LEFT JOIN game_riot r ON r.game_id = g.game_id
WHERE ${where.join("\n  AND ")}
ORDER BY g.played_at DESC NULLS LAST, g.game_n NULLS FIRST`,
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];
    const teams = [input.teamA, input.teamB].filter(Boolean).join(" – ");

    if (!input.teamA) return out;

    if (input.phase)
      out.push({
        key: "phase",
        input: { ...input, phase: null },
        note: say(`Aucune ${tr(PHASE_LABEL[input.phase])} ${teams} dans ce périmètre : recherche sur toute la compétition.`, `No ${tr(PHASE_LABEL[input.phase])} ${teams} in this scope: searching the whole competition.`),
        reason: say(`phase « ${tr(PHASE_LABEL[input.phase])} » retirée`, `phase "${tr(PHASE_LABEL[input.phase])}" removed`),
      });

    if (input.year != null)
      out.push({ key: "year", input: { ...input, phase: null, year: null }, note: say(`Aucune partie ${teams} en ${input.year} : recherche sur toutes les saisons.`, `No game ${teams} in ${input.year}: searching every season.`), reason: say("saison retirée", "season removed") });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(TimelineGameRow).parse(sqlRows);
    const series = new Map<string, TimelineGameRow[]>();

    for (const r of rows) series.set(seriesKey(r), [...(series.get(seriesKey(r)) ?? []), r]);
    const [shownKey, games] = [...series][0];
    games.sort((x, y) => (x.game_n ?? 0) - (y.game_n ?? 0));
    const first = games[0];
    const notes: string[] = [];
    const others = [...series.values()].slice(1, 4).map((g) => g[0]);

    if (series.size > 1)
      notes.push(
        say(`${series.size} séries correspondent ; affichage de la plus récente (${seriesLabel(first)}, ${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}). `, `${series.size} series match; showing the most recent (${seriesLabel(first)}, ${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}). `) +
          say("Précise la compétition, la saison ou la phase pour une autre.", "Name the competition, the season or the stage for another one."),
      );

    const gameNumbers = games.flatMap((g) => (g.game_n == null ? [] : [g.game_n]));
    const pick = input.game == null ? first : games.find((g) => g.game_n === input.game);
    const vs = `${displayTeam(first.blue_team ?? "?")} – ${displayTeam(first.red_team ?? "?")}`;

    const followUpsFor = (except: number | null) =>
      [
        ...gameNumbers.filter((n) => n !== except).slice(0, 3).map((n) => say(`Timeline de la game ${n} de ${vs}, ${seriesLabel(first).replace(" · ", " ")}`, `Timeline of game ${n} of ${vs}, ${seriesLabel(first).replace(" · ", " ")}`)),
        ...others.map((o) => say(`Timeline de ${displayTeam(o.blue_team ?? "?")} – ${displayTeam(o.red_team ?? "?")}, ${seriesLabel(o).replace(" · ", " ")}`, `Timeline of ${displayTeam(o.blue_team ?? "?")} – ${displayTeam(o.red_team ?? "?")}, ${seriesLabel(o).replace(" · ", " ")}`)),
      ].slice(0, 4);

    const base = { game_id: pick?.game_id ?? 0, series_games: games.length, series: shownKey };

    if (!pick)
      return {
        title: `${vs} — ${seriesLabel(first)}`,
        facts:
          say(`${seriesPhrase(first).replace(/^./, (c) => c.toUpperCase())} (${vs}) s'est jouée en ${games.length} partie${games.length > 1 ? "s" : ""} `, `${seriesPhrase(first).replace(/^./, (c) => c.toUpperCase())} (${vs}) was played in ${games.length} game${games.length === 1 ? "" : "s"} `) +
          say(`(victoire${games.length > 1 ? "s" : ""} : ${games.map((g) => displayTeam(g.winner ?? "?")).join(", ")}) : il n'y a pas de game ${input.game}.`, `(winner${games.length === 1 ? "" : "s"}: ${games.map((g) => displayTeam(g.winner ?? "?")).join(", ")}): there is no game ${input.game}.`),
        sources: [{ label: `Leaguepedia — ${first.tournament_page}`, url: wikiUrl(first.tournament_page) }],
        followUps: followUpsFor(null),
        totals: { ...base, timeline: "no_such_game" },
        notes,
      };

    if (input.game == null && games.length > 1) notes.push(say(`Numéro de game non précisé : game ${pick.game_n} affichée (la série en compte ${games.length}).`, `Game number not given: game ${pick.game_n} shown (the series has ${games.length}).`));

    const title = `${displayTeam(pick.blue_team ?? "?")} – ${displayTeam(pick.red_team ?? "?")} — ${seriesLabel(pick)}${pick.game_n ? ` · game ${pick.game_n}` : ""}`;
    const result = say(`${displayTeam(pick.winner ?? "?")} gagne${pick.length_s ? ` en ${clock(pick.length_s)}` : ""}`, `${displayTeam(pick.winner ?? "?")} wins${pick.length_s ? ` in ${clock(pick.length_s)}` : ""}`);
    const scoreboard = await gameScoreboard(db, pick) ?? undefined;

    if (!pick.riot_key || pick.has_timeline !== 1)
      return {
        title,
        facts:
          say(`Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Pas de timeline pour cette partie : `, `Game ${pick.game_n ?? "?"} of ${seriesPhrase(pick)}: ${result}. No timeline for this game: `) +
          (pick.riot_key ? say("les données Riot publiées par Leaguepedia n'en contiennent pas.", "the Riot data Leaguepedia publishes does not hold one.") : say("Leaguepedia ne publie pas ses données Riot (aucune pour la LPL).", "Leaguepedia does not publish its Riot data (none for the LPL).")),
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        scoreboard,
        totals: { ...base, timeline: "absent" },
        notes,
      };

    const load = await loadTimeline(pick.riot_key);

    if (load.status !== "ok") {
      const why = {
        missing: say("le fichier Riot de la partie est introuvable dans le stockage", "the Riot file of the game cannot be found in the storage"),
        unconfigured: say("le stockage des timelines n'est pas configuré sur ce serveur", "the timeline storage is not configured on this server"),
        error: say("la lecture du stockage a échoué", "reading the storage failed"),
      }[load.status];

      return {
        title,
        facts: say(`Game ${pick.game_n ?? "?"} de ${seriesPhrase(pick)} : ${result}. Timeline indisponible pour le moment (${why}).`, `Game ${pick.game_n ?? "?"} of ${seriesPhrase(pick)}: ${result}. Timeline unavailable for now (${why}).`),
        sources: gameSources(pick),
        followUps: followUpsFor(pick.game_n),
        scoreboard,
        totals: { ...base, timeline: load.status },
        trace: [{ status: "error", title: say(`Timeline ${pick.riot_key} : ${why}`, `Timeline ${pick.riot_key}: ${why}`), detail: load.status === "error" ? (load.timeoutSeconds ? say(`lecture de plus de ${load.timeoutSeconds} s`, `read took more than ${load.timeoutSeconds} s`) : load.message) : undefined }],
        notes,
      };
    }

    const view = timelineView(pick, load.timeline);
    const at = (min: number) => view.gold.find((g) => Math.abs(g.s - min * 60) <= 30)?.diff ?? nd();
    const fb = view.events.find((e) => e.kind === "first_blood");

    return {
      title,
      timeline: view,
      scoreboard,
      facts: timelineFacts(pick, view),
      sources: [...gameSources(pick), riotDataSource()],
      followUps: followUpsFor(pick.game_n),
      totals: {
        ...base,
        timeline: "ok",
        blue: view.blue,
        red: view.red,
        winner: view.winner ? (view.winner === "blue" ? view.blue : view.red) : nd(),
        version: view.version,
        duration_s: view.durationS ?? nd(),
        gold_diff_10: at(10),
        gold_diff_15: at(15),
        first_blood: fb ? (fb.side === "blue" ? view.blue : view.red) : nd(),
        events: view.events.length,
      },
      trace: [
        {
          status: "ok",
          title: say(`Timeline ${pick.riot_key} (match-v${view.version}) lue depuis ${SOURCE_LABEL[load.source]} en ${load.ms} ms`, `Timeline ${pick.riot_key} (match-v${view.version}) read from ${sourceLabel(load.source)} in ${load.ms} ms`),
          detail: say(`${view.gold.length} points d'or, ${view.events.length} événements clés. Lecture serveur, en lecture seule : aucune clé n'est envoyée au navigateur.`, `${view.gold.length} gold points, ${view.events.length} key events. Read on the server, read-only: no key is sent to the browser.`),
        },
      ],
      notes,
    };
  },
  normalize: async (db, input) => {
    const a = input.teamA ? await resolveTeam(db, input.teamA) : null;
    const b = input.teamB ? await resolveTeam(db, input.teamB) : null;

    if ((input.teamA && !a) || (input.teamB && !b)) return null;

    return { ...input, teamA: a?.team ?? b?.team ?? null, teamB: a ? (b?.team ?? null) : null };
  },
};

const PhaseTabRow = z.object({
  tournament_page: Text,
  tab: Text,
  start: z.number().nullable(),
  end: z.number().nullable(),
  named: z.number(),
  final: z.number(),
  play_in: z.number(),
});

type PhaseTab = { page: string; tab: string; before: string | null };

async function phaseTabs(db: Db, input: SeriesInput & { phase: GamePhase }): Promise<PhaseTab[]> {
  const params: Params = {};
  const league = input.league ? `AND ${leagueFilter("g.league", input, params)}` : "";

  const rows = await selectAll(
    db,
    PhaseTabRow,
    `SELECT g.tournament_page, g.tab, MIN(g.played_at) AS start, MAX(g.played_at) AS end,
            MAX((${PHASE_SQL[input.phase]})::integer) AS named, MAX((${PHASE_SQL.final})::integer) AS final, MAX((${PHASE_SQL.play_in})::integer) AS play_in
     FROM (SELECT tournament_page, tab, played_at, stage, league, year FROM v_games
           UNION ALL SELECT tournament_page, tab, played_at, stage, league, year FROM v_series_results) g
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
  game_id: z.number().nullable(),
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
  series_id: z.number().nullable(),
  score1: z.number().nullable(),
  score2: z.number().nullable(),
  forfeited_by: NullableText,
});

type SeriesGameRow = z.infer<typeof SeriesGameRow>;

const SeriesPickRow = z.object({ game_id: z.number(), side: z.number().nullable(), role: NullableText, player: Text, champion: NullableText, icon: NullableText });

const SeriesBanRow = z.object({ game_id: z.number(), side: z.number(), champion: Text, icon: NullableText });

const MAX_DETAILED_SERIES = 16;

const dayShort = () => dateFormat(answerLocale(), { day: "numeric", month: "short", year: "numeric" });

const gameSource = (r: SeriesGameRow): Source =>
  r.stats_page
    ? { label: `Leaguepedia — ${seriesLabel(r)} · game ${r.game_n ?? "?"} (${r.stats_page})`, url: wikiUrl(r.stats_page) }
    : { label: `Leaguepedia — ${r.tournament_page}`, url: wikiUrl(r.tournament_page) };

const bestOfScore = (a: number, b: number) => (a === b ? null : 2 * Math.max(a, b) - 1);

async function seriesDrafts(db: Db, ids: number[]) {
  const params: Params = {};
  const list = ids.map((id, i) => ((params[`g${i}`] = id), `:g${i}`)).join(", ");

  const picks = ids.length
    ? await selectAll(
        db,
        SeriesPickRow,
        `SELECT p.game_id, p.side, p.role, p.player, p.champion, c.icon_url AS icon
         FROM v_game_players p LEFT JOIN champions c ON c.name = p.champion WHERE p.game_id IN (${list})`,
        params,
      )
    : [];

  const bans = ids.length
    ? await selectAll(
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


const PHASE_PLURAL: Record<GamePhase, Phrase> = {
  final: phrase("finales", "finals"),
  semifinal: phrase("demi-finales", "semifinals"),
  quarterfinal: phrase("quarts de finale", "quarterfinals"),
  third_place: phrase("matchs pour la 3e place", "third-place matches"),
  groups: phrase("phase de groupes", "group stage"),
  play_in: phrase("play-in", "play-in"),
};

function ofEvent(r: Pick<SeriesNaming, "league_short" | "year">): string {
  const year = r.year ? ` ${r.year}` : "";

  return say(`${frenchOf(r.league_short)}${year}`, `of ${r.league_short}${year}`);
}

const capitalize = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

const series: ToolDef<SeriesInput> = {
  name: "series",
  label: phrase("série (BO)", "series (best-of)"),
  description:
    "Series (best-of) shown as one unit: the score (3-2), then every game with its winner, sides, duration, picks and bans. " +
    "For a final, a semifinal, a quarterfinal or another stage of a competition ('finale des Worlds 2025', 'demi-finales MSI 2024'), " +
    "or a named match between two teams ('T1 vs Gen.G finale LCK 2024'). Regional qualifiers such as 'LPL Regional Finals' are not " +
    "the international event's final. For a team's whole record against another, use head_to_head; for one game's minute-by-minute story, game_timeline.",
  plan: async (db, input) => {
    const params: Params = {};
    const a = input.teamA ? inList("a", (await teamMembers(db, input.teamA)).members, params) : null;
    const b = input.teamB ? inList("b", (await teamMembers(db, input.teamB)).members, params) : null;
    const tabs = input.phase ? await phaseTabs(db, { ...input, phase: input.phase }) : null;
    const tabList = tabs?.length ? inList("t", tabs.map((t) => `${t.page}|${t.tab}`), params) : null;

    const where = (alias: string, one: string, two: string) => {
      const w = [`${alias}.stage IN (${COMPETITION_STAGES})`];

      if (a && b) w.push(`((${alias}.${one} IN (${a}) AND ${alias}.${two} IN (${b})) OR (${alias}.${one} IN (${b}) AND ${alias}.${two} IN (${a})))`);
      else if (a) w.push(`(${alias}.${one} IN (${a}) OR ${alias}.${two} IN (${a}))`);

      if (input.league) w.push(leagueFilter(`${alias}.league`, input, params));

      if (tabs) w.push(tabList ? `(${alias}.tournament_page || '|' || ${alias}.tab) IN (${tabList})` : "FALSE");

      return `${w.join("\n  AND ")}
  ${periodFilter(`${alias}.year`, input, params)}
  ${splitFilter(`${alias}.tournament_page`, input, params)}`;
    };

    return {
      params,
      sql: `SELECT g.game_id, g.tournament_page, g.event_page, g.tournament, g.league_short, g.year, g.tab, g.match_n, g.game_n,
       g.played_at, g.patch, g.length_s, g.blue_team, g.red_team, g.winner, r.stats_page,
       NULL::integer AS series_id, NULL::integer AS score1, NULL::integer AS score2, NULL::text AS forfeited_by
FROM v_games g LEFT JOIN game_riot r ON r.game_id = g.game_id
WHERE ${where("g", "blue_team", "red_team")}
UNION ALL
SELECT NULL, sr.tournament_page, sr.event_page, sr.tournament, sr.league_short, sr.year, sr.tab, sr.match_n, NULL,
       sr.played_at, NULL, NULL, sr.team1, sr.team2, sr.winner, NULL, sr.series_id, sr.team1_score, sr.team2_score, sr.forfeited_by
FROM v_series_results sr
WHERE ${where("sr", "team1", "team2")}
ORDER BY played_at NULLS FIRST, tournament_page, tab NULLS FIRST, match_n NULLS FIRST, game_n NULLS FIRST`,
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];
    const phase = input.phase ? tr(PHASE_LABEL[input.phase]) : null;

    if (phase && input.teamA && input.teamB && hasPeriod(input))
      out.push({
        key: "phase",
        input: { ...input, phase: null },
        note: say(`Aucune ${phase} ${input.teamA} – ${input.teamB} dans ce périmètre : toutes leurs séries de la période.`, `No ${phase} ${input.teamA} – ${input.teamB} in this scope: all their series of the period.`),
        reason: say(`phase « ${phase} » retirée`, `phase "${phase}" removed`),
      });

    if (phase && input.teamA && !input.teamB && (input.league || hasPeriod(input)))
      out.push({
        key: "team",
        input: { ...input, teamA: null },
        note: say(`${input.teamA} n'a pas joué de ${phase} dans ce périmètre : affichage de la ${phase} sans filtre d'équipe.`, `${input.teamA} played no ${phase} in this scope: showing the ${phase} without a team filter.`),
        reason: say(`équipe ${input.teamA} retirée`, `team ${input.teamA} removed`),
      });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(SeriesGameRow).parse(sqlRows);
    const groups = new Map<string, SeriesGameRow[]>();

    const keyOf = (r: SeriesGameRow) => (r.game_id == null ? `schedule|${r.series_id}` : seriesKey(r));

    for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
    const seriesGames = [...groups.values()];
    const detailedIds = seriesGames.slice(0, MAX_DETAILED_SERIES).flatMap((g) => g.flatMap((r) => r.game_id ?? []));
    const draftOf = await seriesDrafts(db, detailedIds);
    const gameRows = rows.filter((r) => r.game_id != null);

    const list: SeriesDetail[] = seriesGames.map((games, i) => {
      const scheduled = games[0].game_id == null ? games[0] : null;

      if (scheduled) {
        const firstWon = scheduled.winner === scheduled.blue_team;
        const [x, y] = firstWon ? [scheduled.blue_team, scheduled.red_team] : [scheduled.red_team, scheduled.blue_team];
        const [wx, wy] = firstWon ? [scheduled.score1 ?? 0, scheduled.score2 ?? 0] : [scheduled.score2 ?? 0, scheduled.score1 ?? 0];

        return {
          label: seriesLabel(scheduled),
          tournamentPage: scheduled.tournament_page,
          playedAt: scheduled.played_at,
          teamA: displayTeam(x ?? "?"),
          teamB: displayTeam(y ?? "?"),
          winsA: wx,
          winsB: wy,
          bestOf: scheduled.forfeited_by ? null : bestOfScore(wx, wy),
          games: null,
          scheduleOnly: true,
          forfeitedBy: scheduled.forfeited_by ? displayTeam(scheduled.forfeited_by) : null,
          source: { label: `Leaguepedia — ${scheduled.tournament_page}`, url: wikiUrl(scheduled.tournament_page) },
        };
      }

      games.sort((x, y) => (x.game_n ?? 0) - (y.game_n ?? 0));
      const first = games[0];
      const names = [...new Set(games.flatMap((g) => [g.blue_team, g.red_team]).filter((t): t is string => t != null))];
      const winsOf = (team: string | undefined) => games.filter((g) => team != null && g.winner === team).length;
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
        scheduleOnly: false,
        forfeitedBy: null,
        games:
          i < MAX_DETAILED_SERIES
            ? games.map((g) => ({
                n: g.game_n,
                playedAt: g.played_at,
                blue: displayTeam(g.blue_team ?? say("Bleu", "Blue")),
                red: displayTeam(g.red_team ?? say("Rouge", "Red")),
                winner: g.winner == null ? null : g.winner === g.blue_team ? "blue" : g.winner === g.red_team ? "red" : null,
                durationS: g.length_s,
                patch: g.patch,
                ...draftOf(g.game_id!),
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
    const oneEvent = new Set(rows.map((r) => `${r.league_short}|${r.year}`)).size === 1;
    const short = await leagueShortName(db, input.league);
    const span = hasPeriod(input) ? yearSpan(rows.flatMap((r) => (r.year == null ? [] : [r.year]))) : "";

    const event = oneEvent
      ? `${firstRow.league_short}${firstRow.year ? ` ${firstRow.year}` : ""}`
      : input.league
        ? [short, span].filter(Boolean).join(" ")
        : span || leagueLabel(short);

    const phaseName = input.phase ? tr(PHASE_PLURAL[input.phase]) : null;
    const scope = [labels.length === 1 ? labels[0] : phaseName ? `${event} · ${phaseName}` : event, teams.join(" – ")].filter(Boolean).join(" · ");

    const notes: string[] = [];

    if (input.phase === "semifinal") {
      const fallback = (await phaseTabs(db, { ...input, phase: "semifinal" })).filter((t) => t.before && list.some((s) => s.tournamentPage === t.page));

      for (const t of fallback)
        notes.push(say(`${t.page} : pas de demi-finales nommées sur Leaguepedia (tableau à double élimination) ; séries du dernier tour avant la finale (${t.tab}), qui désigne les deux finalistes.`, `${t.page}: no semifinals named on Leaguepedia (double-elimination bracket); series of the last round before the final (${t.tab}), which decides the two finalists.`));
    }

    if (list.length > MAX_DETAILED_SERIES) notes.push(say(`${list.length} séries : le détail game par game est donné pour les ${MAX_DETAILED_SERIES} premières.`, `${list.length} series: the game-by-game detail is given for the first ${MAX_DETAILED_SERIES}.`));

    if (rows.length >= MAX_ROWS) notes.push(say(`Liste limitée aux ${MAX_ROWS} premières parties : précise la saison ou la phase pour la suite.`, `List limited to the first ${MAX_ROWS} games: name the season or the stage for the rest.`));

    const score = (s: SeriesDetail) => (s.forfeitedBy ? say(`${s.teamA} bat ${s.teamB} par forfait`, `${s.teamA} beats ${s.teamB} by forfeit`) : `${s.teamA} ${s.winsA}-${s.winsB} ${s.teamB}`);
    const scheduledCount = list.filter((s) => s.scheduleOnly).length;
    notes.push(...scheduleNotes(scheduledCount, list.filter((s) => s.forfeitedBy).length, []));
    const sideName = (g: SeriesGame) => (g.winner === "blue" ? say(`${g.blue} (bleu)`, `${g.blue} (blue)`) : g.winner === "red" ? say(`${g.red} (rouge)`, `${g.red} (red)`) : say("vainqueur inconnu", "winner unknown"));

    const ofScope = oneEvent
      ? ofEvent(firstRow)
      : input.league
        ? [ofEvent({ league_short: leagueLabel(short), year: null }), span].filter(Boolean).join(" ")
        : say([teams.length ? `de ${teams.join(" et ")}` : "", span ? `en ${span}` : allCompetitions()], [teams.length ? `of ${teams.join(" and ")}` : "", span ? `in ${span}` : allCompetitions()]).filter(Boolean).join(" ");

    const phrase = capitalize(one || !phaseName ? seriesPhrase(firstRow) : `${phaseName} ${ofScope}`.trim());

    const facts = one?.scheduleOnly
      ? say(`${phrase} : ${score(one)}${one.playedAt ? `, le ${dayFormat().format(new Date(one.playedAt * 1000))}` : ""}.`, `${phrase}: ${score(one)}${one.playedAt ? `, on ${dayFormat().format(new Date(one.playedAt * 1000))}` : ""}.`)
      : one
      ? say(`${phrase} : ${one.winsA === one.winsB ? `${one.teamA} et ${one.teamB} à égalité ${one.winsA}-${one.winsB}` : `${one.teamA} bat ${one.teamB} ${one.winsA}-${one.winsB}`}`, `${phrase}: ${one.winsA === one.winsB ? `${one.teamA} and ${one.teamB} tied ${one.winsA}-${one.winsB}` : `${one.teamA} beats ${one.teamB} ${one.winsA}-${one.winsB}`}`) +
        say(`${one.bestOf ? ` (BO${one.bestOf})` : ""}${one.playedAt ? `, le ${dayFormat().format(new Date(one.playedAt * 1000))}` : ""}. `, `${one.bestOf ? ` (BO${one.bestOf})` : ""}${one.playedAt ? `, on ${dayFormat().format(new Date(one.playedAt * 1000))}` : ""}. `) +
        (one.games ?? []).map((g) => say(`Game ${g.n ?? "?"} : ${sideName(g)}${g.durationS ? ` en ${clock(g.durationS)}` : ""}`, `Game ${g.n ?? "?"}: ${sideName(g)}${g.durationS ? ` in ${clock(g.durationS)}` : ""}`)).join(say(" ; ", "; ")) +
        "."
      : say(`${phrase} : ${list.length} séries. ${list.slice(0, 8).map(score).join(" ; ")}${list.length > 8 ? " ; …" : ""}.`, `${phrase}: ${list.length} series. ${list.slice(0, 8).map(score).join("; ")}${list.length > 8 ? "; …" : ""}.`);

    const askAgain = (s: SeriesDetail) =>
      `${s.teamA} vs ${s.teamB} ${input.phase ? `${tr(PHASE_LABEL[input.phase])} ${s.label.split(" · ")[0]}` : s.label.replace(" · ", " ")}`;

    const followUps = one
      ? [
          ...(one.games ?? []).filter((g) => g.n != null).slice(-2).reverse().map((g) => say(`Récap de la game ${g.n} de ${one.teamA} vs ${one.teamB}, ${seriesPhrase(firstRow)}`, `Recap of game ${g.n} of ${one.teamA} vs ${one.teamB}, ${seriesPhrase(firstRow)}`)),
          say(`${one.teamA} contre ${one.teamB}`, `${one.teamA} vs ${one.teamB}`),
        ]
      : list.slice(0, 3).map(askAgain);

    const totals: ToolOutput["totals"] = { series: list.length, games: gameRows.length, schedule_series: scheduledCount };
    const top = list[0];

    if (top)
      Object.assign(totals, {
        team_a: top.teamA,
        team_b: top.teamB,
        wins_a: top.winsA,
        wins_b: top.winsB,
        score: `${top.winsA}-${top.winsB}`,
        best_of: top.bestOf ?? nd(),
        label: top.label,
        date: top.playedAt ? dayShort().format(new Date(top.playedAt * 1000)) : nd(),
      });

    const pages = [...new Set(list.map((s) => s.tournamentPage))];
    const gamePages = list.flatMap((s) => (s.games ?? []).flatMap((g) => (g.source.url === s.source.url ? [] : [g.source])));

    return {
      title: one ? `${score(one)} — ${one.label}` : phaseName ? `${capitalize(phaseName)} — ${[event, teams.join(" – ")].filter(Boolean).join(" · ")}` : say(`Séries — ${scope}`, `Series — ${scope}`),
      series: { scope, count: list.length, series: list },
      table: gameRows.length
        ? {
            columns: [say("Série", "Series"), "Game", say("Bleu", "Blue"), say("Rouge", "Red"), say("Vainqueur", "Winner"), say("Durée", "Duration"), "Patch"],
            rows: list.flatMap((s, i) =>
              s.scheduleOnly
                ? []
                : seriesGames[i].map((g) => [
                    `${score(s)} · ${s.label}`,
                    g.game_n,
                    displayTeam(g.blue_team ?? "?"),
                    displayTeam(g.red_team ?? "?"),
                    g.winner ? displayTeam(g.winner) : null,
                    g.length_s ? clock(g.length_s) : null,
                    g.patch,
                  ]),
            ),
          }
        : undefined,
      facts,
      sources: [...pages.map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })), ...gamePages].slice(0, 30),
      followUps: followUps.slice(0, 3),
      notes,
      totals,
    };
  },
  normalize: async (db, input) => {
    const a = input.teamA ? await resolveTeam(db, input.teamA) : null;
    const b = input.teamB ? await resolveTeam(db, input.teamB) : null;

    if ((input.teamA && !a) || (input.teamB && !b)) return null;

    return { ...input, teamA: a?.team ?? b?.team ?? null, teamB: a ? (b?.team ?? null) : null };
  },
};

type TeamCriterionDef = CriterionDef & {
  ingame?: true;
};

const teamAverage = (column: string, digits: number) => `ROUND(AVG(b.${column}), ${digits})`;

const sideWinrate = (side: MapSide) =>
  `ROUND(100.0 * SUM(CASE WHEN b.side = ${SIDE_ID[side]} THEN b.win END) / COUNT(CASE WHEN b.side = ${SIDE_ID[side]} THEN b.win END), 1)`;

export const TEAM_CRITERION_DEFS: Record<TeamCriterion, TeamCriterionDef> = {
  winrate: { label: phrase("% victoires", "win %"), definition: phrase("victoires / parties", "wins / games"), sql: "ROUND(100.0 * SUM(b.win) / COUNT(b.win), 1)", unit: " %" },
  games: { label: phrase("parties", "games"), definition: phrase("nombre de parties jouées", "number of games played"), sql: "COUNT(*)", total: true },
  blue_winrate: { label: phrase("% côté bleu", "blue side %"), definition: phrase("victoires / parties jouées côté bleu", "wins / games played on blue side"), sql: sideWinrate("blue"), unit: " %" },
  red_winrate: { label: phrase("% côté rouge", "red side %"), definition: phrase("victoires / parties jouées côté rouge", "wins / games played on red side"), sql: sideWinrate("red"), unit: " %" },
  kda: { label: phrase("KDA", "KDA"), definition: phrase("(kills + assists) / morts de l'équipe", "(kills + assists) / deaths of the team"), sql: `ROUND(1.0 * ${kaSum("b")} / ${atLeast(1, deathsSum("b"))}, 2)` },
  kills: { label: phrase("kills / partie", "kills / game"), definition: phrase("kills de l'équipe par partie", "team kills per game"), sql: teamAverage("kills", 1) },
  deaths: { label: phrase("morts / partie", "deaths / game"), definition: phrase("morts de l'équipe par partie", "team deaths per game"), sql: teamAverage("deaths", 1) },
  game_length: { label: phrase("durée (min)", "length (min)"), definition: phrase("durée moyenne des parties, en minutes", "average game length, in minutes"), sql: "ROUND(AVG(b.length_s) / 60.0, 1)", unit: " min" },
  champions: { label: phrase("champions", "champions"), definition: phrase("champions différents joués", "different champions played"), sql: "MAX(pool.champions)", total: true },
  dragons: { label: phrase("dragons / partie", "dragons / game"), definition: phrase("dragons pris par partie", "dragons taken per game"), sql: teamAverage("dragons", 2) },
  barons: { label: phrase("barons / partie", "barons / game"), definition: phrase("barons pris par partie", "barons taken per game"), sql: teamAverage("barons", 2) },
  towers: { label: phrase("tours / partie", "towers / game"), definition: phrase("tourelles détruites par partie", "turrets destroyed per game"), sql: teamAverage("towers", 1) },
  heralds: { label: phrase("hérauts / partie", "heralds / game"), definition: phrase("hérauts pris par partie", "heralds taken per game"), sql: teamAverage("heralds", 2) },
  void_grubs: { label: phrase("grubs / partie", "grubs / game"), definition: phrase("larves du Néant prises par partie", "void grubs taken per game"), sql: teamAverage("void_grubs", 2) },
  first_dragon: { label: phrase("1er dragon %", "1st dragon %"), definition: phrase("part des parties avec le premier dragon", "share of games with the first dragon"), sql: "ROUND(100.0 * AVG(b.first_dragon), 1)", unit: " %", ingame: true },
  first_herald: { label: phrase("1er héraut %", "1st herald %"), definition: phrase("part des parties avec le premier héraut", "share of games with the first herald"), sql: "ROUND(100.0 * AVG(b.first_herald), 1)", unit: " %", ingame: true },
  first_baron: { label: phrase("1er baron %", "1st baron %"), definition: phrase("part des parties avec le premier baron", "share of games with the first baron"), sql: "ROUND(100.0 * AVG(b.first_baron), 1)", unit: " %", ingame: true },
  gold_diff_15: { label: phrase("écart or @15", "gold diff @15"), definition: phrase("écart d'or moyen de l'équipe à 15 min", "average team gold difference at 15 min"), sql: teamAverage("gold_diff_15", 0), ingame: true },
};

const TEAM_LEADERBOARD_COLUMNS: TeamCriterion[] = [
  "winrate", "blue_winrate", "red_winrate", "kda", "kills", "deaths", "game_length", "champions",
  "dragons", "barons", "towers", "void_grubs", "first_dragon", "first_baron", "gold_diff_15",
];

const teamColumnsOf = (input: TeamLeaderboardInput) =>
  [...new Set<TeamCriterion>([input.criterion, ...TEAM_LEADERBOARD_COLUMNS])].filter((c) => c !== "games" && !(input.side && (c === "blue_winrate" || c === "red_winrate")));

const TeamLeaderRow = z.object({ name: Text, games: z.number(), wins: z.number().nullable(), ingame_games: z.number() }).catchall(z.number().nullable());

export function minGamesOfTeams(input: TeamLeaderboardInput): number {
  if (input.minGames != null) return input.minGames;

  if (TEAM_CRITERION_DEFS[input.criterion].total) return 1;

  const oneSeason = input.yearFrom != null && input.yearFrom === input.yearTo;

  if (input.league && oneSeason) return isInternational(input.league) ? 5 : 10;

  return 20;
}

const teamLeaderboard: ToolDef<TeamLeaderboardInput> = {
  name: "team_leaderboard",
  label: phrase("classement d'équipes", "team ranking"),
  description:
    "Ranks the teams of a competition and period on one criterion from the end-of-game stats: win rate (default), games, win rate on blue or red side, " +
    "team KDA, kills or deaths per game, average game duration, distinct champions picked, dragons, barons, towers, heralds or void grubs per game, " +
    "and, from the Riot game data, first dragon / herald / baron share and gold difference at 15 min. Highest first, or lowest first " +
    "('équipe avec les parties les plus courtes'). Optionally on one side of the map only. Renamed teams are merged. " +
    "For a tournament's final placements use tournament_standings; for first blood, first tower or plates use ingame_leaderboard.",
  plan: async (db, input) => {
    const params: Params = {};

    Object.assign(params, { minGames: minGamesOfTeams(input) });
    const scope = competitionScope("g", leagueAndPeriod(input), params);
    const side = input.side ? `AND x.side = ${SIDE_ID[input.side]}` : "";

    const sideOf = (n: 1 | 2, color: "blue" | "red") =>
      `SELECT g.game_id, ${n} AS side, g.${color}_team AS team, (g.winner = g.${color}_team)::integer AS win, g.length_s, g.played_at,
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
  SELECT p.game_id, p.side, p.champion, p.kills, p.deaths, p.assists FROM v_game_players p WHERE ${competitionScope("p", leagueAndPeriod(input), params)}
),
kda AS (SELECT k.game_id, k.side, SUM(k.kills) AS kills, SUM(k.deaths) AS deaths, SUM(k.assists) AS assists FROM picks k GROUP BY k.game_id, k.side),
ig AS (
  SELECT s.game_id, s.side, s.first_dragon, s.first_herald, s.first_baron, s.gold_diff_15 FROM v_game_team_stats s WHERE ${ingameScope(input, params)}
),
b AS (
  SELECT ${await franchiseName(db, "x.team", params)} AS name, x.*, k.kills, k.deaths, k.assists,
         i.first_dragon, i.first_herald, i.first_baron, i.gold_diff_15
  FROM sides x LEFT JOIN kda k ON k.game_id = x.game_id AND k.side = x.side
  LEFT JOIN ig i ON i.game_id = x.game_id AND i.side = x.side
  WHERE x.team IS NOT NULL ${side}
),
pool AS (
  SELECT ${await franchiseName(db, "x.team", params)} AS name, COUNT(DISTINCT k.champion) AS champions
  FROM sides x JOIN picks k ON k.game_id = x.game_id AND k.side = x.side
  WHERE x.team IS NOT NULL ${side}
  GROUP BY 1
)
SELECT b.name, COUNT(*) AS games, SUM(b.win) AS wins, COUNT(b.gold_diff_15) AS ingame_games,
       ${TEAM_CRITERIA.flatMap((c) => (c === "games" ? [] : [`${TEAM_CRITERION_DEFS[c].sql} AS ${c}`])).join(",\n       ")}
FROM b LEFT JOIN pool ON pool.name = b.name
GROUP BY b.name
HAVING COUNT(*) >= :minGames AND ${TEAM_CRITERION_DEFS[input.criterion].sql} IS NOT NULL
ORDER BY ${input.criterion === "games" ? "games" : input.criterion} ${input.order === "asc" ? "ASC" : "DESC"}, games DESC, b.name
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.minGames == null && minGamesOfTeams(input) > 3)
      out.push({ key: "minGames", input: { ...input, minGames: 3 }, note: say("Peu de parties par équipe dans ce périmètre : seuil abaissé à 3 parties.", "Few games per team in this scope: threshold lowered to 3 games."), reason: say("seuil de parties abaissé", "game threshold lowered") });

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(TeamLeaderRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const scope = `${scopeLabel(league, input) || allCompetitions()}${sideLabel(input.side)}`;
    const def = TEAM_CRITERION_DEFS[input.criterion];
    const minGames = minGamesOfTeams(input);
    const columns = teamColumnsOf(input);
    const value = (r: z.infer<typeof TeamLeaderRow>, c: TeamCriterion) => (c === "games" ? r.games : (r[c] ?? null));
    const ingame = rows.reduce((n, r) => n + r.ingame_games, 0);
    const params: Params = {};
    const gameScope = competitionScope("g", leagueAndPeriod(input), params);
    const pages = (await selectAll(db, z.object({ event_page: Text }), `SELECT g.event_page FROM v_games g WHERE ${gameScope} GROUP BY g.event_page ORDER BY MAX(g.played_at) DESC NULLS LAST LIMIT 12`, params)).map((r) => r.event_page);
    const ongoing = await inProgressNote(db, gameScope, params);
    const lowest = input.order === "asc";

    const line = (r: z.infer<typeof TeamLeaderRow>, i: number) =>
      say(`${i + 1}. ${displayTeam(r.name)} : ${frNumber(value(r, input.criterion))}${def.unit ?? ""}${input.criterion === "games" ? " parties" : `, ${r.games} parties`}`, `${i + 1}. ${displayTeam(r.name)}: ${frNumber(value(r, input.criterion))}${unitEn(def.unit)}${input.criterion === "games" ? " games" : `, ${r.games} games`}`);

    const facts =
      say(`Équipes classées ${scope} selon le critère ${tr(def.label)} (${tr(def.definition)})${lowest ? ", du plus bas au plus haut" : ""}`, `Teams ranked ${scope} by ${tr(def.label)} (${tr(def.definition)})${lowest ? ", lowest first" : ""}`) +
      say(`${minGames > 1 ? `, minimum ${minGames} parties` : ""} : ${rows.slice(0, 3).map(line).join(" ; ")}. ${rows.length} équipes classées.`, `${minGames > 1 ? `, minimum ${minGames} games` : ""}: ${rows.slice(0, 3).map(line).join("; ")}. ${rows.length} teams ranked.`) +
      (def.ingame && ingame === 0 ? say(" Aucune partie de ce périmètre n'a de données Riot.", " No game of this scope has Riot data.") : "") +
      (ongoing ? ` ${ongoing}` : "");

    return {
      title: say(`Classement des équipes — ${tr(def.label)}${sideLabel(input.side)}${titleScope(league, input, " (")}`, `Team ranking — ${tr(def.label)}${sideLabel(input.side)}${titleScope(league, input, " (")}`),
      table: {
        columns: [say("Rang", "Rank"), say("Équipe", "Team"), say("Parties", "Games"), ...columns.map((c) => tr(TEAM_CRITERION_DEFS[c].label))],
        rows: rows.map((r, i) => [i + 1, displayTeam(r.name), r.games, ...columns.map((c) => value(r, c))]),
        focus: input.criterion === "games" ? say("Parties", "Games") : tr(def.label),
      },
      facts,
      sources: [
        ...rows.slice(0, 3).map((r) => ({ label: `Leaguepedia — ${r.name}`, url: wikiUrl(r.name) })),
        ...eventSources(pages, 12),
        ...(ingame ? [riotDataSource()] : []),
      ],
      followUps: [
        ...rows.slice(0, 1).map((r) => say(`Historique de ${displayTeam(r.name)}`, `${displayTeam(r.name)} history`)),
        ...(rows.length >= 2 ? [say(`${displayTeam(rows[0].name)} contre ${displayTeam(rows[1].name)}`, `${displayTeam(rows[0].name)} vs ${displayTeam(rows[1].name)}`)] : []),
        ...rows.slice(0, 1).map((r) => say(`Champion pool de ${displayTeam(r.name)}${scopeLabel(league, input) ? ` ${scopeLabel(league, input)}` : ""}`, `${displayTeam(r.name)}'s champion pool${scopeLabel(league, input) ? ` ${scopeLabel(league, input)}` : ""}`)),
      ],
      totals: {
        leader: rows[0] ? displayTeam(rows[0].name) : "",
        leader_value: rows[0] ? (value(rows[0], input.criterion) ?? nd()) : nd(),
        leader_games: rows[0]?.games ?? 0,
        rows: rows.length,
        min_games: minGames,
        criterion: input.criterion,
      },
    };
  },
  normalize: (_db, input) => ({
    ...input,
    side: input.criterion === "blue_winrate" || input.criterion === "red_winrate" ? null : input.side,
    minGames: input.minGames != null && input.minGames >= 3 ? input.minGames : null,
  }),
};

const MATCHUP_MIN_GAMES = 3;

function matchupScope(alias: string, input: ChampionMatchupInput, params: Params): string {
  params.champion = input.champion;
  const league = input.league ? `AND ${leagueFilter(`${alias}.league`, input, params)}` : "";
  const role = input.role ? ((params.role = input.role), `AND ${alias}.role = :role`) : "";

  return `${alias}.champion = :champion AND ${alias}.stage IN (${COMPETITION_STAGES}) ${league} ${role} ${periodFilter(`${alias}.year`, input, params)}`;
}

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

const of = (name: string) => (/^[aeiouyhàâéèêîôû]/i.test(name) ? `d'${name}` : `de ${name}`);

const kdaText = (k: number | null, d: number | null, a: number | null) => (k == null || d == null || a == null ? null : `${k}/${d}/${a}`);

const championMatchup: ToolDef<ChampionMatchupInput> = {
  name: "champion_matchup",
  label: phrase("matchup de champions", "champion matchup"),
  description:
    "A champion against its direct opponents (the champion played in the same role on the other team): against one named champion, the games, " +
    "the win rate, both KDAs and the gold difference at 15 min ('Azir contre Orianna', 'winrate de Jax face à Renekton en top'); " +
    "without one, the champions it faced most with its win rate against each ('matchups d'Azir', 'contre qui Azir perd le plus', 'counters de K'Sante'). " +
    "For one champion's own stats use champion_event_stats.",
  plan: async (_db, input) => {
    const params: Params = {};
    const scope = matchupScope("a", input, params);
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
       ROUND(1.0 * ${kaSum("a")} OVER () / ${atLeast(1, `${deathsSum("a")} OVER ()`)}, 2) AS kda_a,
       ROUND(1.0 * ${kaSum("b")} OVER () / ${atLeast(1, `${deathsSum("b")} OVER ()`)}, 2) AS kda_b,
       ROUND(AVG(s.gold_diff_15) OVER (), 0) AS avg_gold_diff_15, COUNT(s.gold_diff_15) OVER () AS ingame_games
FROM v_game_players a ${LANE_OPPONENT} AND b.champion = :opponent
${ingame}
WHERE ${scope}
ORDER BY a.played_at DESC NULLS LAST
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
SELECT m.opponent AS champion, ANY_VALUE(c.icon_url) AS icon, COUNT(*) AS games, COALESCE(SUM(m.win), 0) AS wins,
       ROUND(100.0 * SUM(m.win) / COUNT(m.win), 1) AS winrate,
       ROUND(1.0 * ${kaSum("m")} / ${atLeast(1, deathsSum("m"))}, 2) AS kda,
       ROUND(AVG(m.gold_diff_15), 0) AS gold_diff_15,
       ANY_VALUE(n.total_games) AS total_games, ANY_VALUE(n.total_wins) AS total_wins, ANY_VALUE(n.opponents) AS opponents
FROM m CROSS JOIN n LEFT JOIN champions c ON c.name = m.opponent
GROUP BY m.opponent
ORDER BY games DESC, winrate DESC NULLS LAST, champion
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (input.role) out.push({ key: "role", input: { ...input, role: null }, note: say(`Aucune partie en ${ROLE_LABEL[input.role]} : affichage de tous les rôles.`, `No game in ${ROLE_LABEL[input.role]}: showing all roles.`), reason: say("filtre de rôle retiré", "role filter removed") });

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null, yearFrom: null, yearTo: null }, note: say("Aucune partie dans cette compétition : affichage de toutes les compétitions.", "No game in this competition: showing all competitions."), reason: say("filtre de compétition retiré", "competition filter removed") });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const league = await leagueShortName(db, input.league);
    const scope = scopeLabel(league, input) || allCompetitions();
    const role = input.role ? say(` en ${ROLE_LABEL[input.role]}`, ` in ${ROLE_LABEL[input.role]}`) : "";
    const names = [input.champion, ...(input.opponent ? [input.opponent] : [])];
    const iconParams: Params = {};

    const icons = Object.fromEntries(
      (await selectAll(db, z.object({ name: Text, icon_url: NullableText }), `SELECT name, icon_url FROM champions WHERE name IN (${inList("c", names, iconParams)})`, iconParams)).flatMap((c) =>
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
      const day = (s: number | null) => (s == null ? null : dayShort().format(new Date(s * 1000)));

      const facts =
        say(`${input.champion} contre ${input.opponent}${role} ${scope} (même rôle, équipes opposées) : ${games} parties, ${input.champion} en gagne ${wins} (${pct(wins, games)} %) `, `${input.champion} against ${input.opponent}${role} ${scope} (same role, opposite teams): ${games} games, ${input.champion} wins ${wins} (${pct(wins, games)}%) `) +
        say(`et ${input.opponent} ${games - wins}. KDA ${of(input.champion)} : ${frNumber(t?.kda_a ?? null)}, ${of(input.opponent)} : ${frNumber(t?.kda_b ?? null)}.`, `and ${input.opponent} ${games - wins}. KDA of ${input.champion}: ${frNumber(t?.kda_a ?? null)}, of ${input.opponent}: ${frNumber(t?.kda_b ?? null)}.`) +
        (t?.ingame_games
          ? say(` Écart d'or moyen ${of(input.champion)} à 15 min : ${frNumber(t.avg_gold_diff_15, true)}, sur ${t.ingame_games} parties avec données Riot.`, ` Average gold difference of ${input.champion} at 15 min: ${frNumber(t.avg_gold_diff_15, true)}, over ${t.ingame_games} games with Riot data.`)
          : say(" Écart d'or à 15 min n/d : aucune de ces parties n'a de données Riot.", " Gold difference at 15 min n/a: none of these games has Riot data.")) +
        (games > rows.length ? say(` Les ${rows.length} parties les plus récentes sont listées.`, ` The ${rows.length} most recent games are listed.`) : "");

      return {
        title: say(`${input.champion} contre ${input.opponent}${role}${titleScope(league, input, " — ")}`, `${input.champion} vs ${input.opponent}${role}${titleScope(league, input, " — ")}`),
        table: {
          columns: ["Date", say("Compétition", "Competition"), say("Rôle", "Role"), input.champion, "K/D/A", input.opponent, "K/D/A ", say("Vainqueur", "Winner"), say("Écart or @15", "Gold diff @15")],
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
        sources: [...names.map(championSource), ...eventSources(rows.map((r) => r.event_page).reverse(), 10), ...(t?.ingame_games ? [riotDataSource()] : []), ddragon],
        followUps: [say(`Matchups ${of(input.champion)}${role}`, `${input.champion} matchups${role}`), say(`Stats ${of(input.champion)} ${inLeague(league) || "aux Worlds"}`, `${input.champion} stats ${inLeague(league) || "at Worlds"}`), say(`Stats ${of(input.opponent)} ${inLeague(league) || "aux Worlds"}`, `${input.opponent} stats ${inLeague(league) || "at Worlds"}`)],
        totals: {
          games,
          wins,
          losses: games - wins,
          winrate: games ? pct(wins, games) : nd(),
          kda: t?.kda_a ?? nd(),
          opponent_kda: t?.kda_b ?? nd(),
          gold_diff_15: t?.avg_gold_diff_15 ?? nd(),
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
    const line = (r: z.infer<typeof MatchupListRow>) => say(`${r.champion} (${r.games} parties, ${frNumber(r.winrate)} % de victoires pour ${input.champion})`, `${r.champion} (${r.games} games, ${frNumber(r.winrate)}% wins for ${input.champion})`);

    const facts =
      say(`${input.champion}${role} ${scope} : ${games} parties face à un adversaire direct (même rôle, équipe opposée), ${pct(wins, games)} % de victoires, `, `${input.champion}${role} ${scope}: ${games} games against a lane opponent (same role, opposite team), ${pct(wins, games)}% wins, `) +
      say(`${rows[0]?.opponents ?? 0} champions affrontés. Les plus fréquents : ${rows.slice(0, 3).map((r, i) => `${i + 1}. ${line(r)}`).join(", ")}.`, `${rows[0]?.opponents ?? 0} champions faced. Most frequent: ${rows.slice(0, 3).map((r, i) => `${i + 1}. ${line(r)}`).join(", ")}.`) +
      (best && worst && best.champion !== worst.champion
        ? say(` Parmi les ${rows.length} plus fréquents, avec au moins ${MATCHUP_MIN_GAMES} parties : meilleur bilan contre ${line(best)}, pire bilan contre ${line(worst)}.`, ` Among the ${rows.length} most frequent, with at least ${MATCHUP_MIN_GAMES} games: best record against ${line(best)}, worst record against ${line(worst)}.`)
        : "");

    return {
      title: say(`Matchups ${of(input.champion)}${role}${titleScope(league, input, " — ")}`, `${input.champion} matchups${role}${titleScope(league, input, " — ")}`),
      table: {
        columns: ["rank", "champion", "games", "wins", "winrate", "kda", "gold_diff_15"],
        rows: rows.map((r, i) => [i + 1, r.champion, r.games, r.wins, r.winrate, r.kda, r.gold_diff_15]),
      },
      icons: { ...icons, ...Object.fromEntries(rows.flatMap((r) => (r.icon ? [[r.champion, r.icon]] : []))) },
      facts,
      sources: [championSource(input.champion), ...(rows.some((r) => r.gold_diff_15 != null) ? [riotDataSource()] : []), ddragon],
      followUps: [...rows.slice(0, 2).map((r) => say(`${input.champion} contre ${r.champion}${role}`, `${input.champion} vs ${r.champion}${role}`)), say(`Stats ${of(input.champion)} ${inLeague(league) || "aux Worlds"}`, `${input.champion} stats ${inLeague(league) || "at Worlds"}`)],
      totals: {
        games,
        wins,
        winrate: games ? pct(wins, games) : nd(),
        opponents: rows[0]?.opponents ?? 0,
        top_opponent: rows[0]?.champion ?? "",
        top_opponent_games: rows[0]?.games ?? 0,
        best_matchup: best?.champion ?? "",
        worst_matchup: worst?.champion ?? "",
        rows: rows.length,
      },
    };
  },
  normalize: async (db, input) => {
    const c = await resolveChampion(db, input.champion);
    const o = input.opponent ? await resolveChampion(db, input.opponent) : null;

    if (!c || (input.opponent && !o)) return null;

    return { ...input, champion: c.champion, opponent: o && o.champion !== c.champion ? o.champion : null };
  },
};

type RecordDef = {
  label: Phrase;
  unit: Phrase;
  column: string;
  ingame?: true;
  signed?: true;
};

export const RECORD_DEFS: Record<RecordMetric, RecordDef> = {
  kills: { label: phrase("Kills", "Kills"), unit: phrase("kills", "kills"), column: "kills" },
  deaths: { label: phrase("Morts", "Deaths"), unit: phrase("morts", "deaths"), column: "deaths" },
  assists: { label: phrase("Assists", "Assists"), unit: phrase("assists", "assists"), column: "assists" },
  damage: { label: phrase("Dégâts", "Damage"), unit: phrase("dégâts aux champions", "damage to champions"), column: "damage" },
  cs: { label: phrase("CS", "CS"), unit: phrase("CS", "CS"), column: "cs" },
  gold: { label: phrase("Or", "Gold"), unit: phrase("d'or", "gold"), column: "gold" },
  vision: { label: phrase("Vision", "Vision"), unit: phrase("de score de vision", "vision score"), column: "vision" },
  gold_diff_15: { label: phrase("Écart or @15", "Gold diff @15"), unit: phrase("d'or d'écart à 15 min face à l'adversaire direct", "gold lead at 15 min over the lane opponent"), column: "gold_diff_15", ingame: true, signed: true },
  cs_diff_15: { label: phrase("Écart CS @15", "CS diff @15"), unit: phrase("CS d'écart à 15 min face à l'adversaire direct", "CS lead at 15 min over the lane opponent"), column: "cs_diff_15", ingame: true, signed: true },
  solo_kills: { label: phrase("Solo kills", "Solo kills"), unit: phrase("solo kills", "solo kills"), column: "solo_kills", ingame: true },
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

function recordScope(input: GameRecordsInput, params: Params): string {
  const player = input.player ? ((params.player = input.player), "AND x.player = :player") : "";

  return `${competitionScope("x", input, params)} ${player}`;
}

const gameRecords: ToolDef<GameRecordsInput> = {
  name: "game_records",
  label: phrase("records sur une partie", "single-game records"),
  description:
    "The best single-game performances on one figure, in a competition and period, optionally of one role or of one player: most kills, deaths, " +
    "assists, damage, CS, gold or vision in one game, and, from the Riot game data, biggest gold or CS lead at 15 min and most solo kills. " +
    "Each line is one game: player, champion, teams, event, date. Use it for 'record de kills en une partie aux Worlds', " +
    "'most kills in a single game', 'meilleure game de Faker en kills'. For totals or averages over many games use player_leaderboard or ingame_leaderboard.",
  plan: async (_db, input) => {
    const params: Params = {};
    const def = RECORD_DEFS[input.metric];

    return {
      params,
      sql: tidy(`SELECT x.player, x.champion, c.icon_url AS icon, x.team,
       CASE WHEN x.side = 1 THEN g.red_team ELSE g.blue_team END AS opponent,
       x.win, x.kills, x.deaths, x.assists, x.${def.column} AS value, g.length_s, x.played_at, x.league_short, x.year, x.event_page
FROM ${def.ingame ? "v_game_player_stats" : "v_game_players"} x JOIN v_games g ON g.game_id = x.game_id
LEFT JOIN champions c ON c.name = x.champion
WHERE ${recordScope(input, params)} AND x.${def.column} IS NOT NULL
ORDER BY value DESC NULLS LAST, x.played_at NULLS FIRST, x.player
LIMIT 20`),
    };
  },
  relaxations: (input) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.role) out.push({ key: "role", input: { ...input, role: null }, note: say("Aucune partie à ce poste dans ce périmètre : tous les postes.", "No game in this role in this scope: all roles."), reason: say("filtre de rôle retiré", "role filter removed") });

    if (input.league && !RECORD_DEFS[input.metric].ingame)
      out.push({ key: "league", input: { ...input, league: null }, note: say("Aucune partie dans cette compétition : affichage de toutes les compétitions.", "No game in this competition: showing all competitions."), reason: say("filtre de compétition retiré", "competition filter removed") });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(GameRecordRow).parse(sqlRows);
    const def = RECORD_DEFS[input.metric];
    const league = await leagueShortName(db, input.league);
    const scope = scopeLabel(league, input) || allCompetitions();
    const who = say(`${input.player ? ` ${of(input.player)}` : ""}${input.role ? ` (${tr(ROLE_PLAYERS[input.role])})` : ""}`, `${input.player ? ` of ${input.player}` : ""}${input.role ? ` (${tr(ROLE_PLAYERS[input.role])})` : ""}`);
    const day = (s: number | null) => (s == null ? null : dayShort().format(new Date(s * 1000)));
    const event = (r: z.infer<typeof GameRecordRow>) => `${r.league_short}${r.year ? ` ${r.year}` : ""}`;
    const figure = (r: z.infer<typeof GameRecordRow>) => frNumber(r.value, def.signed);
    const params: Params = {};
    const cov = def.ingame ? await coverage(db, `SELECT COUNT(*) AS games, COALESCE(SUM(has_ingame), 0) AS ingame FROM v_games s WHERE ${ingameScope(input, params)}`, params) : null;

    const line = (r: z.infer<typeof GameRecordRow>, i: number) =>
      say(`${i + 1}. ${r.player} : ${figure(r)} (${[r.champion, r.team && r.opponent ? `${displayTeam(r.team)} contre ${displayTeam(r.opponent)}` : null, event(r), day(r.played_at)].filter(Boolean).join(", ")})`, `${i + 1}. ${r.player}: ${figure(r)} (${[r.champion, r.team && r.opponent ? `${displayTeam(r.team)} vs ${displayTeam(r.opponent)}` : null, event(r), day(r.played_at)].filter(Boolean).join(", ")})`);

    const facts =
      say(`Meilleures parties${who} ${scope} sur le critère ${tr(def.unit)}, une ligne par partie : ${rows.slice(0, 3).map(line).join(" ; ")}.`, `Best games${who} ${scope} by ${tr(def.unit)}, one line per game: ${rows.slice(0, 3).map(line).join("; ")}.`) +
      (rows.length > 1 && rows[0].value === rows[1].value ? say(` ${rows.filter((r) => r.value === rows[0].value).length} parties à égalité en tête.`, ` ${rows.filter((r) => r.value === rows[0].value).length} games tied for first.`) : "") +
      (cov ? coverageNote(cov) : "");

    return {
      title: say(`Records sur une partie — ${tr(def.label).toLowerCase()}${who}${titleScope(league, input, " (")}`, `Single-game records — ${tr(def.label).toLowerCase()}${who}${titleScope(league, input, " (")}`),
      table: {
        columns: [say("Rang", "Rank"), say("Joueur", "Player"), say("Champion joué", "Champion played"), say("Équipe", "Team"), say("Adversaire", "Opponent"), say("Compétition", "Competition"), "Date", tr(def.label), "K/D/A", say("Durée", "Duration"), say("Résultat", "Result")],
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
          r.win == null ? null : r.win ? say("Victoire", "Victory") : say("Défaite", "Defeat"),
        ]),
        focus: tr(def.label),
      },
      icons: Object.fromEntries(rows.flatMap((r) => (r.champion && r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [
        ...[...new Set(rows.slice(0, 3).map((r) => r.player))].map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) })),
        ...eventSources(rows.map((r) => r.event_page).reverse(), 10),
        ...(def.ingame ? [riotDataSource()] : []),
      ],
      followUps: [
        ...[...new Set(rows.map((r) => r.player))].slice(0, 2).map((p) => say(`Dernières parties de ${p}`, `${p}'s recent games`)),
        ...(input.player ? [] : [say(`Joueurs avec le plus de kills ${inLeague(league) || "aux Worlds"}`, `Players with the most kills ${inLeague(league) || "at Worlds"}`)]),
      ],
      totals: {
        leader: rows[0]?.player ?? "",
        leader_value: rows[0]?.value ?? nd(),
        leader_champion: rows[0]?.champion ?? "",
        leader_event: rows[0] ? event(rows[0]) : "",
        rows: rows.length,
        metric: input.metric,
      },
    };
  },
  normalize: async (db, input) => {
    if (!input.player) return input;
    const p = await resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

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
  label: phrase("dernières parties d'un joueur", "latest games of a player"),
  description:
    "A player's latest games, newest first (10 by default): date, event, team, opponent, champion, result, K/D/A, CS, damage and duration, " +
    "with the record, the KDA and the current streak over those games. Use it for 'forme récente de Faker', 'dernières parties de Caps', " +
    "'last 5 games of Chovy', 'comment joue Ruler en ce moment'. For a whole event or career use player_event_history.",
  plan: async (_db, input) => {
    const params: Params = {};

    params.player = input.player;
    const league = input.league ? `AND ${leagueFilter("p.league", input, params)}` : "";

    return {
      params,
      sql: tidy(`SELECT p.played_at, p.league_short, p.year, p.event_page, g.tab, p.team,
       CASE WHEN p.side = 1 THEN g.red_team ELSE g.blue_team END AS opponent,
       p.champion, c.icon_url AS icon, p.win, p.kills, p.deaths, p.assists, p.cs, p.damage, g.length_s
FROM v_game_players p JOIN v_games g ON g.game_id = p.game_id
LEFT JOIN champions c ON c.name = p.champion
WHERE p.player = :player AND p.stage IN (${COMPETITION_STAGES}) AND p.played_at IS NOT NULL ${league} ${periodFilter("p.year", input, params)}
ORDER BY p.played_at DESC NULLS LAST, p.game_id DESC
LIMIT ${input.count ?? RECENT_DEFAULT}`),
    };
  },
  relaxations: (input, entities) => {
    const out: Relaxation<typeof input>[] = [];

    if (hasPeriod(input)) out.push(noPeriod(input, say("toutes les saisons", "every season")));

    if (input.league)
      out.push({ key: "league", input: { ...input, league: null }, note: say("Aucune partie dans cette compétition : affichage de toutes les compétitions.", "No game in this competition: showing all competitions."), reason: say("filtre de compétition retiré", "competition filter removed") });
    const resolved = entities.players.find((p) => p.player === input.player || p.otherCandidates.includes(input.player));

    for (const other of resolved ? [resolved.player, ...resolved.otherCandidates] : [])
      if (other !== input.player)
        out.push({ key: `player:${other}`, input: { ...input, player: other }, note: say(`« ${resolved!.mention} » désigne aussi ${other} : parties de ${other}.`, `"${resolved!.mention}" also names ${other}: games of ${other}.`), reason: say(`alias homonyme essayé : ${other}`, `homonym alias tried: ${other}`) });

    return out;
  },
  format: async (db, input, sqlRows): Promise<ToolOutput> => {
    const rows = z.array(RecentGameRow).parse(sqlRows);
    const league = await leagueShortName(db, input.league);
    const scope = scopeLabel(league, input);
    const day = (s: number) => dayShort().format(new Date(s * 1000));
    const decided = rows.filter((r) => r.win != null);
    const wins = decided.filter((r) => r.win).length;
    const scored = rows.filter((r) => r.kills != null && r.deaths != null && r.assists != null);
    const sum = (pick: (r: z.infer<typeof RecentGameRow>) => number | null) => scored.reduce((n, r) => n + (pick(r) ?? 0), 0);
    const [kills, deaths, assists] = [sum((r) => r.kills), sum((r) => r.deaths), sum((r) => r.assists)];
    const kda = scored.length ? Math.round((100 * (kills + assists)) / Math.max(1, deaths)) / 100 : null;
    const per = (n: number) => frNumber(Math.round((10 * n) / Math.max(1, scored.length)) / 10);
    const streak = decided.findIndex((r) => r.win !== decided[0].win);
    const run = decided.length ? (streak < 0 ? decided.length : streak) : 0;
    const champions = new Map<string, number>();

    for (const r of rows) if (r.champion) champions.set(r.champion, (champions.get(r.champion) ?? 0) + 1);
    const played = [...champions].toSorted((a, b) => b[1] - a[1]);
    const last = rows[0];
    const first = rows[rows.length - 1];

    const facts =
      say(`${input.player} : ses ${rows.length} dernières parties${scope ? ` ${scope}` : ""}${first && last ? ` (du ${day(first.played_at)} au ${day(last.played_at)})` : ""} : `, `${input.player}: their last ${rows.length} games${scope ? ` ${scope}` : ""}${first && last ? ` (from ${day(first.played_at)} to ${day(last.played_at)})` : ""}: `) +
      say(`${wins} victoire${wins > 1 ? "s" : ""}, ${decided.length - wins} défaite${decided.length - wins > 1 ? "s" : ""}, KDA ${frNumber(kda)} (${per(kills)} / ${per(deaths)} / ${per(assists)} par partie).`, `${wins} win${wins === 1 ? "" : "s"}, ${decided.length - wins} loss${decided.length - wins === 1 ? "" : "es"}, KDA ${frNumber(kda)} (${per(kills)} / ${per(deaths)} / ${per(assists)} per game).`) +
      (run > 1 ? say(` Série en cours : ${run} ${decided[0].win ? "victoires" : "défaites"} de suite.`, ` Current streak: ${run} ${decided[0].win ? "wins" : "losses"} in a row.`) : "") +
      (played.length ? say(` Champions joués : ${played.slice(0, 4).map(([c, n]) => `${c} ×${n}`).join(", ")}.`, ` Champions played: ${played.slice(0, 4).map(([c, n]) => `${c} ×${n}`).join(", ")}.`) : "") +
      (last ? say(` Dernière partie : ${last.win == null ? "résultat n/d" : last.win ? "victoire" : "défaite"}${last.opponent ? ` contre ${displayTeam(last.opponent)}` : ""}${last.champion ? ` sur ${last.champion}` : ""} (${last.league_short}${last.year ? ` ${last.year}` : ""}).`, ` Latest game: ${last.win == null ? "result n/a" : last.win ? "win" : "loss"}${last.opponent ? ` against ${displayTeam(last.opponent)}` : ""}${last.champion ? ` on ${last.champion}` : ""} (${last.league_short}${last.year ? ` ${last.year}` : ""}).`) : "");

    return {
      title: say(`${input.player} — ${rows.length} dernières parties${titleScope(league, input, " (")}`, `${input.player} — last ${rows.length} games${titleScope(league, input, " (")}`),
      table: {
        columns: ["Date", say("Compétition", "Competition"), say("Équipe", "Team"), say("Adversaire", "Opponent"), say("Champion joué", "Champion played"), say("Résultat", "Result"), "K/D/A", "CS", say("Dégâts", "Damage"), say("Durée", "Duration")],
        rows: rows.map((r) => [
          day(r.played_at),
          [`${r.league_short}${r.year ? ` ${r.year}` : ""}`, tabLabel(r.tab)].filter(Boolean).join(" · "),
          r.team ? displayTeam(r.team) : null,
          r.opponent ? displayTeam(r.opponent) : null,
          r.champion,
          r.win == null ? null : r.win ? say("Victoire", "Victory") : say("Défaite", "Defeat"),
          kdaText(r.kills, r.deaths, r.assists),
          r.cs,
          r.damage,
          r.length_s ? clock(r.length_s) : null,
        ]),
      },
      icons: Object.fromEntries(rows.flatMap((r) => (r.champion && r.icon ? [[r.champion, r.icon]] : []))),
      facts,
      sources: [{ label: `Leaguepedia — ${input.player}`, url: wikiUrl(input.player) }, ...eventSources(rows.map((r) => r.event_page).reverse(), 8)],
      followUps: [say(`Champion pool de ${input.player}`, `${input.player}'s champion pool`), ingameFollowUp.player(input.player), say(`Résultats de ${input.player} ${input.league ? inLeague(league) : "aux Worlds"}`, `${input.player}'s results ${input.league ? inLeague(league) : "at Worlds"}`)],
      totals: {
        games: rows.length,
        wins,
        losses: decided.length - wins,
        kda: kda ?? nd(),
        streak: run,
        streak_kind: decided.length ? (decided[0].win ? "wins" : "losses") : "",
        last_champion: last?.champion ?? "",
        last_opponent: last?.opponent ? displayTeam(last.opponent) : "",
      },
    };
  },
  normalize: async (db, input) => {
    const p = await resolvePlayer(db, input.player, { league: input.league, yearFrom: input.yearFrom, yearTo: input.yearTo });

    return p ? { ...input, player: p.player } : null;
  },
};

function defineTool<S extends z.ZodType>(input: S, def: ToolDef<z.infer<S>>) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the registry parsing boundary.
  const bind = async (db: Db, raw: unknown): Promise<BoundTool> => {
    const value = input.parse(raw);
    const plan = await def.plan(db, value);

    return {
      // SAFETY: defineTool captures this definition with its own validated schema.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- TypeScript erases the captured heterogeneous pair.
      call: { tool: def.name, input: value } as unknown as ToolCall,
      label: tr(def.label),
      ...plan,
      relaxations: (entities) => def.relaxations(value, entities).map((r) => ({ ...r, next: () => bind(db, r.input) })),
      format: (formatDb, rows) => def.format(formatDb, value, rows),
    };
  };

  return { input, bind, ai: tool({ description: def.description, inputSchema: input }),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The schema parses dynamic SDK input here.
    normalize: async (db: Db, raw: unknown): Promise<ToolCall | null> => {
      const value = await def.normalize(db, input.parse(raw));

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
  player_runes: defineTool(PlayerRunesInput, playerRunes),
  player_leaderboard: defineTool(PlayerLeaderboardInput, playerLeaderboard),
  tournament_standings: defineTool(StandingsInput, tournamentStandings),
  player_ingame_stats: defineTool(PlayerIngameInput, playerIngameStats),
  ingame_leaderboard: defineTool(LeaderboardInput, ingameLeaderboard),
  team_ingame_stats: defineTool(TeamIngameInput, teamIngameStats),
  dragon_stats: defineTool(DragonStatsInput, dragonStats),
  game_timeline: defineTool(GameTimelineInput, gameTimeline),
  series: defineTool(SeriesInput, series),
  team_leaderboard: defineTool(TeamLeaderboardInput, teamLeaderboard),
  champion_matchup: defineTool(ChampionMatchupInput, championMatchup),
  game_records: defineTool(GameRecordsInput, gameRecords),
  player_recent_games: defineTool(PlayerRecentInput, playerRecentGames),
};

export function bindTool(db: Db, call: ToolCall): Promise<BoundTool> {
  return TOOLS[call.tool].bind(db, call.input);
}

type AiTools = { [K in ToolName]: (typeof TOOLS)[K]["ai"] };

// SAFETY: entries preserve each registry key and its own AI SDK tool.
export const aiTools = Object.fromEntries(Object.entries(TOOLS).map(([name, def]) => [name, def.ai])) as AiTools;

export function normalizeToolCall(db: Db, call: StaticToolCall<typeof aiTools>): Promise<ToolCall | null> {
  return TOOLS[call.toolName].normalize(db, call.input);
}

export const takesSplit = (tool: ToolName): boolean => "split" in TOOLS[tool].input.shape;

export function withSplit(call: ToolCall, split: Split): ToolCall {
  // SAFETY: the schema of call.tool parsed the input, so the pair is still a call of that tool.
  return { tool: call.tool, input: TOOLS[call.tool].input.parse({ ...call.input, split }) } as ToolCall;
}

export async function withLeague(db: Db, call: ToolCall, league: string | null): Promise<ToolCall | null> {
  const def = TOOLS[call.tool];
  const raw = { ...call.input, league };

  return def.input.safeParse(raw).success ? def.normalize(db, raw) : null;
}
