import type { UIMessage } from "ai";
import type { EventKind } from "../sources/timeline";
import type { DecisionLevel } from "./decide";
import type { EmptyReason } from "./empty";
import type { BoundTool, ToolInput } from "./tools";

/** The four visible steps of the agent, in order. */
export const STEPS = ["understand", "build", "execute", "format"] as const;

export type StepName = (typeof STEPS)[number];

export { LEAGUE_NAMES, type LeagueName } from "../domain/leagues";

import type { ItemKind } from "../domain/items";
import type { LeagueName } from "../domain/leagues";

export type TraceStatus = "ok" | "warn" | "error" | "fix";

/** One line inside a step (a decision, a guard check, an attempt...). */
export type TraceEntry = {
  status: TraceStatus;
  title: string;
  detail?: string;
  /** Set when the line comes from `decide()`. */
  level?: DecisionLevel;
  confidence?: number;
  at: string;
};

/** Streamed as a `data-step` part, reconciled by id (= step name). */
export type StepPart = {
  step: StepName;
  state: "running" | "done";
  status: TraceStatus;
  title: string;
  entries: TraceEntry[];
};

export type PlayerCandidate = {
  player: string;
  /** All games in the database. */
  games: number;
  /** Games in the competition / period of the question. */
  contextGames: number;
  /** The mention matches this player's handle with the same case ("caPs" vs "Caps"). */
  exactCase: boolean;
};

/** Set when an alias designates several players: who was picked, and why. */
export type Ambiguity = {
  candidates: PlayerCandidate[];
  chosenBy: "case" | "context" | "games";
  /** True when the pick is not clear-cut and the answer must offer the alternatives. */
  uncertain: boolean;
  reason: string;
};

export type ResolvedPlayer = {
  mention: string;
  player: string; // canonical Leaguepedia page
  matchedAlias: string;
  realName: string | null;
  nativeName: string | null;
  /** Other players sharing the alias, most likely first. */
  otherCandidates: string[];
  ambiguity: Ambiguity | null;
};

export type ResolvedTeam = {
  mention: string;
  /** Display name (franchise name for renamed teams, e.g. T1). */
  team: string;
  /** Leaguepedia team names covered (e.g. T1 + SK Telecom T1). */
  members: string[];
};

export type Split = "Spring" | "Summer" | "Winter";

export type ResolvedChampion = { mention: string; champion: string };

export type Entities = {
  players: ResolvedPlayer[];
  teams: ResolvedTeam[];
  champion: ResolvedChampion | null;
  /** A second champion named after the first ("Azir contre Orianna"): the one a matchup sets it against. */
  opponentChampion?: ResolvedChampion | null;
  unresolved: string[];
  league: LeagueName | null;
  leagueShort: string | null;
  leagueMention: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** Spring / Summer / Winter, when the question names a split. */
  split: Split | null;
  /** Out-of-scope competition or game named in the question (LJL, Valorant...). */
  outOfScope: string | null;
};

export type { ToolName } from "./tools";

import type { ToolName } from "./tools";

export type Intent = ToolName | "sql";

export type QueryPlan = {
  intent: Intent;
  /** The typed tool bound to its validated input; null for text-to-SQL. */
  tool: BoundTool | null;
  sql: string;
  params: Record<string, string | number>;
  attempt: number;
  /** Corrections already applied (relaxed filters, homonyms tried). */
  relaxed: string[];
};

export type ChampionPlay = {
  name: string;
  games: number;
  wins: number;
  imageUrl: string | null;
};

export type ResultRow = {
  year: number;
  event: string;
  team: string;
  place: string | null;
  placeLabel: string;
  placeNumber: number | null;
  wins: number;
  losses: number;
  champions: ChampionPlay[];
};

export type Source = { label: string; url: string };

/** One cell of a generic table (other typed tools, text-to-SQL). */
export type TableCell = string | number | null;

/** A generic table; `focus` names the column the question asks about (the ranking criterion, the metric asked), which the views bring out. */
export type AnswerTable = { columns: string[]; rows: TableCell[][]; focus?: string };

/** Machine-readable outline of how the answer was produced (eval, debugging). */
export type AnswerMeta = {
  /** missing_data: the question needs data the database does not hold; no figure is given. */
  route: Intent | "out_of_scope" | "missing_data" | "none";
  /** False when text-to-SQL was needed but no OpenRouter key is configured. */
  sqlAvailable: boolean;
  /** Input of the typed tool that answered, null otherwise. */
  input: ToolInput | null;
  players: string[];
  teams: string[];
  champion: string | null;
  league: string | null;
  rowCount: number;
  /** Key aggregates of the answer (wins, losses, champion of an event...). */
  totals: Record<string, string | number>;
  ambiguities: { mention: string; chosen: string; alternatives: string[]; uncertain: boolean }[];
  attempts: number;
  /** Words the rules did not understand, when they put the route in doubt and the LLM router is asked; empty otherwise. */
  unread: string[];
  /** Why an empty answer is empty, read from the question's scope (src/lib/agent/empty.ts); null otherwise. */
  empty: EmptyReason | null;
};

export type Side = "blue" | "red";

/** One game's timeline as the UI draws it (sides are Leaguepedia's: blue = Team1). */
export type TimelineView = {
  /** "Worlds 2024 · finale · game 3" */
  label: string;
  blue: string;
  red: string;
  winner: Side | null;
  durationS: number | null;
  /** Riot API version of the source JSON (4 or 5). */
  version: number;
  /** Blue gold minus red gold, one point per timeline frame. */
  gold: { s: number; diff: number }[];
  events: { s: number; kind: EventKind; side: Side; detail: string | null }[];
};

/**
 * Who a compared player is in the question's scope, read from the database (not from the generated SQL):
 * teams by games played, most played role first.
 */
export type PlayerProfile = {
  player: string;
  teams: string[];
  role: string | null;
};

/** One player's line in a game of a two-player comparison. */
export type VersusSide = {
  team: string | null;
  /** Role in that game (Top, Jungle, Mid, Bot, Support). */
  role: string | null;
  champion: string | null;
  championIcon: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
};

/** A game the two compared players played against each other. */
export type VersusGame = {
  playedAt: number | null;
  /** "LEC 2024 · Summer Playoffs · game 2" */
  label: string;
  /** Player A won the game; null when the result is unknown. */
  winA: boolean | null;
  a: VersusSide;
  b: VersusSide;
  source: Source;
};

/** Two players set against each other (player_comparison tool). Tables use the comparison layout's column names. */
export type VersusView = {
  playerA: string;
  playerB: string;
  /** "en LEC", "aux Worlds", "" for every competition, with the period when the question has one. */
  scope: string;
  /** Column of the statistic the question names ("penta_kills", "avg_deaths"), shown first; null without one. */
  focus: string | null;
  /** Statistics over every game of the scope. */
  global: { columns: string[]; rows: TableCell[][] };
  /** Statistics over their games against each other only; null when they never met in the scope. */
  h2h: { columns: string[]; rows: TableCell[][] } | null;
  /** Of their games against each other, how many they played in the same role, and in which roles. */
  lanes: { same: number; roles: { role: string; games: number }[] };
  /** Their games against each other, newest first. */
  games: VersusGame[];
};

export type ScoreboardItem = { name: string; iconUrl: string };

/** A summoner spell, or a rune of the page; the icon is null when Data Dragon no longer has it (and for stat shards). */
export type ScoreboardSpell = { name: string; iconUrl: string | null };

export const RUNE_KINDS = ["keystone", "primary", "secondary", "shard"] as const;

export type RuneKind = (typeof RUNE_KINDS)[number];

export type ScoreboardRune = { name: string; kind: RuneKind; iconUrl: string | null };

/** One player's line of the end-of-game scoreboard; null when Leaguepedia's scoreboard lacks the field. */
export type ScoreboardPlayer = {
  side: Side;
  role: string | null;
  player: string;
  champion: string | null;
  championIcon: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  gold: number | null;
  cs: number | null;
  damage: number | null;
  vision: number | null;
  keystone: string | null;
  keystoneIcon: string | null;
  /** The two summoner spells, in alphabetical order. */
  spells: ScoreboardSpell[];
  /** The rune page after the keystone, in page order: primary tree, secondary tree, stat shards. Empty when the source lists none. */
  runes: ScoreboardRune[];
  /** Final inventory in Leaguepedia's slot order (trinket excluded when the source omits it). */
  items: ScoreboardItem[];
};

export type ScoreboardTeam = {
  name: string;
  kills: number | null;
  gold: number | null;
  towers: number | null;
  inhibitors: number | null;
  dragons: number | null;
  barons: number | null;
  heralds: number | null;
  grubs: number | null;
  /** French element of each dragon the team killed, in order ("nuage", "océan"); empty without a Riot timeline. */
  dragonKinds: string[];
  /** French element of the dragon soul the team got, null when it got none (or the game has no timeline). */
  soul: string | null;
};

/** End-of-game recap of one game, from Leaguepedia's scoreboard tables (every league, LPL included). */
export type GameScoreboard = {
  label: string;
  durationS: number | null;
  patch: string | null;
  winner: Side | null;
  blue: ScoreboardTeam;
  red: ScoreboardTeam;
  players: ScoreboardPlayer[];
};

/** One series (best-of) between two teams. */
export type TeamSeries = {
  playedAt: number | null;
  /** "LEC 2025 · semaine 3", "Worlds 2024 · finale" */
  label: string;
  /** Names the teams played under then (a renamed team keeps its old name). */
  teamA: string;
  teamB: string;
  winsA: number;
  winsB: number;
  source: Source;
};

/** Two teams' meetings (head_to_head tool): the series, newest first, and their record. */
export type TeamHeadToHead = {
  teamA: string;
  teamB: string;
  /** "en LEC", "aux Worlds en 2024", "" for every competition. */
  scope: string;
  seriesA: number;
  seriesB: number;
  gamesA: number;
  gamesB: number;
  /** Every series of the scope (the record counts them all, the list shows the newest MAX first). */
  seriesCount: number;
  series: TeamSeries[];
};

/** One pick of a game in a series: who played which champion, in Top → Support order. */
export type SeriesPick = {
  role: string | null;
  player: string;
  champion: string | null;
  icon: string | null;
};

/** One game of a series as the best-of view draws it (sides are Leaguepedia's: blue = Team1). */
export type SeriesGame = {
  /** Number of the game in the series (1 to 5). */
  n: number | null;
  playedAt: number | null;
  blue: string;
  red: string;
  winner: Side | null;
  durationS: number | null;
  patch: string | null;
  picks: Record<Side, SeriesPick[]>;
  /** Bans in draft order, empty when Leaguepedia has none for the game. */
  bans: Record<Side, { champion: string; icon: string | null }[]>;
  /** The game's Riot data page when Leaguepedia has one, else the tournament page. */
  source: Source;
};

/** One series (best-of) shown as a unit: its score, then every game. */
export type SeriesDetail = {
  /** "Worlds 2025 · finale" */
  label: string;
  tournamentPage: string;
  playedAt: number | null;
  /** The series winner first when there is one. */
  teamA: string;
  teamB: string;
  winsA: number;
  winsB: number;
  /** 1, 3 or 5 read from the score (wins needed × 2 − 1); null when the series has no winner. */
  bestOf: number | null;
  /** Null when the series is listed without its games (beyond the detailed ones). */
  games: SeriesGame[] | null;
  source: Source;
};

/** The series a question names (series tool): a final, one match, or every series of a phase. */
export type SeriesList = {
  /** "Worlds 2025 · finale", "LCK 2024 · finale · T1 – Gen.G" */
  scope: string;
  /** Every series of the scope, in play order. */
  count: number;
  series: SeriesDetail[];
};

/** One player of a team's roster in a role, over the scope asked. */
export type RosterPlayer = {
  player: string;
  /** "Top", "Jungle", "Mid", "Bot", "Support". */
  role: string;
  games: number;
  wins: number;
  /** The player with the most games in the role. */
  starter: boolean;
  /** Short labels of the tournaments the player played in this role ("Worlds 2014", "OGN Champions · Champions 2014 Summer"). */
  tournaments: string[];
  firstPlayed: number | null;
  lastPlayed: number | null;
  source: Source;
};

/** A team's roster over a period (team_roster tool): who played each role, with their games. */
export type TeamRoster = {
  team: string;
  /** The names the team played under in the scope (a renamed team keeps its old name). */
  names: string[];
  /** "en LCK en 2015", "en 2014", "" for every season. */
  scope: string;
  games: number;
  wins: number;
  /** Tournaments of the scope, in play order, with the team's games in each. */
  tournaments: { label: string; games: number; source: Source }[];
  /** Ordered Top, Jungle, Mid, Bot, Support; inside a role, most games first. */
  players: RosterPlayer[];
};

/** One player's line on a champion: how often and how well they played it. */
export type ChampionPlayer = {
  player: string;
  /** Team of their latest game on the champion. */
  team: string | null;
  games: number;
  wins: number;
  /** (kills + assists) / deaths over those games; null when a figure is missing. */
  kda: number | null;
};

/** One item of a champion's end-of-game inventories: in how many of its games, and how they ended. */
export type ChampionItem = {
  item: string;
  icon: string;
  /** Data Dragon kind (src/lib/domain/items.ts); null for an item Data Dragon does not know. */
  kind: ItemKind | null;
  /** Games on the champion that ended with the item (two copies count once). */
  games: number;
  wins: number;
};

/** A champion's most built items in the scope: final inventories listed by Leaguepedia. */
export type ChampionItems = {
  /** Games on the champion that have an inventory, the share denominator (≤ picks). */
  games: number;
  /** Most games first, every kind; the view filters by kind. */
  items: ChampionItem[];
  /** Why the list is empty or incomplete for part of the scope (no inventory listed, boots of bot laners since 2026). */
  notes: string[];
};

/** A pair of summoner spells taken on the champion. */
export type ChampionSpells = { spells: ScoreboardSpell[]; games: number; wins: number };

/** A rune taken on the champion, in one part of the page (a rune taken as primary and as secondary is two lines). */
export type ChampionRune = { rune: string; kind: RuneKind; tree: string | null; icon: string | null; games: number; wins: number };

/** A champion's summoner spells and runes in the scope, from Leaguepedia's scoreboards. */
export type ChampionSetups = {
  /** Games with the summoner spells, the share denominator of `spells`. */
  spellGames: number;
  /** Most games first. */
  spells: ChampionSpells[];
  /** Games with a keystone, the share denominator of the keystones. */
  keystoneGames: number;
  /** Games with the whole page, the share denominator of the other runes. */
  pageGames: number;
  /** Most games first, every kind; the view filters by kind. */
  runes: ChampionRune[];
  /** Why part of the scope has no runes (none before 2018, keystone only until part of 2020). */
  notes: string[];
};

/** One champion in a competition and period (champion_event_stats tool); null figures are not in the data ("n/d"). */
export type ChampionProfile = {
  champion: string;
  icon: string | null;
  /** "aux Worlds en 2024", "en LCK", with the period when the question has one. */
  scope: string;
  /** Games of the scope, the presence denominator. */
  games: number;
  picks: number;
  bans: number;
  wins: number;
  kda: number | null;
  /** Averages per game played on the champion; `counted` is the number of games that have the figure. */
  averages: { key: string; label: string; value: number | null; signed?: boolean; counted: number }[];
  /** Most games on the champion first. */
  players: ChampionPlayer[];
  /** Roles it was played in, most games first. */
  roles: { role: string; games: number }[];
  /** The part the question is about (items, runes, summoner spells), shown first and large; null for the whole profile. */
  focus: "items" | "runes" | "spells" | null;
  items: ChampionItems;
  setups: ChampionSetups;
};

/** One champion of a pool: how often and how well the player (or the team) played it. */
export type ChampionPoolLine = {
  champion: string;
  icon: string | null;
  games: number;
  wins: number;
  losses: number;
  /** Victories / games, in %. */
  winrate: number;
  /** (kills + assists) / deaths over those games; null when a figure is missing. */
  kda: number | null;
  /** Share of the pool, in %: games on the champion / every pick of the scope. */
  share: number;
  /** Team pool only: who played it, most games first. */
  players: { player: string; games: number }[];
};

/** The champions a player or a team played in a scope (champion_pool tool). */
export type ChampionPool = {
  subject: "player" | "team";
  name: string;
  /** "aux Worlds en 2024", "en LEC en 2025", "" for every competition and season. */
  scope: string;
  /** Games of the player, or of the team. */
  games: number;
  wins: number;
  losses: number;
  /** Every pick of the scope: the games of a player, five per game for a team. */
  picks: number;
  /** Diversity: distinct champions, and the share of the three most played. */
  unique: number;
  top3Share: number;
  /** Most games first. */
  lines: ChampionPoolLine[];
};

export type Answer = {
  title: string;
  summary: string;
  /** Player history table (typed tool). */
  rows: ResultRow[];
  /** Generic table (other typed tools and text-to-SQL fallback). */
  table: AnswerTable | null;
  /** One game's gold curve and key events (game timeline tool). */
  timeline: TimelineView | null;
  /** End-of-game scoreboard of the game a question is about (game timeline tool). */
  scoreboard: GameScoreboard | null;
  /** Two players set against each other: statistics, their games against each other (player_comparison tool). */
  versus: VersusView | null;
  /** Two teams' series against each other (head_to_head tool). */
  teams: TeamHeadToHead | null;
  /** A team's players by role over a period (team_roster tool). */
  roster: TeamRoster | null;
  /** One champion's profile (champion_event_stats tool). */
  champion: ChampionProfile | null;
  /** The champions a player or a team played (champion_pool tool). */
  pool: ChampionPool | null;
  /** Series shown as best-of units, with their games (series tool). */
  series: SeriesList | null;
  /** Champion name → Data Dragon icon, for every champion a table names (champion layouts). */
  icons: Record<string, string>;
  /** Names of `icons` whose image is nearly black ("dark") or nearly white ("light") all over: the view sets it on a contrasting plate when the page has the same tone. */
  iconTones: Record<string, "dark" | "light">;
  /** Database profile of each player the question names, for comparison layouts. */
  profiles: PlayerProfile[];
  sources: Source[];
  followUps: string[];
  notes: string[];
  meta: AnswerMeta;
};

export type AgentUIMessage = UIMessage<
  never,
  {
    step: StepPart;
    answer: Answer;
    /** Sent before the steps when the question is traced: the id the thumbs up / down score points to. */
    trace: { traceId: string; token: string };
  }
>;
