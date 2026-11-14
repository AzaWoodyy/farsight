import type { UIMessage } from "ai";
import type { DecisionLevel } from "./decide";
import type { BoundTool, ToolInput } from "./tools";

/** The four visible steps of the agent, in order. */
export const STEPS = ["understand", "build", "execute", "format"] as const;

export type StepName = (typeof STEPS)[number];

/** Leaguepedia `League` values of the fixed scope (leagues.name). */
export const LEAGUE_NAMES = [
  "World Championship",
  "Mid-Season Invitational",
  "LCK Challengers League",
  "LCK Academy Series",
  "LoL Champions Korea",
  "LoL The Champions",
  "Challengers Korea",
  "Tencent LoL Pro League",
  "LoL EMEA Championship",
  "Europe League Championship Series",
  "EMEA Masters",
  "European Masters",
  "North America League Championship Series",
  "League of Legends Championship Series",
  "League of Legends Championship of The Americas North",
  "League of Legends Championship of The Americas",
  "La Ligue Française Division 2",
  "La Ligue Française",
  "LVP SuperLiga 2nd Division",
] as const;

export type LeagueName = (typeof LEAGUE_NAMES)[number];

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

export type ToolName =
  | "player_event_history"
  | "team_history"
  | "head_to_head"
  | "champion_event_stats"
  | "tournament_standings"
  | "player_ingame_stats"
  | "ingame_leaderboard"
  | "team_ingame_stats";

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
};

export type Answer = {
  title: string;
  summary: string;
  /** Player history table (typed tool). */
  rows: ResultRow[];
  /** Generic table (other typed tools and text-to-SQL fallback). */
  table: { columns: string[]; rows: TableCell[][] } | null;
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
  }
>;
