import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSchema } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema, VIEWS } from "./guard";
import { getLlm, LLM_CALL } from "./llm";
import { aiTools, type BoundTool, bindTool, normalizeToolCall, type ToolCall } from "./tools";
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

export type Route =
  | { kind: "tool"; call: ToolCall; confidence: number; reason: string; notes: string[] }
  /** `open`: the rules found nothing to route on, so the LLM router may still pick a tool. */
  | { kind: "sql"; reason: string; open?: boolean }
  | { kind: "out_of_scope"; reason: string };

const WORLDS = "World Championship";

/**
 * Deterministic intent routing on the resolved entities and a few cues.
 * Returns a typed tool + input, "sql" when no tool covers the question, or
 * "out_of_scope".
 */
export function routeQuestion(question: string, e: Entities): Route {
  if (e.outOfScope)
    return { kind: "out_of_scope", reason: `« ${e.outOfScope} » n'est pas dans le périmètre (Worlds, MSI, LCK, LPL, LEC, LCS, LFL…)` };
  const nEntities = e.players.length + e.teams.length + (e.champion ? 1 : 0);

  if (nEntities === 0 && !e.league && !LOL_DOMAIN.test(question) && !STANDINGS.test(question))
    return { kind: "out_of_scope", reason: "aucune entité ni notion esport League of Legends dans la question" };

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
  "Use only these views and columns (no other table). " +
  "Player names are Leaguepedia page names (v_game_players.player); league values are Leaguepedia League names (e.g. 'World Championship'). " +
  "Exclude stage = 'qualifier' unless asked; stage = 'event' rows only hold standings. Keep the result under 200 rows.";

const SqlOutput = z.object({ sql: z.string(), explanation: z.string() });

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

export type BuildResult = { plan: QueryPlan; notes: string[] };

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
        "If no tool answers it exactly (other metrics such as kills, gold, durations, or open rankings), call no tool.",
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

    if (!reply) return null;

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
