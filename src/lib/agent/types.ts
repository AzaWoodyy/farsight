import type { UIMessage } from "ai";
import type { EventKind } from "../sources/timeline";
import type { DecisionLevel } from "./decide";
import type { EmptyReason } from "./empty";
import type { BoundTool, ToolInput } from "./tools";

export const STEPS = ["understand", "build", "execute", "format"] as const;

export type StepName = (typeof STEPS)[number];

export const QUESTION_MAX_LENGTH = 500;

export { LEAGUE_NAMES, type LeagueName } from "../domain/leagues";

import type { ItemKind } from "../domain/items";
import type { LeagueName } from "../domain/leagues";

export type TraceStatus = "ok" | "warn" | "error" | "fix";

export type TraceEntry = {
  status: TraceStatus;
  title: string;
  detail?: string;
  level?: DecisionLevel;
  confidence?: number;
  at: string;
};

export type StepPart = {
  step: StepName;
  state: "running" | "done";
  status: TraceStatus;
  title: string;
  entries: TraceEntry[];
};

export type PlayerCandidate = {
  player: string;
  games: number;
  contextGames: number;
  exactCase: boolean;
};

export type Ambiguity = {
  candidates: PlayerCandidate[];
  chosenBy: "case" | "context" | "games";
  uncertain: boolean;
  reason: string;
};

export type ResolvedPlayer = {
  mention: string;
  player: string;
  matchedAlias: string;
  realName: string | null;
  nativeName: string | null;
  otherCandidates: string[];
  ambiguity: Ambiguity | null;
};

export type ResolvedTeam = {
  mention: string;
  team: string;
  members: string[];
};

export type Split = "Spring" | "Summer" | "Winter";

export type ResolvedChampion = { mention: string; champion: string };

export type Entities = {
  players: ResolvedPlayer[];
  teams: ResolvedTeam[];
  champion: ResolvedChampion | null;
  opponentChampion?: ResolvedChampion | null;
  unresolved: string[];
  league: LeagueName | null;
  leagueShort: string | null;
  leagueMention: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  split: Split | null;
  outOfScope: string | null;
};

export type { ToolName } from "./tools";

import type { ToolName } from "./tools";

export type Intent = ToolName | "sql";

export type QueryPlan = {
  intent: Intent;
  tool: BoundTool | null;
  sql: string;
  params: Record<string, string | number>;
  attempt: number;
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

export type TableCell = string | number | null;

export type AnswerTable = { columns: string[]; rows: TableCell[][]; focus?: string };

export type AnswerMeta = {
  route: Intent | "out_of_scope" | "missing_data" | "none";
  sqlAvailable: boolean;
  input: ToolInput | null;
  players: string[];
  teams: string[];
  champion: string | null;
  league: string | null;
  rowCount: number;
  totals: Record<string, string | number>;
  ambiguities: { mention: string; chosen: string; alternatives: string[]; uncertain: boolean }[];
  attempts: number;
  unread: string[];
  empty: EmptyReason | null;
};

export type Side = "blue" | "red";

export type TimelineView = {
  label: string;
  blue: string;
  red: string;
  winner: Side | null;
  durationS: number | null;
  version: number;
  gold: { s: number; diff: number }[];
  events: { s: number; kind: EventKind; side: Side; detail: string | null }[];
};

export type PlayerProfile = {
  player: string;
  teams: string[];
  role: string | null;
  photo: PlayerPhoto | null;
};

export type PlayerPhoto = { url: string; year: number | null; source: string };

export type VersusSide = {
  team: string | null;
  role: string | null;
  champion: string | null;
  championIcon: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
};

export type VersusGame = {
  playedAt: number | null;
  label: string;
  winA: boolean | null;
  a: VersusSide;
  b: VersusSide;
  source: Source;
};

export type VersusView = {
  playerA: string;
  playerB: string;
  scope: string;
  focus: string | null;
  global: { columns: string[]; rows: TableCell[][] };
  h2h: { columns: string[]; rows: TableCell[][] } | null;
  lanes: { same: number; roles: { role: string; games: number }[] };
  games: VersusGame[];
};

export type ScoreboardItem = { name: string; iconUrl: string };

export type ScoreboardSpell = { name: string; iconUrl: string | null };

export const RUNE_KINDS = ["keystone", "primary", "secondary", "shard"] as const;

export type RuneKind = (typeof RUNE_KINDS)[number];

export type ScoreboardRune = { name: string; kind: RuneKind; iconUrl: string | null };

export type ScoreboardPlayer = {
  side: Side;
  role: string | null;
  player: string;
  photo: PlayerPhoto | null;
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
  spells: ScoreboardSpell[];
  runes: ScoreboardRune[];
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
  dragonKinds: string[];
  soul: string | null;
};

export type GameScoreboard = {
  label: string;
  durationS: number | null;
  patch: string | null;
  winner: Side | null;
  blue: ScoreboardTeam;
  red: ScoreboardTeam;
  players: ScoreboardPlayer[];
};

export type TeamSeries = {
  playedAt: number | null;
  label: string;
  teamA: string;
  teamB: string;
  winsA: number;
  winsB: number;
  winner: string | null;
  scheduleOnly: boolean;
  forfeitedBy: string | null;
  source: Source;
};

export type TeamHeadToHead = {
  teamA: string;
  teamB: string;
  scope: string;
  seriesA: number;
  seriesB: number;
  gamesA: number;
  gamesB: number;
  seriesCount: number;
  series: TeamSeries[];
};

export type SeriesPick = {
  role: string | null;
  player: string;
  champion: string | null;
  icon: string | null;
};

export type SeriesGame = {
  n: number | null;
  playedAt: number | null;
  blue: string;
  red: string;
  winner: Side | null;
  durationS: number | null;
  patch: string | null;
  picks: Record<Side, SeriesPick[]>;
  bans: Record<Side, { champion: string; icon: string | null }[]>;
  source: Source;
};

export type SeriesDetail = {
  label: string;
  tournamentPage: string;
  playedAt: number | null;
  teamA: string;
  teamB: string;
  winsA: number;
  winsB: number;
  bestOf: number | null;
  games: SeriesGame[] | null;
  scheduleOnly: boolean;
  forfeitedBy: string | null;
  source: Source;
};

export type SeriesList = {
  scope: string;
  count: number;
  series: SeriesDetail[];
};

export type RosterPlayer = {
  player: string;
  role: string;
  games: number;
  wins: number;
  starter: boolean;
  tournaments: string[];
  firstPlayed: number | null;
  lastPlayed: number | null;
  photo: PlayerPhoto | null;
  source: Source;
};

export type TeamRoster = {
  team: string;
  names: string[];
  scope: string;
  games: number;
  wins: number;
  tournaments: { label: string; games: number; source: Source }[];
  players: RosterPlayer[];
};

export type ChampionPlayer = {
  player: string;
  team: string | null;
  games: number;
  wins: number;
  kda: number | null;
};

export type ChampionItem = {
  item: string;
  icon: string;
  kind: ItemKind | null;
  games: number;
  wins: number;
};

export type ChampionItems = {
  games: number;
  items: ChampionItem[];
  notes: string[];
};

export type ChampionSpells = { spells: ScoreboardSpell[]; games: number; wins: number };

export type ChampionRune = { rune: string; kind: RuneKind; tree: string | null; icon: string | null; games: number; wins: number };

export type ChampionSetups = {
  spellGames: number;
  spells: ChampionSpells[];
  keystoneGames: number;
  pageGames: number;
  runes: ChampionRune[];
  notes: string[];
};

export type RunePage = { runes: { rune: string; kind: RuneKind; tree: string | null; icon: string | null }[]; games: number; wins: number };

export type RuneTree = { tree: string; part: "primary" | "secondary"; games: number; wins: number };

export type PlayerRunes = {
  player: string;
  scope: string;
  champion: { name: string; icon: string | null } | null;
  role: string | null;
  games: number;
  wins: number;
  keystoneGames: number;
  pageGames: number;
  runes: ChampionRune[];
  trees: RuneTree[];
  pages: RunePage[];
  notes: string[];
};

export type ChampionProfile = {
  champion: string;
  icon: string | null;
  scope: string;
  games: number;
  picks: number;
  bans: number;
  wins: number;
  kda: number | null;
  averages: { key: string; label: string; value: number | null; signed?: boolean; counted: number }[];
  players: ChampionPlayer[];
  roles: { role: string; games: number }[];
  focus: "items" | "runes" | "spells" | null;
  items: ChampionItems;
  setups: ChampionSetups;
};

export type ChampionPoolLine = {
  champion: string;
  icon: string | null;
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  kda: number | null;
  share: number;
  players: { player: string; games: number }[];
};

export type ChampionPool = {
  subject: "player" | "team";
  name: string;
  scope: string;
  games: number;
  wins: number;
  losses: number;
  picks: number;
  unique: number;
  top3Share: number;
  lines: ChampionPoolLine[];
};

export type Answer = {
  title: string;
  summary: string;
  rows: ResultRow[];
  table: AnswerTable | null;
  timeline: TimelineView | null;
  scoreboard: GameScoreboard | null;
  versus: VersusView | null;
  teams: TeamHeadToHead | null;
  roster: TeamRoster | null;
  champion: ChampionProfile | null;
  pool: ChampionPool | null;
  runes: PlayerRunes | null;
  series: SeriesList | null;
  icons: Record<string, string>;
  iconTones: Record<string, "dark" | "light">;
  teamLeagues: Record<string, string[]>;
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
    trace: { traceId: string; token: string };
  }
>;
