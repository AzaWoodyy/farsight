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

export type ResolvedPlayer = {
  mention: string;
  player: string; // canonical Leaguepedia page
  matchedAlias: string;
  realName: string | null;
  nativeName: string | null;
  /** Other players sharing the alias, most games first. */
  otherCandidates: string[];
};

export type Entities = {
  players: ResolvedPlayer[];
  unresolved: string[];
  league: string | null; // Leaguepedia `League` value (leagues.name)
  leagueShort: string | null;
  leagueMention: string | null;
  yearFrom: number | null;
  yearTo: number | null;
};

export type Intent = "player_event_history" | "sql";

export type QueryPlan = {
  intent: Intent;
  sql: string;
  params: Record<string, string | number>;
  /** Filters still applied; the corrector removes them one by one. */
  filters: { period: boolean };
  attempt: number;
  /** Index of the player in `players` + `otherCandidates` tried so far. */
  candidate: number;
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

export type Answer = {
  title: string;
  summary: string;
  /** Player history table (typed tool). */
  rows: ResultRow[];
  /** Generic table (text-to-SQL fallback). */
  table: { columns: string[]; rows: unknown[][] } | null;
  sources: Source[];
  followUps: string[];
  notes: string[];
};

export type AgentUIMessage = UIMessage<
  never,
  {
    step: StepPart;
    answer: Answer;
  }
>;
