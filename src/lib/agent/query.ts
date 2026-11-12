import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSchema } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema } from "./guard";
import { getLlm, LLM_CALL } from "./llm";
import type { Entities, QueryPlan } from "./types";

/**
 * Stages that belong to the competition itself. Regional qualifiers share the
 * `World Championship` / `Mid-Season Invitational` league label on
 * Leaguepedia, and `event` pages only hold standings, so both are excluded.
 */
const COMPETITION_STAGES = "'main_event', 'play_in', 'season', 'playoffs'";

/** Player at index `candidate` of the resolved player + its homonyms. */
export function candidatePlayer(entities: Entities, candidate: number): string | null {
  const p = entities.players[0];
  if (!p) return null;
  return [p.player, ...p.otherCandidates][candidate] ?? null;
}

/**
 * Typed tool: a player's history across editions of a competition (team,
 * final place, game record, champions). Parameterized, still guarded.
 */
export function playerEventHistory(
  entities: Entities,
  options: { period: boolean; candidate?: number },
  attempt: number,
): QueryPlan {
  const candidate = options.candidate ?? 0;
  const params: Record<string, string | number> = {
    player: candidatePlayer(entities, candidate) ?? "",
    league: entities.league ?? "World Championship",
  };
  const periodFilters: string[] = [];
  if (options.period && entities.yearFrom != null) {
    periodFilters.push("AND gp.year >= :yearFrom");
    params.yearFrom = entities.yearFrom;
  }
  if (options.period && entities.yearTo != null) {
    periodFilters.push("AND gp.year <= :yearTo");
    params.yearTo = entities.yearTo;
  }

  const sql = `WITH player_games AS (
  SELECT gp.year, gp.event_page, gp.team, gp.champion, gp.win
  FROM v_game_players gp
  WHERE gp.player = :player
    AND gp.league = :league
    AND gp.stage IN (${COMPETITION_STAGES})
    ${periodFilters.join("\n    ")}
),
champ_counts AS (
  SELECT event_page, team, champion, COUNT(*) AS games, SUM(win) AS wins
  FROM player_games
  GROUP BY event_page, team, champion
)
SELECT pg.year, pg.event_page, pg.team,
       SUM(pg.win) AS wins,
       COUNT(*) - SUM(pg.win) AS losses,
       tr.place, tr.place_number,
       (SELECT json_group_array(json_object('name', c.champion, 'games', c.games, 'wins', c.wins,
                                            'icon', ch.icon_url)
                ORDER BY c.games DESC, c.wins DESC, c.champion)
          FROM champ_counts c LEFT JOIN champions ch ON ch.name = c.champion
         WHERE c.event_page = pg.event_page AND c.team = pg.team) AS champions
FROM player_games pg
LEFT JOIN v_tournament_results tr
  ON tr.event_page = pg.event_page AND tr.team = pg.team
GROUP BY pg.year, pg.event_page, pg.team
ORDER BY pg.year, MIN(pg.event_page)`.replace(/\n\s*\n/g, "\n");

  return {
    intent: "player_event_history",
    sql,
    params,
    filters: { period: options.period && (entities.yearFrom != null || entities.yearTo != null) },
    attempt,
    candidate,
  };
}

/** Schema summary given to the LLM: allow-listed objects only. */
export function schemaPrompt(db: DatabaseSync): string {
  return Object.entries(allowedSchema(readSchema(db)))
    .map(([t, cols]) => `${t}(${cols.join(", ")})`)
    .join("\n");
}

const SQL_RULES =
  "SQLite dialect. One read-only SELECT statement, no trailing semicolon. " +
  "Use only these tables/views and columns. Prefer the v_* views. " +
  "Player names are Leaguepedia page names (v_game_players.player). " +
  "Exclude stage = 'qualifier' unless asked. Keep the result under 200 rows.";

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

// Build step ------------------------------------------------------------------

type BuildInput = { db: DatabaseSync; question: string; entities: Entities };

const typedToolDecider: Decider<BuildInput, QueryPlan> = {
  level: "rules",
  name: "outil typé",
  run: ({ entities }) => {
    if (!entities.players.length) return null;
    return {
      result: playerEventHistory(entities, { period: true }, 1),
      confidence: 0.95,
      level: "rules",
      reason: "intention « historique joueur × compétition » → outil paramétré",
    };
  },
};

const textToSqlDecider: Decider<BuildInput, QueryPlan> = {
  level: "llm",
  name: "text-to-SQL",
  run: async ({ db, question, entities }) => {
    const reply = await askSql(
      db,
      `Question: ${question}\nResolved entities: ${JSON.stringify({
        players: entities.players.map((p) => p.player),
        league: entities.league,
        yearFrom: entities.yearFrom,
        yearTo: entities.yearTo,
      })}`,
    );
    if (!reply) return null;
    return {
      result: { intent: "sql", sql: reply.sql, params: {}, filters: { period: false }, attempt: 1, candidate: 0 },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function buildQuery(input: BuildInput) {
  return decide(input, [typedToolDecider, textToSqlDecider], { threshold: 0.8 });
}

// Self-correction -------------------------------------------------------------

export type CorrectInput = {
  db: DatabaseSync;
  question: string;
  entities: Entities;
  plan: QueryPlan;
  problem: { kind: "guard" | "error" | "empty"; message: string };
};

/** Deterministic fixes: relax the period filter, then try a homonym, then rebuild the template. */
const rulesCorrector: Decider<CorrectInput, { plan: QueryPlan; note?: string }> = {
  level: "rules",
  name: "corrections déterministes",
  run: ({ entities, plan, problem }) => {
    if (plan.intent !== "player_event_history") return null;
    const next = plan.attempt + 1;
    if (problem.kind === "empty") {
      if (plan.filters.period)
        return {
          result: {
            plan: playerEventHistory(entities, { period: false, candidate: plan.candidate }, next),
            note: `Aucune participation entre ${entities.yearFrom ?? "…"} et ${entities.yearTo ?? "…"} : affichage de toutes les éditions.`,
          },
          confidence: 0.9,
          level: "rules",
          reason: "filtre de période retiré",
        };
      const other = candidatePlayer(entities, plan.candidate + 1);
      if (other)
        return {
          result: {
            plan: playerEventHistory(entities, { period: true, candidate: plan.candidate + 1 }, next),
            note: `« ${entities.players[0].mention} » désigne aussi ${other} : résultats de ${other}.`,
          },
          confidence: 0.8,
          level: "rules",
          reason: `alias homonyme essayé : ${other}`,
        };
      return null;
    }
    return {
      result: { plan: playerEventHistory(entities, { period: plan.filters.period, candidate: plan.candidate }, next) },
      confidence: 0.7,
      level: "rules",
      reason: "requête reconstruite depuis le modèle",
    };
  },
};

const llmCorrector: Decider<CorrectInput, { plan: QueryPlan; note?: string }> = {
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
      result: { plan: { ...plan, intent: "sql", sql: reply.sql, params: {}, attempt: plan.attempt + 1 } },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function correctQuery(input: CorrectInput) {
  return decide(input, [rulesCorrector, llmCorrector], { threshold: 0.75 });
}
