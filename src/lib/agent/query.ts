import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSchema, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema, VIEWS } from "./guard";
import { getLlm, LLM_CALL } from "./llm";
import { aiTools, type BoundTool, bindTool, normalizeToolCall, type ToolCall } from "./tools";
import { detectMetric, type MetricCue } from "./metrics";
import type { Entities, QueryPlan } from "./types";

// Rules router ----------------------------------------------------------------------

const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

const VERSUS = word("vs\\.?|versus|contre|face [àa]|against|head[- ]to[- ]head|h2h|confrontations?|affrontements?");

const STANDINGS = word(
  "palmar[eè]s|vainqueurs?|gagnants?|winners?|qui a gagn[ée]|who won|classements?|standings|podium|sacr[ée]s?|finale",
);

/** Metrics and open rankings no typed tool computes: they go to text-to-SQL. */
const UNSUPPORTED = word(
  "kills?|kda|morts?|deaths?|assists?|pentakills?|quadrakills?|gold|golds|cs|farm|d[ée]g[âa]ts|damage|vision|wards?|" +
    "dragons?|drakes?|barons?|heralds?|nashor|towers?|tourelles?|dur[ée]e|duration|plus longue?s?|plus courte?s?|" +
    "moyenne|average|first blood|premier sang|patch|items?|objets?|runes?|keystone|sorts?|build|" +
    "le plus de|most|quel joueur|quels joueurs|which players?|quelle [ée]quipe|which team|top \\d+",
);

/** Words that make a question about LoL esports even without a known entity. */
const LOL_DOMAIN = word(
  "lol|league of legends|esports?|e-sports?|joueurs?|players?|[ée]quipes?|teams?|champions?|tournois?|tournaments?|" +
    "parties|games?|matchs?|splits?|playoffs|picks?|bans?|mid|jungle|jungler|adc|bot|support|top ?lane|kills?|pentakills?",
);

/**
 * Concepts people ask about that the database does not hold, each with the
 * view column that would hold it. A concept counts as missing while that
 * column is absent from the live schema, so a rebuild that adds it to the
 * views switches the detection off by itself.
 */
const DATA_CONCEPTS = [
  { label: "les pentakills et autres multi-kills", pattern: word("penta ?kills?|quadra ?kills?|triple ?kills?|multi ?kills?"), view: "v_game_player_stats", column: "penta_kills" },
  { label: "les solo kills", pattern: word("solo ?kills?"), view: "v_game_player_stats", column: "solo_kills" },
  { label: "le first blood", pattern: word("first ?blood|premier sang"), view: "v_game_player_stats", column: "first_blood_kill" },
  { label: "les wards posées ou détruites", pattern: word("wards?"), view: "v_game_player_stats", column: "wards_placed" },
  {
    label: "les objectifs par partie (dragons, barons, hérauts, tourelles, inhibiteurs)",
    pattern: word("dragons?|drakes?|barons?|nashor|h[ée]rauts?|heralds?|towers?|tourelles?|inhibiteurs?|inhibitors?|grubs?|larves?|atakhans?"),
    view: "v_games",
    column: "blue_dragons",
  },
  { label: "les sorts d'invocateur", pattern: word("sorts? d'invocateurs?|summoner spells?"), view: "v_game_players", column: "spell1" },
  { label: "les distinctions MVP et joueur du match", pattern: word("mvps?|pogs?|player of the (?:game|match)|joueurs? du match"), view: "v_game_players", column: "mvp" },
] as const;

/** The concepts of the question that no column of the schema holds. */
export function missingConcepts(question: string, schema: Record<string, string[]>): string[] {
  return DATA_CONCEPTS.flatMap((c) => (c.pattern.test(question) && !(schema[c.view] ?? []).includes(c.column) ? [c.label] : []));
}

/** Games of a scope and how many have in-game (Riot) data. */
export type Coverage = { games: number; ingame: number };

/** Coverage lookups for the router, read from v_ingame_coverage and v_games. */
export type CoverageLookup = {
  league: (league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage;
  player: (player: string, league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage;
};

const CoverageRow = z.object({ games: z.number().nullable(), ingame: z.number().nullable() });

const period = (col: string, yearFrom: number | null, yearTo: number | null, params: (string | number)[]) => {
  let sql = "";

  if (yearFrom != null) {
    sql += ` AND ${col} >= ?`;
    params.push(yearFrom);
  }

  if (yearTo != null) {
    sql += ` AND ${col} <= ?`;
    params.push(yearTo);
  }

  return sql;
};

/** Coverage read from the database (league and period, or one player's games). */
export function coverageLookup(db: DatabaseSync): CoverageLookup {
  const read = (sql: string, params: (string | number)[]): Coverage => {
    const row = selectOne(db, CoverageRow, sql, params);

    return { games: row?.games ?? 0, ingame: row?.ingame ?? 0 };
  };

  return {
    league: (league, yearFrom, yearTo) => {
      const params: (string | number)[] = [];
      const where = league ? (params.push(league), "league = ?") : "1";

      return read(`SELECT SUM(games) AS games, SUM(ingame_games) AS ingame FROM v_ingame_coverage WHERE ${where}${period("year", yearFrom, yearTo, params)}`, params);
    },
    player: (player, league, yearFrom, yearTo) => {
      const params: (string | number)[] = [player];
      const where = league ? (params.push(league), " AND p.league = ?") : "";

      return read(
        `SELECT COUNT(*) AS games, SUM(g.has_ingame) AS ingame FROM v_game_players p JOIN v_games g ON g.game_id = p.game_id
         WHERE p.player = ?${where}${period("p.year", yearFrom, yearTo, params)}`,
        params,
      );
    },
  };
}

const RANKING = word(
  "le plus|la plus|les plus|le moins|most|meilleure?s?|best|top ?\\d+|classement|leaderboard|record|quels? joueurs?|quelles? [ée]quipes?|which (?:players?|teams?)|qui (?:a|fait|prend|prennent)",
);

const TEAM_WORDS = word("[ée]quipes?|teams?");

const ROLE_CUES = [
  { role: "Support", pattern: word("supports?") },
  { role: "Mid", pattern: word("mid ?laners?|mids") },
  { role: "Jungle", pattern: word("junglers?|jungles") },
  { role: "Bot", pattern: word("adcs?|bot ?laners?|ad carr(?:y|ies)") },
  { role: "Top", pattern: word("top ?laners?|toplaners?") },
] as const;

/** Leagues of the scope (short names), period words aside: "la LPL", "le MSI 2024". */
const scopeOf = (e: Entities) => (e.leagueShort ? (e.leagueShort === "Worlds" ? "les Worlds" : `la ${e.leagueShort}`) : "cette compétition");

/**
 * In-game questions (Riot data): the typed in-game tools, or "missing" when
 * the scope has no in-game data at all (the LPL, older seasons, some events).
 */
function routeIngame(question: string, e: Entities, cue: MetricCue, coverage: CoverageLookup): Route | null {
  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const league = e.league;
  const what = `les statistiques in-game (${cue.mention})`;

  if (league && coverage.league(league, e.yearFrom, e.yearTo).ingame === 0)
    return {
      kind: "missing",
      concepts: [`${what} pour ${scopeOf(e)}`],
      reason: `aucune partie de ${e.leagueShort ?? league} ${e.yearFrom ?? ""} avec données Riot sur Leaguepedia`.replace(/\s+/g, " "),
      coverage: true,
    };

  if (e.players.length === 1 && e.teams.length === 0 && !e.champion) {
    const p = e.players[0].player;

    if (!cue.player) return { kind: "sql", reason: `métrique d'équipe (« ${cue.mention} ») demandée pour un joueur` };

    if (coverage.player(p, league, e.yearFrom, e.yearTo).ingame === 0)
      return {
        kind: "missing",
        concepts: [`${what} de ${p}${league ? ` en ${e.leagueShort}` : ""}`],
        reason: `aucune partie de ${p} avec données Riot dans ce périmètre`,
        coverage: true,
      };

    return {
      kind: "tool",
      call: { tool: "player_ingame_stats", input: { player: p, league, ...period, metric: cue.player, minute: cue.minute } },
      confidence: 0.9,
      reason: `statistique in-game d'un joueur (« ${cue.mention} »)`,
      notes: [],
    };
  }

  if (e.teams.length === 1 && e.players.length === 0 && !e.champion) {
    if (!cue.team) return { kind: "sql", reason: `métrique individuelle (« ${cue.mention} ») demandée pour une équipe` };

    return {
      kind: "tool",
      call: { tool: "team_ingame_stats", input: { team: e.teams[0].team, league, ...period, minute: cue.minute } },
      confidence: 0.85,
      reason: `profil in-game d'une équipe (« ${cue.mention} »)`,
      notes: [],
    };
  }

  if (e.players.length + e.teams.length === 0 && !e.champion && RANKING.test(question)) {
    const team = (TEAM_WORDS.test(question) && cue.team != null) || cue.player == null;
    const metric = team ? cue.team : cue.player;

    if (!metric) return null;
    const role = team ? null : (ROLE_CUES.find((r) => r.pattern.test(question))?.role ?? null);

    return {
      kind: "tool",
      call: { tool: "ingame_leaderboard", input: { subject: team ? "team" : "player", metric, minute: cue.minute, league, ...period, role, minGames: null } },
      confidence: 0.85,
      reason: `classement sur une statistique in-game (« ${cue.mention} »)`,
      notes: league ? [] : ["Aucune compétition précisée : classement sur toutes les compétitions avec données in-game."],
    };
  }

  return { kind: "sql", reason: `statistique in-game (« ${cue.mention} ») sans outil typé pour ces entités` };
}

export type Route =
  | { kind: "tool"; call: ToolCall; confidence: number; reason: string; notes: string[] }
  /** The question needs data the database does not hold: answered without a query. `coverage`: in-game data, absent for this scope only. */
  | { kind: "missing"; concepts: string[]; reason: string; coverage?: boolean }
  /** `open`: the rules found nothing to route on, so the LLM router may still pick a tool. */
  | { kind: "sql"; reason: string; open?: boolean }
  | { kind: "out_of_scope"; reason: string };

const WORLDS = "World Championship";

/**
 * Deterministic intent routing on the resolved entities and a few cues.
 * Returns a typed tool + input, "sql" when no tool covers the question,
 * "missing" when the data is not in the database, or "out_of_scope".
 */
export function routeQuestion(question: string, e: Entities, schema: Record<string, string[]>, coverage: CoverageLookup): Route {
  if (e.outOfScope)
    return { kind: "out_of_scope", reason: `« ${e.outOfScope} » n'est pas dans le périmètre (Worlds, MSI, LCK, LPL, LEC, LCS, LFL…)` };
  const nEntities = e.players.length + e.teams.length + (e.champion ? 1 : 0);

  if (nEntities === 0 && !e.league && !LOL_DOMAIN.test(question) && !STANDINGS.test(question))
    return { kind: "out_of_scope", reason: "aucune entité ni notion esport League of Legends dans la question" };

  const missing = missingConcepts(question, schema);

  if (missing.length) return { kind: "missing", concepts: missing, reason: `donnée absente de la base : ${missing.join(", ")}` };

  const cue = schema.v_game_player_stats ? detectMetric(question) : null;
  const ingame = cue ? routeIngame(question, e, cue, coverage) : null;

  if (ingame) return ingame;

  if (UNSUPPORTED.test(question))
    return { kind: "sql", reason: `métrique ou classement non couvert par les outils typés (« ${UNSUPPORTED.exec(question)![0]} »)` };

  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const notes: string[] = [];

  const defaultLeague = () => {
    if (e.league) return e.league;
    notes.push("Aucune compétition précisée : recherche sur les Worlds.");

    return WORLDS;
  };

  const versus = VERSUS.test(question);

  if (e.players.length >= 2) {
    if (e.players.length > 2) notes.push(`Plusieurs joueurs reconnus : seuls ${e.players[0].player} et ${e.players[1].player} sont comparés.`);

    return {
      kind: "tool",
      call: { tool: "head_to_head", input: { kind: "player", sideA: e.players[0].player, sideB: e.players[1].player, league: e.league, ...period } },
      confidence: 0.9,
      reason: "deux joueurs → confrontations",
      notes,
    };
  }

  if (e.teams.length >= 2)
    return {
      kind: "tool",
      call: { tool: "head_to_head", input: { kind: "team", sideA: e.teams[0].team, sideB: e.teams[1].team, league: e.league, ...period } },
      confidence: 0.9,
      reason: "deux équipes → confrontations",
      notes,
    };

  if (e.players.length === 1 && e.teams.length === 1 && versus)
    return { kind: "sql", reason: "confrontation joueur contre équipe : pas d'outil typé" };

  if (e.champion && (e.players.length || e.teams.length))
    return { kind: "sql", reason: "champion joué par un joueur ou une équipe précis : pas d'outil typé" };

  if (e.champion)
    return {
      kind: "tool",
      call: { tool: "champion_event_stats", input: { champion: e.champion.champion, league: defaultLeague(), ...period } },
      confidence: 0.9,
      reason: "champion seul → stats du champion dans la compétition",
      notes,
    };

  if (e.players.length === 1) {
    if (e.teams.length) notes.push(`Équipe « ${e.teams[0].mention} » ignorée : historique de ${e.players[0].player} toutes équipes confondues.`);

    return {
      kind: "tool",
      call: { tool: "player_event_history", input: { player: e.players[0].player, league: defaultLeague(), ...period } },
      confidence: versus ? 0.7 : 0.95,
      reason: versus ? "un seul joueur reconnu pour une confrontation" : "intention « historique joueur × compétition » → outil paramétré",
      notes,
    };
  }

  if (e.teams.length === 1)
    return {
      kind: "tool",
      call: { tool: "team_history", input: { team: e.teams[0].team, league: e.league, ...period } },
      confidence: versus ? 0.7 : 0.9,
      reason: versus ? "une seule équipe reconnue pour une confrontation" : "équipe seule → historique d'équipe",
      notes,
    };

  if (e.league || STANDINGS.test(question)) {
    const league = defaultLeague();
    const oneYear = e.yearFrom != null && e.yearFrom === e.yearTo;
    const international = league === WORLDS || league === "Mid-Season Invitational";

    return {
      kind: "tool",
      call: { tool: "tournament_standings", input: { league, ...period, split: e.split, full: oneYear && (international || e.split != null) } },
      confidence: STANDINGS.test(question) || oneYear ? 0.9 : 0.75,
      reason: "compétition sans joueur ni équipe → palmarès / classement",
      notes,
    };
  }

  return { kind: "sql", reason: "aucun outil typé ne correspond aux entités reconnues", open: true };
}

// Plans -------------------------------------------------------------------------------

export function toolPlan(tool: BoundTool, attempt: number, relaxed: string[] = []): QueryPlan {
  return { intent: tool.call.tool, tool, sql: tool.sql, params: tool.params, attempt, relaxed };
}


/** Schema summary given to the LLM: the v_* views only (generated SQL may read nothing else). */
export function schemaPrompt(db: DatabaseSync): string {
  return Object.entries(allowedSchema(readSchema(db), VIEWS))
    .map(([t, cols]) => `${t}(${cols.join(", ")})`)
    .join("\n");
}

const SQL_RULES =
  "SQLite dialect. One read-only SELECT statement, no trailing semicolon. " +
  "In-game stats come from Riot game data and only exist for some games: v_game_player_stats (one row per player and game: " +
  "gold/xp/cs at 10, 15 and 20 minutes and their difference with the lane opponent, kills_10/deaths_10/assists_10 before 10:00, solo_kills, " +
  "first_blood_kill/assist/victim, double to penta kills, wards, control_wards, plates) and v_game_team_stats (one row per team and game: first_* objectives as 0/1, " +
  "team gold and gold difference at 10/15/20, kills_10/15/20, plates). v_ingame_coverage gives games and ingame_games per league and year: " +
  "the LPL (Tencent LoL Pro League) has none. If the question needs in-game stats for a scope whose ingame_games is 0, set `missing`. " +
  "End-of-game objective counts (dragons, barons, towers, heralds, void grubs, inhibitors) are in v_games for every league. " +
  "Use only these views and columns (no other table). " +
  "Player names are Leaguepedia page names (v_game_players.player); league values are Leaguepedia League names (e.g. 'World Championship'). " +
  "Exclude stage = 'qualifier' unless asked; stage = 'event' rows only hold standings. Keep the result under 200 rows. " +
  "If the answer needs data that no listed column holds (for example MVP awards or summoner spells), " +
  "do not approximate it with other columns and do not return a constant: set sql to an empty string and name the missing data, " +
  "in French, in `missing`. Otherwise `missing` is empty. `explanation` is one short sentence.";

const SqlOutput = z.object({ sql: z.string(), explanation: z.string(), missing: z.array(z.string()) });

/** A predicate that is always false: the query states a figure without reading any data. */
const ALWAYS_FALSE = /\b(?:0\s*=\s*1|1\s*=\s*0)\b|\bwhere\s+(?:false|0)\b/i;

/** What a generated query would leave out: the data it says is missing, or a query that reads nothing real. */
function generatedGaps(reply: { sql: string; missing: string[] }): string[] {
  if (reply.missing.length) return reply.missing;

  return !reply.sql || ALWAYS_FALSE.test(reply.sql) ? ["la donnée demandée (la requête générée ne lisait aucune donnée réelle)"] : [];
}

async function askSql(db: DatabaseSync, prompt: string) {
  const llm = getLlm();

  if (!llm) return null;

  const { output } = await generateText({
    model: llm.model,
    output: Output.object({ schema: SqlOutput }),
    instructions: `${SQL_RULES}\nSchema:\n${schemaPrompt(db)}`,
    prompt,
    maxOutputTokens: LLM_CALL.maxOutputTokens,
    maxRetries: LLM_CALL.maxRetries,
    abortSignal: AbortSignal.timeout(LLM_CALL.timeoutMs),
  });

  return { ...output, sql: output.sql.replace(/^```\w*\n?|```$/g, "").trim(), model: llm.id };
}

const entitySummary = (e: Entities) =>
  JSON.stringify({
    players: e.players.map((p) => p.player),
    teams: e.teams.map((t) => t.members),
    champion: e.champion?.champion ?? null,
    league: e.league,
    yearFrom: e.yearFrom,
    yearTo: e.yearTo,
  });

// Build step ------------------------------------------------------------------------

type BuildInput = { db: DatabaseSync; question: string; entities: Entities; route: Route };

/** A query plan, or (text-to-SQL only) the data the database does not hold. */
export type BuildResult = { plan: QueryPlan; notes: string[] } | { plan: null; missing: string[]; notes: string[] };

const rulesRouter: Decider<BuildInput, BuildResult> = {
  level: "rules",
  name: "outil typé",
  run: ({ db, route }) => {
    if (route.kind !== "tool") return null;

    return {
      result: { plan: toolPlan(bindTool(db, route.call), 1), notes: route.notes },
      confidence: route.confidence,
      level: "rules",
      reason: route.reason,
    };
  },
};

/** The LLM picks a typed tool (AI SDK tool calling); no tool call means text-to-SQL. */
const llmRouter: Decider<BuildInput, BuildResult> = {
  level: "llm",
  name: "choix d'outil",
  run: async ({ db, question, entities, route }) => {
    const llm = getLlm();

    if (!llm || (route.kind === "sql" && !route.open)) return null;

    const { toolCalls } = await generateText({
      model: llm.model,
      tools: aiTools,
      toolChoice: "auto",
      instructions:
        "Pick the one tool that answers the League of Legends esports question exactly, with its arguments. " +
        "If no tool answers it exactly (other metrics such as end-of-game kills, durations, objective counts, or open rankings), call no tool.",
      prompt: `Question: ${question}\nResolved entities: ${entitySummary(entities)}`,
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: AbortSignal.timeout(LLM_CALL.timeoutMs),
    });

    // Dynamic calls are unknown or unparsable tool calls: treat them as "no tool".
    const typed = toolCalls.find((c) => !c.dynamic);

    if (!typed || typed.dynamic) return null;
    const call = normalizeToolCall(db, typed);

    if (!call) return null;

    return {
      result: { plan: toolPlan(bindTool(db, call), 1), notes: [] },
      confidence: 0.85,
      level: "llm",
      reason: `${llm.id} : ${call.tool}(${JSON.stringify(call.input)})`,
    };
  },
};

const textToSqlDecider: Decider<BuildInput, BuildResult> = {
  level: "llm",
  name: "text-to-SQL",
  run: async ({ db, question, entities }) => {
    const reply = await askSql(db, `Question: ${question}\nResolved entities: ${entitySummary(entities)}`);

    if (!reply) return null;
    const gaps = generatedGaps(reply);

    if (gaps.length) return { result: { plan: null, missing: gaps, notes: [] }, confidence: 0.8, level: "llm", reason: `${reply.model} : donnée absente` };

    return {
      result: { plan: { intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: 1, relaxed: [] }, notes: [] },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function buildQuery(input: BuildInput) {
  return decide(input, [rulesRouter, llmRouter, textToSqlDecider], { threshold: 0.8 });
}

// Self-correction -------------------------------------------------------------------

export type CorrectInput = {
  db: DatabaseSync;
  question: string;
  entities: Entities;
  plan: QueryPlan;
  problem: { kind: "guard" | "error" | "empty"; message: string };
};

type Fix = { plan: QueryPlan; note?: string };

/** Deterministic fixes for an empty typed result: the tool's relaxations, in order. */
const rulesCorrector: Decider<CorrectInput, Fix> = {
  level: "rules",
  name: "corrections déterministes",
  run: ({ entities, plan, problem }) => {
    if (!plan.tool || problem.kind !== "empty") return null;
    const next = plan.tool.relaxations(entities).find((r) => !plan.relaxed.includes(r.key));

    if (!next) return null;

    return {
      result: { plan: toolPlan(next.next(), plan.attempt + 1, [...plan.relaxed, next.key]), note: next.note },
      confidence: 0.85,
      level: "rules",
      reason: next.reason,
    };
  },
};

/** The LLM repairs a rejected or failing query, or an empty generated one. */
const llmCorrector: Decider<CorrectInput, Fix> = {
  level: "llm",
  name: "réparation SQL",
  run: async ({ db, question, plan, problem }) => {
    if (problem.kind === "empty" && plan.intent !== "sql") return null;

    const reply = await askSql(
      db,
      `Question: ${question}\nThis query ${problem.kind === "empty" ? "returned no rows" : "was rejected"}:\n${plan.sql}\n` +
        `Parameters: ${JSON.stringify(plan.params)}\nProblem: ${problem.message}\n` +
        "Return a corrected query. Inline the parameter values as literals.",
    );

    // A repair that gives up on real data is no repair.
    if (!reply || generatedGaps(reply).length) return null;

    return {
      result: { plan: { ...plan, intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: plan.attempt + 1 } },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function correctQuery(input: CorrectInput) {
  return decide(input, [rulesCorrector, llmCorrector], { threshold: 0.75 });
}
