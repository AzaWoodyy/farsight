import type { DatabaseSync } from "node:sqlite";
import { generateText } from "ai";
import { openDb, readSchema } from "../db";
import { DDRAGON_BASE } from "../sources/ddragon";
import { wikiUrl } from "../sources/leaguepedia";
import { type DecideOutcome, type Decider, decide, describeAttempts } from "./decide";
import { guardQuery } from "./guard";
import { getLlm, LLM_CALL } from "./llm";
import { buildQuery, candidatePlayer, correctQuery } from "./query";
import type {
  Answer,
  ChampionPlay,
  Entities,
  QueryPlan,
  ResultRow,
  Source,
  StepName,
  StepPart,
  TraceEntry,
  TraceStatus,
} from "./types";
import { understandQuestion } from "./understand";

const MAX_ATTEMPTS = 3;

export type AgentEvent = { type: "step"; part: StepPart } | { type: "answer"; answer: Answer };
export type Emit = (event: AgentEvent) => void;

const entry = (e: Omit<TraceEntry, "at">): TraceEntry => ({ ...e, at: new Date().toISOString() });

/** Trace line for a `decide()` outcome: what was decided, at which level, with what confidence. */
const decisionEntry = <T>(d: DecideOutcome<T>, title: string, status: TraceStatus = "ok", extra?: string): TraceEntry =>
  entry({
    status,
    title,
    level: d.level,
    confidence: d.confidence,
    detail: [extra, d.reason, `cascade : ${describeAttempts(d.attempts)}`].filter(Boolean).join("\n"),
  });

/** A step streamed to the UI: opened as `running`, updated in place, closed as `done`. */
class Step {
  private part: StepPart;
  constructor(
    name: StepName,
    title: string,
    private emit: Emit,
  ) {
    this.part = { step: name, state: "running", status: "ok", title, entries: [] };
    this.flush();
  }
  add(e: TraceEntry) {
    this.part.entries.push(e);
    this.flush();
  }
  done(status: TraceStatus, title: string) {
    this.part = { ...this.part, state: "done", status, title };
    this.flush();
  }
  private flush() {
    this.emit({ type: "step", part: structuredClone(this.part) });
  }
}

// 1. Understand ---------------------------------------------------------------
async function understand(db: DatabaseSync, question: string, emit: Emit, notes: string[]) {
  const step = new Step("understand", "Analyse de la question…", emit);
  const decision = await understandQuestion(db, question);
  const entities = decision!.result;

  if (!entities.league) {
    entities.league = "World Championship";
    entities.leagueShort = "Worlds";
    notes.push("Aucune compétition précisée : recherche sur les Worlds.");
  }
  if (entities.players.length > 1)
    notes.push(
      `Plusieurs joueurs reconnus : seul ${entities.players[0].player} est traité (les comparaisons arrivent dans un prochain jalon).`,
    );

  const lines = [
    ...entities.players.map((p) => {
      const ids = [p.realName, p.nativeName].filter(Boolean).join(" · ");
      const via = p.mention === p.player ? "" : ` via l'alias « ${p.matchedAlias} »`;
      const others = p.otherCandidates.length ? ` ; homonymes : ${p.otherCandidates.join(", ")}` : "";
      return `joueur « ${p.mention} » → ${p.player}${ids ? ` (${ids})` : ""}${via}${others}`;
    }),
    ...entities.unresolved.map((m) => `« ${m} » : aucun joueur connu`),
    `compétition → ${entities.league}${entities.leagueMention ? ` (« ${entities.leagueMention} »)` : " (par défaut)"}`,
    `période → ${entities.yearFrom ?? "début"} – ${entities.yearTo ?? "aujourd'hui"}`,
  ];
  const ok = entities.players.length > 0;
  step.add(decisionEntry(decision!, ok ? "Entités reconnues" : "Aucun joueur reconnu", ok ? "ok" : "warn", lines.join("\n")));
  step.done(ok ? "ok" : "warn", ok ? `${entities.players[0].player} · ${entities.leagueShort}` : "Aucun joueur reconnu");
  return entities;
}

// 2. Build (typed tool or text-to-SQL) + guard ---------------------------------
async function build(db: DatabaseSync, question: string, entities: Entities, emit: Emit) {
  const step = new Step("build", "Construction de la requête…", emit);
  const decision = await buildQuery({ db, question, entities });
  if (!decision) {
    step.add(
      entry({
        status: "warn",
        title: "Aucun outil typé ne couvre la question",
        detail: getLlm()
          ? "Le text-to-SQL n'a rien produit."
          : "Mode déterministe (pas de OPENROUTER_API_KEY) : le text-to-SQL de secours est désactivé.",
      }),
    );
    step.done("warn", "Pas de requête");
    return null;
  }
  const plan = decision.result;
  step.add(
    decisionEntry(
      decision,
      plan.intent === "sql" ? "Requête générée (text-to-SQL)" : "Outil typé : historique joueur × compétition",
      "ok",
      `${plan.sql}\n\nparamètres : ${JSON.stringify(plan.params)}`,
    ),
  );
  step.done("ok", plan.intent === "sql" ? "text-to-SQL" : "outil typé player_event_history");
  return plan;
}

// 3. Execute + self-correct ----------------------------------------------------
async function execute(db: DatabaseSync, question: string, entities: Entities, first: QueryPlan, emit: Emit, notes: string[]) {
  const step = new Step("execute", "Exécution…", emit);
  const schema = readSchema(db);
  let plan = first;

  for (;;) {
    const guard = guardQuery(db, schema, plan.sql);
    let problem: { kind: "guard" | "error" | "empty"; message: string };
    if (!guard.ok) {
      problem = { kind: "guard", message: guard.issues.join("\n") };
      step.add(entry({ status: "error", title: `Tentative ${plan.attempt} : rejetée par le garde-fou`, detail: problem.message }));
    } else {
      step.add(entry({ status: "ok", title: `Tentative ${plan.attempt} : garde-fou OK (lecture seule, 1 instruction, liste blanche, LIMIT forcé, prepare)` }));
      const started = performance.now();
      try {
        const rows = db.prepare(guard.sql).all(plan.params) as Record<string, unknown>[];
        const ms = Math.round(performance.now() - started);
        if (rows.length) {
          step.add(entry({ status: "ok", title: `${rows.length} ligne(s) en ${ms} ms` }));
          step.done(plan.attempt > 1 ? "fix" : "ok", `${rows.length} ligne(s)${plan.attempt > 1 ? `, après ${plan.attempt - 1} correction(s)` : ""}`);
          return { rows, plan };
        }
        problem = { kind: "empty", message: "résultat vide" };
        step.add(entry({ status: "warn", title: `Résultat vide (${ms} ms)` }));
      } catch (err) {
        problem = { kind: "error", message: (err as Error).message };
        step.add(entry({ status: "error", title: "Erreur SQLite", detail: problem.message }));
      }
    }

    if (plan.attempt >= MAX_ATTEMPTS) {
      step.done("error", `Abandon après ${plan.attempt} tentatives`);
      return { rows: [], plan };
    }
    const fix = await correctQuery({ db, question, entities, plan, problem });
    if (!fix) {
      step.add(entry({ status: "error", title: "Aucune correction possible", detail: problem.message }));
      step.done(problem.kind === "empty" ? "warn" : "error", problem.kind === "empty" ? "Aucune ligne" : "Échec");
      return { rows: [], plan };
    }
    if (fix.result.note) notes.push(fix.result.note);
    plan = fix.result.plan;
    step.add(decisionEntry(fix, `Auto-correction : ${fix.reason}`, "fix", `${problem.message}\n→\n${plan.sql}`));
  }
}

// 4. Format -------------------------------------------------------------------
function placeLabel(place: string | null): string {
  if (!place) return "Classement non publié";
  if (place === "1") return "Champion";
  if (place === "2") return "Finaliste";
  if (place === "3-4") return "Demi-finale";
  if (place === "5-8") return "Quart de finale";
  return `Éliminé (${place}e)`;
}
const displayTeam = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

type SummaryInput = { question: string; facts: string; rows: unknown };

const templateSummary: Decider<SummaryInput, string> = {
  level: "rules",
  name: "modèle de phrase",
  run: ({ facts }) => ({ result: facts, confidence: 0.7, level: "rules", reason: "synthèse à partir des agrégats" }),
};

const llmSummary: Decider<SummaryInput, string> = {
  level: "llm",
  name: "rédaction",
  run: async ({ question, facts, rows }) => {
    const llm = getLlm();
    if (!llm) return null;
    const { text } = await generateText({
      model: llm.model,
      instructions:
        "Rédige une ou deux phrases de synthèse en français à partir de ces données. N'ajoute aucun fait absent des données.",
      prompt: JSON.stringify({ question, facts, rows }),
      maxOutputTokens: 300,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: AbortSignal.timeout(LLM_CALL.timeoutMs),
    });
    return text.trim() ? { result: text.trim(), confidence: 0.85, level: "llm", reason: llm.id } : null;
  },
};

async function format(
  db: DatabaseSync,
  question: string,
  entities: Entities,
  plan: QueryPlan | null,
  raw: Record<string, unknown>[],
  emit: Emit,
  notes: string[],
): Promise<Answer> {
  const step = new Step("format", "Mise en forme…", emit);
  const league = entities.leagueShort ?? entities.league ?? "Worlds";
  const player = plan ? candidatePlayer(entities, plan.candidate) : entities.players[0]?.player;
  const examples = ["Résultats de Chovy à tous les Worlds", "Résultats de Faker à tous les Worlds"];

  if (!raw.length || !plan) {
    step.add(entry({ status: "warn", title: "Réponse vide mise en forme" }));
    step.done("warn", "Pas de résultat");
    return {
      title: player ? `${player} — ${league}` : "Pas de résultat",
      summary: player
        ? `Aucune partie de ${player} trouvée pour ${entities.league} dans la base.`
        : "Je n'ai reconnu aucun joueur dans la question. Essaie avec un pseudo (Faker), un nom réel (Lee Sang-hyeok) ou en hangul (이상혁).",
      rows: [],
      table: null,
      sources: [],
      followUps: examples,
      notes,
    };
  }

  // Text-to-SQL result: generic table.
  if (plan.intent === "sql") {
    const columns = Object.keys(raw[0]);
    step.add(entry({ status: "ok", title: `Tableau générique (${raw.length} lignes, ${columns.length} colonnes)` }));
    step.done("ok", `${raw.length} lignes`);
    return {
      title: question,
      summary: `${raw.length} ligne(s) renvoyée(s) par une requête générée, validée par le garde-fou.`,
      rows: [],
      table: { columns, rows: raw.map((r) => columns.map((c) => r[c])) },
      sources: [{ label: "Leaguepedia", url: wikiUrl("League of Legends Esports Wiki") }],
      followUps: examples,
      notes,
    };
  }

  const rows: ResultRow[] = raw.map((r) => {
    const champions = (JSON.parse(String(r.champions)) as (Omit<ChampionPlay, "imageUrl"> & { icon: string | null })[]).map(
      ({ icon, ...c }) => ({ ...c, imageUrl: icon }),
    );
    const place = r.place == null ? null : String(r.place);
    return {
      year: Number(r.year),
      event: String(r.event_page),
      team: String(r.team),
      place,
      placeLabel: placeLabel(place),
      placeNumber: r.place_number == null ? null : Number(r.place_number),
      wins: Number(r.wins),
      losses: Number(r.losses),
      champions,
    };
  });

  const wins = rows.reduce((n, r) => n + r.wins, 0);
  const losses = rows.reduce((n, r) => n + r.losses, 0);
  const teams = [...new Set(rows.map((r) => displayTeam(r.team)))];
  const ranked = rows.filter((r) => r.placeNumber != null);
  const best = ranked.length ? Math.min(...ranked.map((r) => r.placeNumber!)) : null;
  const bestRows = ranked.filter((r) => r.placeNumber === best);
  const years = rows.map((r) => r.year);
  const unranked = rows.filter((r) => r.place == null);

  let facts =
    `${player} a disputé ${new Set(rows.map((r) => r.event)).size} éditions ${league === "Worlds" ? "des Worlds" : `de ${league}`} (${Math.min(...years)}–${Math.max(...years)}) ` +
    `avec ${teams.length} équipe${teams.length > 1 ? "s" : ""} (${teams.join(", ")}), ` +
    `pour un bilan de ${wins} victoires et ${losses} défaites en parties (${Math.round((100 * wins) / Math.max(1, wins + losses))} %).`;
  if (bestRows.length)
    facts += ` Meilleur résultat : ${placeLabel(bestRows[0].place).toLowerCase()} en ${bestRows
      .map((r) => `${r.year} (${displayTeam(r.team)})`)
      .join(", ")}.`;
  if (unranked.length) facts += ` Classement final ${unranked.map((r) => r.year).join(", ")} pas encore publié sur Leaguepedia.`;

  const summary = (await decide({ question, facts, rows }, [templateSummary, llmSummary], { threshold: 0.8 }))!;
  step.add(decisionEntry(summary, `Synthèse (${summary.level === "llm" ? "LLM" : "modèle de phrase"})`));

  // Follow-ups stay within what the agent supports: teammates of the latest run.
  const latest = rows[rows.length - 1];
  const teammates = (
    db
      .prepare(
        `SELECT player, COUNT(*) AS n FROM v_game_players
         WHERE event_page = ? AND team = ? AND player <> ? AND stage <> 'qualifier'
         GROUP BY player ORDER BY n DESC LIMIT 2`,
      )
      .all(latest.event, latest.team, player ?? "") as { player: string }[]
  ).map((r) => r.player);

  const sources: Source[] = [
    { label: `Leaguepedia — ${player}`, url: wikiUrl(player ?? "") },
    ...[...new Set(rows.map((r) => r.event))].map((page) => ({ label: `Leaguepedia — ${page}`, url: wikiUrl(page) })),
    { label: "Riot Data Dragon — champions", url: `${DDRAGON_BASE}/api/versions.json` },
  ];
  step.add(entry({ status: "ok", title: `Tableau de ${rows.length} lignes, ${sources.length} sources, ${teammates.length + 1} suites` }));
  step.done("ok", `${rows.length} lignes · ${sources.length} sources`);

  return {
    title: `${player} — ${league}`,
    summary: summary.result,
    rows,
    table: null,
    sources,
    followUps: [
      `${player} ${league === "Worlds" ? "aux Worlds" : `en ${league}`} ${bestRows[0]?.year ?? latest.year}`,
      ...teammates.map((m) => `Résultats de ${m} ${league === "Worlds" ? "à tous les Worlds" : `en ${league}`}`),
    ],
    notes,
  };
}

/** Runs the four steps, emitting each step's progress and the final answer. */
export async function runAgent(question: string, emit: Emit): Promise<Answer> {
  const db = openDb();
  const notes: string[] = [];
  const entities = await understand(db, question, emit, notes);
  let rows: Record<string, unknown>[] = [];
  let plan: QueryPlan | null = null;

  const first = await build(db, question, entities, emit);
  if (first) {
    const result = await execute(db, question, entities, first, emit, notes);
    rows = result.rows;
    plan = result.plan;
  } else {
    const step = new Step("execute", "Exécution…", emit);
    step.done("warn", "Rien à exécuter");
  }
  const answer = await format(db, question, entities, plan, rows, emit, notes);
  emit({ type: "answer", answer });
  return answer;
}
