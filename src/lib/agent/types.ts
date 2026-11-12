export type TraceStatus = "ok" | "warn" | "error" | "fix";

export type TraceEntry = {
  node: "understand" | "build_query" | "guard" | "execute" | "correct" | "format";
  title: string;
  detail?: string;
  status: TraceStatus;
  data?: unknown;
  at: string;
};

export type ResolvedPlayer = {
  mention: string;
  player: string; // canonical Leaguepedia page
  matchedAlias: string;
  aliasSource: string;
  realName: string | null;
  nativeName: string | null;
  otherCandidates: string[];
};

export type Entities = {
  players: ResolvedPlayer[];
  unresolved: string[];
  teams: string[];
  league: string | null; // canonical league label in `tournaments.league`
  leagueMention: string | null;
  yearFrom: number | null;
  yearTo: number | null;
};

export type Intent = "player_event_history" | "unsupported";

export type QueryPlan = {
  intent: Intent;
  sql: string;
  params: Record<string, string | number>;
  /** Filters still applied; the corrector removes them one by one. */
  filters: { period: boolean };
  attempt: number;
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
  rows: ResultRow[];
  sources: Source[];
  followUps: string[];
  notes: string[];
};
