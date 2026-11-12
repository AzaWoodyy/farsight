import type { UIMessage } from "ai";
import type { DecisionLevel } from "./decide";

/** The four visible steps of the agent, in order. */
export const STEPS = ["understand", "build", "execute", "format"] as const;
export type StepName = (typeof STEPS)[number];

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

export type ResolvedChampion = { mention: string; champion: string };

export type Entities = {
  players: ResolvedPlayer[];
  teams: ResolvedTeam[];
  champion: ResolvedChampion | null;
  unresolved: string[];
  league: string | null; // Leaguepedia `League` value (leagues.name)
  leagueShort: string | null;
  leagueMention: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** Spring / Summer / Winter / Finals, when the question names a split. */
  split: string | null;
  /** Out-of-scope competition or game named in the question (LJL, Valorant...). */
  outOfScope: string | null;
};

export type ToolName =
  | "player_event_history"
  | "team_history"
  | "head_to_head"
  | "champion_event_stats"
  | "tournament_standings";

export type Intent = ToolName | "sql";

export type QueryPlan = {
  intent: Intent;
  /** Tool input (validated by the tool's zod schema); empty for text-to-SQL. */
  input: Record<string, unknown>;
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

/** Machine-readable outline of how the answer was produced (eval, debugging). */
export type AnswerMeta = {
  route: Intent | "out_of_scope" | "none";
  /** False when text-to-SQL was needed but no OpenRouter key is configured. */
  sqlAvailable: boolean;
  input: Record<string, unknown>;
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
  table: { columns: string[]; rows: unknown[][] } | null;
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
