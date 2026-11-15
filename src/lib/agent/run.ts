import { executeGeneratedQuery, SqlTimeoutError } from "../db/generated-query";
import { periodProblem } from "../domain/years";
import { leagueMembers, SCOPE_LABEL } from "../domain/leagues";
import { claimsBeyondFacts } from "./summary";
import { CHAMPION_COLUMN } from "../champions";
import type { DatabaseSync } from "node:sqlite";
import { generateText } from "ai";
import { z } from "zod";
import { openDb, readSchema, selectAll, type SqlRow } from "../db";
import { wikiUrl } from "../sources/leaguepedia";
import { type DecideOutcome, type Decider, decide, describeAttempts } from "./decide";
import { ALLOWED_OBJECTS, guardQuery, VIEWS } from "./guard";
import { getLlm, LLM_CALL, type LlmStatus, llmStatus, QUOTA_NOTE, llmSignal, requestAborted, withLlmSignal } from "./llm";
import { buildQuery, type CorrectInput, correctQuery, coverageLookup, type Route, routeQuestion } from "./query";
import { buildReport, executeReport, formatReport, recordOutcome, traceStep, understandReport } from "./trace";
import type { Answer, AnswerMeta, Entities, QueryPlan, StepName, StepPart, TraceEntry, TraceStatus } from "./types";
import { playerProfiles } from "./tools";
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

const EXAMPLES = [
  "Résultats de Chovy à tous les Worlds",
  "T1 contre Gen.G en LCK",
  "Stats d'Ahri aux Worlds 2024",
  "Palmarès du MSI",
];

/** Notes and follow-ups for aliases shared by several players: never a silent pick. */
function ambiguityNotes(question: string, entities: Entities) {
  const notes: string[] = [];
  const followUps: string[] = [];
  const ambiguities: AnswerMeta["ambiguities"] = [];

  for (const p of entities.players) {
    if (!p.ambiguity) continue;
    const others = p.ambiguity.candidates.slice(1);
    const shown = p.ambiguity.candidates.slice(0, 4).map((c) => `${c.player} (${c.games} parties)`);
    const list = shown.join(", ") + (p.ambiguity.candidates.length > 4 ? ` et ${p.ambiguity.candidates.length - 4} autres` : "");
    notes.push(
      `« ${p.mention} » désigne plusieurs joueurs : ${list}. Retenu : ${p.player}, ${p.ambiguity.reason}.` +
        (p.ambiguity.uncertain ? " Choix incertain : précise le pseudo si ce n'est pas le bon joueur." : ""),
    );

    for (const o of others.slice(0, 2)) followUps.push(question.replace(p.mention, o.player));
    ambiguities.push({ mention: p.mention, chosen: p.player, alternatives: others.map((o) => o.player), uncertain: p.ambiguity.uncertain });
  }

  return { notes, followUps, ambiguities };
}

// 1. Understand ---------------------------------------------------------------
async function understand(db: DatabaseSync, question: string, emit: Emit, now: Date) {
  const step = new Step("understand", "Analyse de la question…", emit);
  const decision = (await understandQuestion(db, question, now))!;
  const entities = decision.result;

  const lines = [
    ...entities.players.map((p) => {
      const ids = [p.realName, p.nativeName].filter(Boolean).join(" · ");
      const via = p.mention === p.player ? "" : ` via l'alias « ${p.matchedAlias} »`;

      const others = p.otherCandidates.length
        ? ` ; homonymes : ${p.otherCandidates.slice(0, 5).join(", ")}${p.otherCandidates.length > 5 ? "…" : ""} (choix : ${p.ambiguity!.reason}${p.ambiguity!.uncertain ? ", incertain" : ""})`
        : "";

      return `joueur « ${p.mention} » → ${p.player}${ids ? ` (${ids})` : ""}${via}${others}`;
    }),
    ...entities.teams.map(
      (t) => `équipe « ${t.mention} » → ${t.team}${t.members.length > 1 || t.members[0] !== t.team ? ` (${t.members.join(", ")})` : ""}`,
    ),
    ...(entities.champion ? [`champion « ${entities.champion.mention} » → ${entities.champion.champion}`] : []),
    ...entities.unresolved.map((m) => `« ${m} » : aucun joueur connu`),
    `compétition → ${entities.league ?? "non précisée"}${entities.leagueMention ? ` (« ${entities.leagueMention} »)` : ""}`,
    `période → ${entities.yearFrom ?? "début"} – ${entities.yearTo ?? "aujourd'hui"}${entities.split ? ` · split ${entities.split}` : ""}`,
    ...(entities.outOfScope ? [`hors périmètre → « ${entities.outOfScope} »`] : []),
  ];

  const names = [
    ...entities.players.map((p) => p.player),
    ...entities.teams.map((t) => t.team),
    ...(entities.champion ? [entities.champion.champion] : []),
  ];

  const ambiguous = entities.players.some((p) => p.ambiguity);
  const status: TraceStatus = entities.outOfScope ? "warn" : names.length || entities.league ? (ambiguous ? "warn" : "ok") : "warn";
  step.add(decisionEntry(decision, names.length ? "Entités reconnues" : "Aucune entité reconnue", status, lines.join("\n")));
  step.done(
    status,
    entities.outOfScope
      ? `Hors périmètre (${entities.outOfScope})`
      : names.length || entities.league
        ? [names.join(", "), entities.leagueShort].filter(Boolean).join(" · ") + (ambiguous ? " · alias ambigu" : "")
        : "Aucune entité reconnue",
  );

  return entities;
}

// 2. Build (typed tool or text-to-SQL) + guard ---------------------------------
const SQL_FALLBACK_DETAIL: Record<LlmStatus, string> = {
  ready: "Le text-to-SQL n'a rien produit.",
  missing: "Mode déterministe (pas de OPENROUTER_API_KEY) : le text-to-SQL de secours est désactivé.",
  exhausted: "Mode déterministe (quota OpenRouter épuisé) : le text-to-SQL de secours est désactivé pour le moment.",
};

const SQL_FALLBACK_TITLE: Record<LlmStatus, string> = {
  ready: "Pas de requête",
  missing: "text-to-SQL requis (désactivé sans clé)",
  exhausted: "text-to-SQL requis (quota épuisé)",
};

/** `missing` collects the data the database does not hold (rules or text-to-SQL); the answer then gives no figure. */
async function build(db: DatabaseSync, question: string, entities: Entities, route: Route, emit: Emit, notes: string[], missing: string[]) {
  const step = new Step("build", "Construction de la requête…", emit);

  if (route.kind === "out_of_scope") {
    step.add(entry({ status: "warn", title: "Question hors périmètre", detail: route.reason }));
    step.done("warn", "Hors périmètre");

    return null;
  }

  if (route.kind === "missing") {
    missing.push(...route.concepts);
    step.add(entry({ status: "warn", title: "Donnée absente de la base", detail: `${route.reason}\nAucune requête : un chiffre serait inventé.` }));
    step.done("warn", "Donnée absente de la base");

    return null;
  }

  const decision = await buildQuery({ db, question, entities, route });

  if (!decision) {
    const status = llmStatus();
    step.add(
      entry({
        status: "warn",
        title: "Aucun outil typé ne couvre la question",
        detail: [route.reason, SQL_FALLBACK_DETAIL[status]].join("\n"),
      }),
    );
    step.done("warn", SQL_FALLBACK_TITLE[status]);

    return null;
  }

  notes.push(...decision.result.notes);

  if (decision.result.plan === null) {
    missing.push(...decision.result.missing);
    step.add(decisionEntry(decision, "Donnée absente de la base", "warn", decision.result.missing.join("\n")));
    step.done("warn", "Donnée absente de la base");

    return null;
  }

  const { plan } = decision.result;
  const label = plan.tool ? `Outil typé : ${plan.tool.label}` : "Requête générée (text-to-SQL)";
  step.add(
    decisionEntry(
      decision,
      label,
      "ok",
      `${plan.tool ? `${plan.intent}(${JSON.stringify(plan.tool.call.input)})\n\n` : ""}${plan.sql}\n\nparamètres : ${JSON.stringify(plan.params)}`,
    ),
  );
  step.done("ok", plan.intent === "sql" ? "text-to-SQL" : `outil typé ${plan.intent}`);

  return plan;
}

// 3. Execute + self-correct ----------------------------------------------------
type Problem = CorrectInput["problem"];

type Attempt = { rows: SqlRow[]; problem: null } | { rows: null; problem: Problem };

/** One guarded run of a plan: its rows, or the problem the corrector has to fix. */
async function attempt(db: DatabaseSync, schema: Record<string, string[]>, plan: QueryPlan, step: Step): Promise<Attempt> {
  // Generated SQL may only read the v_* views; typed tools also read small lookup tables.
  const guard = guardQuery(db, schema, plan.sql, { objects: plan.tool ? ALLOWED_OBJECTS : VIEWS });

  if (!guard.ok) {
    const message = guard.issues.join("\n");

    step.add(entry({ status: "error", title: `Tentative ${plan.attempt} : rejetée par le garde-fou`, detail: message }));

    return { rows: null, problem: { kind: "guard", message } };
  }

  step.add(
    entry({
      status: "ok",
      title: `Tentative ${plan.attempt} : garde-fou OK (lecture seule, 1 instruction, ${plan.tool ? "liste blanche" : "vues v_*"}, LIMIT forcé, prepare)`,
    }),
  );

  const started = performance.now();

  // Throws when the request was cancelled: no SQL for a visitor who left.
  llmSignal();

  try {
    const rows = plan.tool ? db.prepare(guard.sql).all(plan.params) : await executeGeneratedQuery(guard.sql, plan.params, { signal: llmSignal() });
    const ms = Math.round(performance.now() - started);

    if (rows.length) {
      step.add(entry({ status: "ok", title: `${rows.length} ligne(s) en ${ms} ms` }));

      return { rows, problem: null };
    }

    step.add(entry({ status: "warn", title: `Résultat vide (${ms} ms)` }));

    return { rows: null, problem: { kind: "empty", message: "résultat vide" } };
  } catch (err) {
    if (requestAborted()) throw err;
    const message = err instanceof Error ? err.message : String(err);

    step.add(entry({ status: "error", title: "Erreur SQLite", detail: message }));

    return { rows: null, problem: { kind: err instanceof SqlTimeoutError ? "timeout" : "error", message } };
  }
}

export async function execute(db: DatabaseSync, question: string, entities: Entities, first: QueryPlan, emit: Emit, notes: string[]) {
  const step = new Step("execute", "Exécution…", emit);
  const schema = readSchema(db);
  let plan = first;

  for (;;) {
    const { rows, problem } = await attempt(db, schema, plan, step);

    if (rows) {
      step.done(plan.attempt > 1 ? "fix" : "ok", `${rows.length} ligne(s)${plan.attempt > 1 ? `, après ${plan.attempt - 1} correction(s)` : ""}`);

      return { rows, plan, problem: null };
    }

    if (problem.kind === "timeout" || plan.attempt >= MAX_ATTEMPTS) {
      step.done("error", `Abandon après ${plan.attempt} tentatives`);

      return { rows: [], plan, problem };
    }

    const fix = await correctQuery({ db, question, entities, plan, problem });

    if (!fix) {
      step.add(entry({ status: "error", title: "Aucune correction possible", detail: problem.message }));
      step.done(problem.kind === "empty" ? "warn" : "error", problem.kind === "empty" ? "Aucune ligne" : "Échec");

      return { rows: [], plan, problem };
    }

    if (fix.result.note) notes.push(fix.result.note);
    plan = fix.result.plan;
    step.add(decisionEntry(fix, `Auto-correction : ${fix.reason}`, "fix", `${problem.message}\n→\n${plan.sql}`));
  }
}

// 4. Format -------------------------------------------------------------------

/** A generated-SQL cell as shown in the table: text, number or empty; anything else as text. */
const Cell = z.union([z.string(), z.number(), z.null()]).catch((ctx) => String(ctx.value));

/** Page-like columns of a generated result, used as Leaguepedia sources when present. */
const PageColumns = z
  .object({ event_page: z.string().optional().catch(undefined), tournament_page: z.string().optional().catch(undefined), player: z.string().optional().catch(undefined) })
  .transform((r) => [r.event_page, r.tournament_page, r.player]);

/** `facts`: the tool's own sentence, built from the aggregates of the question's scope. */
type SummaryInput = { question: string; facts: string };

const templateSummary: Decider<SummaryInput, string> = {
  level: "rules",
  name: "modèle de phrase",
  run: ({ facts }) => ({ result: facts, confidence: 0.7, level: "rules", reason: "synthèse à partir des agrégats" }),
};

const llmSummary: Decider<SummaryInput, string> = {
  level: "llm",
  name: "rédaction",
  // Only the facts go to the model: the raw rows carry no scope (a 10-1 row
  // is one Worlds edition, not "this season"), so the model could misread them.
  run: async ({ question, facts }) => {
    const llm = getLlm();

    if (!llm) return null;

    const { text } = await generateText({
      model: llm.model,
      instructions:
        "Reformule ces faits en une ou deux phrases de synthèse en français, qui répondent à la question. " +
        "Garde exactement leurs chiffres et leur périmètre (compétition, éditions, période) : " +
        "n'ajoute aucun chiffre, aucune période (saison, année en cours…) ni aucune interprétation absente des faits.",
      prompt: JSON.stringify({ question, faits: facts }),
      telemetry: { functionId: "write-summary" },
      maxOutputTokens: 300,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: llmSignal(LLM_CALL.timeoutMs),
    });

    const sentence = text.trim();

    if (!sentence) return null;
    const beyond = claimsBeyondFacts(sentence, facts, question);

    // Thrown so the trace shows why the template sentence was kept.
    if (beyond.length) throw new Error(`synthèse rejetée, absent des faits : ${beyond.join(", ")}`);

    return { result: sentence, confidence: 0.85, level: "llm", reason: llm.id };
  },
};

/** Icons of the champions a generated table names, read from the database (same Data Dragon version for all). */
function championIcons(db: DatabaseSync, columns: string[], raw: SqlRow[]): Record<string, string> {
  const column = columns.find((c) => CHAMPION_COLUMN.test(c));

  if (!column) return {};
  const names = [...new Set(raw.flatMap((r) => z.string().safeParse(r[column]).data ?? []))];

  if (!names.length) return {};

  const rows = selectAll(
    db,
    z.object({ name: z.string(), icon_url: z.string() }),
    `SELECT name, icon_url FROM champions WHERE icon_url IS NOT NULL AND name IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(names)],
  );

  return Object.fromEntries(rows.map((r) => [r.name, r.icon_url]));
}

function emptySummary(entities: Entities, route: Route, plan: QueryPlan | null): string {
  if (route.kind === "out_of_scope")
    return (
      `Question hors périmètre : ${route.reason.replace(/\.$/, "")}. La base couvre : ${SCOPE_LABEL}.`
    );

  if (!plan) {
    const why = `Aucun outil typé ne couvre cette question (${route.kind === "sql" ? route.reason : "routage"})`;
    const status = llmStatus();

    if (status === "ready") return `${why} et la requête générée n'a rien donné.`;

    return status === "exhausted"
      ? `${why}. Le text-to-SQL de secours est indisponible pour le moment (quota du modèle épuisé).`
      : `${why}. Le text-to-SQL de secours demande une clé OpenRouter, absente ici.`;
  }

  const who = [...entities.players.map((p) => p.player), ...entities.teams.map((t) => t.team), entities.champion?.champion]
    .filter(Boolean)
    .join(", ");

  return `Aucun résultat${who ? ` pour ${who}` : ""}${entities.league ? ` (${entities.leagueShort ?? entities.league})` : ""} dans la base.`;
}

const ROUTE_LABEL: Partial<Record<Route["kind"], AnswerMeta["route"]>> = { out_of_scope: "out_of_scope", sql: "sql" };

/** Says which data is missing and what the database does hold. States no figure. */
function missingSummary(missing: string[], route: Route): string {
  const head = `Donnée absente de la base : ${[...new Set(missing)].join(", ")}. `;

  if (route.kind === "missing" && route.coverage)
    return (
      head +
      "Les statistiques in-game (or, CS et XP aux minutes clés, first blood, solo kills, multi-kills, wards, plaques, premiers objectifs) " +
      "viennent des données Riot que Leaguepedia publie pour une partie des matchs, et il n'en publie aucune pour ce périmètre (aucune pour la LPL). " +
      "Les résultats, les drafts et les statistiques de fin de partie (kills, morts, assists, or, CS, dégâts, vision, objectifs) y restent disponibles : aucun chiffre in-game n'est donc donné."
    );

  return (
    head +
    "La base contient les résultats, les drafts, les statistiques de fin de partie (kills, morts, assists, or, CS, dégâts, vision, objets, rune principale, objectifs) " +
    "et, pour les parties dont Leaguepedia publie les données Riot, les statistiques in-game : aucun chiffre n'est donc donné."
  );
}

async function format(
  db: DatabaseSync,
  question: string,
  entities: Entities,
  route: Route,
  plan: QueryPlan | null,
  raw: SqlRow[],
  emit: Emit,
  notes: string[],
  missing: string[],
  problem: Problem | null,
): Promise<Answer> {
  const step = new Step("format", "Mise en forme…", emit);
  const amb = ambiguityNotes(question, entities);
  notes.unshift(...amb.notes);

  const input = plan ? (plan.tool?.call.input ?? null) : route.kind === "tool" ? route.call.input : null;

  const meta: AnswerMeta = {
    route: missing.length ? "missing_data" : (plan?.intent ?? ROUTE_LABEL[route.kind] ?? (route.kind === "tool" ? route.call.tool : "none")),
    sqlAvailable: getLlm() != null,
    input,
    players: entities.players.map((p) => p.player),
    teams: entities.teams.map((t) => t.team),
    champion: entities.champion?.champion ?? null,
    league: input?.league ?? entities.league,
    rowCount: raw.length,
    totals: {},
    ambiguities: amb.ambiguities,
    attempts: plan?.attempt ?? 0,
    unread: route.kind === "tool" || route.kind === "sql" ? (route.unread ?? []) : [],
  };

  if (missing.length) {
    step.add(entry({ status: "warn", title: "Réponse « donnée absente » mise en forme, sans chiffre" }));
    step.done("warn", "Donnée absente de la base");

    return {
      title: "Donnée absente de la base",
      summary: missingSummary(missing, route),
      rows: [],
      table: null,
      timeline: null,
      scoreboard: null,
      versus: null,
      teams: null,
      roster: null,
      champion: null,
      pool: null,
      series: null,
      icons: {},
      profiles: [],
      sources: [],
      followUps: [...amb.followUps, ...EXAMPLES].slice(0, 4),
      notes,
      meta,
    };
  }

  if (problem && problem.kind !== "empty") {
    const summary = problem.kind === "timeout"
      ? "La requête a dépassé le délai de calcul et a été arrêtée. Précise une compétition ou une période plus courte."
      : problem.kind === "guard" ? "La requête a été rejetée par le garde-fou. Aucun résultat ne peut être conclu."
      : "La requête a échoué pendant son exécution. Aucun résultat ne peut être conclu.";

    step.done("error", "Requête interrompue ou rejetée");

    return { title: "Échec de la requête", summary, rows: [], table: null, timeline: null, scoreboard: null, versus: null, teams: null, roster: null, champion: null, pool: null, series: null, icons: {}, profiles: [], sources: [], followUps: EXAMPLES, notes, meta };
  }

  if (!raw.length || !plan) {
    step.add(entry({ status: "warn", title: "Réponse vide mise en forme" }));
    step.done("warn", route.kind === "out_of_scope" ? "Hors périmètre" : "Pas de résultat");

    return {
      title: route.kind === "out_of_scope" ? "Hors périmètre" : "Pas de résultat",
      summary: emptySummary(entities, route, plan),
      rows: [],
      table: null,
      timeline: null,
      scoreboard: null,
      versus: null,
      teams: null,
      roster: null,
      champion: null,
      pool: null,
      series: null,
      icons: {},
      profiles: [],
      sources: [],
      followUps: [...amb.followUps, ...EXAMPLES].slice(0, 4),
      notes,
      meta,
    };
  }

  // Text-to-SQL result: generic table.
  if (!plan.tool) {
    const columns = Object.keys(raw[0]);
    step.add(entry({ status: "ok", title: `Tableau générique (${raw.length} lignes, ${columns.length} colonnes)` }));
    step.done("ok", `${raw.length} lignes`);
    const pages = [...new Set(raw.flatMap((r) => PageColumns.parse(r).flatMap((v) => v ?? [])))];

    return {
      title: question,
      summary: `${raw.length} ligne(s) renvoyée(s) par une requête générée, validée par le garde-fou.`,
      rows: [],
      table: { columns, rows: raw.map((r) => columns.map((c) => Cell.parse(r[c]))) },
      timeline: null,
      scoreboard: null,
      versus: null,
      teams: null,
      roster: null,
      champion: null,
      pool: null,
      series: null,
      // A column of champion names gets the champion layout, with their icons.
      icons: championIcons(db, columns, raw),
      // Several named players: the comparison layouts show their team and role next to the generated table.
      profiles: entities.players.length > 1 ? playerProfiles(db, entities.players.map((p) => p.player), entities) : [],
      sources: pages.length
        ? pages.slice(0, 15).map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) }))
        : [{ label: "Leaguepedia", url: wikiUrl("League of Legends Esports Wiki") }],
      followUps: [...amb.followUps, ...EXAMPLES].slice(0, 4),
      notes,
      meta,
    };
  }

  const out = await plan.tool.format(db, raw);
  meta.totals = out.totals;

  for (const t of out.trace ?? []) step.add(entry(t));
  notes.push(...(out.notes ?? []));
  const summary = (await decide({ question, facts: out.facts }, [templateSummary, llmSummary], { threshold: 0.8 }))!;
  step.add(decisionEntry(summary, `Synthèse (${summary.level === "llm" ? "LLM" : "modèle de phrase"})`));
  const followUps = [...new Set([...amb.followUps, ...out.followUps])].slice(0, 4);

  const shown = out.timeline
    ? `Timeline : ${out.timeline.gold.length} points d'or, ${out.timeline.events.length} événements`
    : `Tableau de ${out.rows?.length ?? out.table?.rows.length ?? 0} lignes`;

  step.add(entry({ status: "ok", title: `${shown}, ${out.sources.length} sources, ${followUps.length} suites` }));

  step.done(
    "ok",
    `${out.timeline ? `${out.timeline.events.length} événements` : `${out.rows?.length ?? out.table?.rows.length ?? 0} lignes`} · ${out.sources.length} sources`,
  );

  const call = plan.tool.call;
  // The scope the comparison ran on: a relaxation may have widened the one asked.
  const profiles = call.tool === "player_comparison" ? playerProfiles(db, [call.input.playerA, call.input.playerB], call.input) : [];

  return {
    title: out.title,
    summary: summary.result,
    rows: out.rows ?? [],
    table: out.table ?? null,
    timeline: out.timeline ?? null,
    scoreboard: out.scoreboard ?? null,
    versus: out.versus ?? null,
    teams: out.teams ?? null,
    roster: out.roster ?? null,
    champion: out.champion ?? null,
    pool: out.pool ?? null,
    series: out.series ?? null,
    icons: out.icons ?? {},
    profiles,
    sources: out.sources,
    followUps,
    notes,
    meta,
  };
}

/**
 * Runs the four steps, emitting each step's progress and the final answer.
 * Each step is one observation of the question's trace.
 * `now` dates the relative seasons of the question ("l'an dernier"); the eval passes a fixed date.
 */
export function runAgent(question: string, emit: Emit, now: Date = new Date(), signal?: AbortSignal): Promise<Answer> {
  return withLlmSignal(signal, () => run(question, emit, now));
}

async function run(question: string, emit: Emit, now: Date): Promise<Answer> {
  const db = openDb();
  const notes: string[] = [];
  // The last state of each step, as streamed: what its observation reports.
  const steps = new Map<StepName, StepPart>();

  const traced: Emit = (event) => {
    if (event.type === "step") steps.set(event.part.step, event.part);
    emit(event);
  };

  try {
    const entities = await traceStep(
      "understand",
      { question },
      () => understand(db, question, traced, now),
      (e) => understandReport(question, e, steps.get("understand")),
    );

    const periodError = periodProblem(entities.yearFrom, entities.yearTo, now);
    const route: Route = periodError ? { kind: "out_of_scope", reason: periodError } : routeQuestion(question, entities, readSchema(db), coverageLookup(db));
    const members = entities.league ? leagueMembers(entities.league, entities.yearFrom, entities.yearTo) : [];

    if (members.length > 1) notes.push(`La période couvre plusieurs noms de ligue : ${members.join(", ")}.`);
    const missing: string[] = [];

    const first = await traceStep(
      "build",
      { question },
      () => build(db, question, entities, route, traced, notes, missing),
      (plan) => buildReport(route, plan, steps.get("build")),
    );

    const { rows, plan, problem } = await traceStep(
      "execute",
      { sql: first?.sql ?? null, params: first?.params ?? {} },
      async () => {
        if (first) return execute(db, question, entities, first, traced, notes);
        new Step("execute", "Exécution…", traced).done("warn", "Rien à exécuter");

        return { rows: [], plan: null, problem: null };
      },
      (result) => executeReport(result.plan, result.rows.length, steps.get("execute")),
    );

    const answer = await traceStep(
      "format",
      { route: plan?.intent ?? route.kind, rowCount: rows.length },
      () => format(db, question, entities, route, plan, rows, traced, notes, missing, problem),
      (a) => formatReport(a, steps.get("format")),
    );

    if (llmStatus() === "exhausted") answer.notes.push(QUOTA_NOTE);
    recordOutcome(answer, entities, steps);
    emit({ type: "answer", answer });

    return answer;
  } catch (error) {
    for (const part of steps.values()) {
      if (part.state === "running") traced({ type: "step", part: { ...part, state: "done", status: "error", title: "Étape interrompue" } });
    }

    throw error;
  }
}
