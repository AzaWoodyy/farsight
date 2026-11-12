import type { DatabaseSync } from "node:sqlite";
import { generateText } from "ai";
import { openDb, readSchema } from "../db";
import { wikiUrl } from "../sources/leaguepedia";
import { type DecideOutcome, type Decider, decide, describeAttempts } from "./decide";
import { ALLOWED_OBJECTS, guardQuery, VIEWS } from "./guard";
import { getLlm, LLM_CALL } from "./llm";
import { buildQuery, correctQuery, type Route, routeQuestion } from "./query";
import { TOOLS } from "./tools";
import type { Answer, AnswerMeta, Entities, QueryPlan, StepName, StepPart, TraceEntry, TraceStatus } from "./types";
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
async function understand(db: DatabaseSync, question: string, emit: Emit) {
  const step = new Step("understand", "Analyse de la question…", emit);
  const decision = (await understandQuestion(db, question))!;
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
async function build(db: DatabaseSync, question: string, entities: Entities, route: Route, emit: Emit, notes: string[]) {
  const step = new Step("build", "Construction de la requête…", emit);
  if (route.kind === "out_of_scope") {
    step.add(entry({ status: "warn", title: "Question hors périmètre", detail: route.reason }));
    step.done("warn", "Hors périmètre");
    return null;
  }
  const decision = await buildQuery({ db, question, entities, route });
  if (!decision) {
    step.add(
      entry({
        status: "warn",
        title: "Aucun outil typé ne couvre la question",
        detail: [
          route.reason,
          getLlm()
            ? "Le text-to-SQL n'a rien produit."
            : "Mode déterministe (pas de OPENROUTER_API_KEY) : le text-to-SQL de secours est désactivé.",
        ].join("\n"),
      }),
    );
    step.done("warn", getLlm() ? "Pas de requête" : "text-to-SQL requis (désactivé sans clé)");
    return null;
  }
  const { plan } = decision.result;
  notes.push(...decision.result.notes);
  const label = plan.intent === "sql" ? "Requête générée (text-to-SQL)" : `Outil typé : ${TOOLS[plan.intent].label}`;
  step.add(
    decisionEntry(
      decision,
      label,
      "ok",
      `${plan.intent === "sql" ? "" : `${plan.intent}(${JSON.stringify(plan.input)})\n\n`}${plan.sql}\n\nparamètres : ${JSON.stringify(plan.params)}`,
    ),
  );
  step.done("ok", plan.intent === "sql" ? "text-to-SQL" : `outil typé ${plan.intent}`);
  return plan;
}

// 3. Execute + self-correct ----------------------------------------------------
async function execute(db: DatabaseSync, question: string, entities: Entities, first: QueryPlan, emit: Emit, notes: string[]) {
  const step = new Step("execute", "Exécution…", emit);
  const schema = readSchema(db);
  let plan = first;

  for (;;) {
    // Generated SQL may only read the v_* views; typed tools also read small lookup tables.
    const guard = guardQuery(db, schema, plan.sql, { objects: plan.intent === "sql" ? VIEWS : ALLOWED_OBJECTS });
    let problem: { kind: "guard" | "error" | "empty"; message: string };
    if (!guard.ok) {
      problem = { kind: "guard", message: guard.issues.join("\n") };
      step.add(entry({ status: "error", title: `Tentative ${plan.attempt} : rejetée par le garde-fou`, detail: problem.message }));
    } else {
      step.add(
        entry({
          status: "ok",
          title: `Tentative ${plan.attempt} : garde-fou OK (lecture seule, 1 instruction, ${plan.intent === "sql" ? "vues v_*" : "liste blanche"}, LIMIT forcé, prepare)`,
        }),
      );
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

function emptySummary(entities: Entities, route: Route, plan: QueryPlan | null): string {
  if (route.kind === "out_of_scope")
    return (
      `Question hors périmètre : ${route.reason}. La base couvre les Worlds, le MSI, les ligues coréennes (LCK, OGN, LCK CL, CK, LCK AS), ` +
      "la LPL, l'Europe (EU LCS, LEC, EU Masters, EMEA Masters), l'Amérique du Nord (NA LCS, LCS, LTA), la LFL, la LFL D2 et la SuperLiga 2nd Division."
    );
  if (!plan)
    return getLlm()
      ? `Aucun outil typé ne couvre cette question (${route.kind === "sql" ? route.reason : "routage"}) et la requête générée n'a rien donné.`
      : `Aucun outil typé ne couvre cette question (${route.kind === "sql" ? route.reason : "routage"}). ` +
          "Le text-to-SQL de secours demande une clé OpenRouter, absente ici.";
  const who = [...entities.players.map((p) => p.player), ...entities.teams.map((t) => t.team), entities.champion?.champion]
    .filter(Boolean)
    .join(", ");
  return `Aucun résultat${who ? ` pour ${who}` : ""}${entities.league ? ` (${entities.leagueShort ?? entities.league})` : ""} dans la base.`;
}

async function format(
  db: DatabaseSync,
  question: string,
  entities: Entities,
  route: Route,
  plan: QueryPlan | null,
  raw: Record<string, unknown>[],
  emit: Emit,
  notes: string[],
): Promise<Answer> {
  const step = new Step("format", "Mise en forme…", emit);
  const amb = ambiguityNotes(question, entities);
  notes.unshift(...amb.notes);
  const meta: AnswerMeta = {
    route: route.kind === "out_of_scope" ? "out_of_scope" : (plan?.intent ?? (route.kind === "sql" ? "sql" : route.tool)),
    sqlAvailable: getLlm() != null,
    input: plan?.input ?? (route.kind === "tool" ? route.input : {}),
    players: entities.players.map((p) => p.player),
    teams: entities.teams.map((t) => t.team),
    champion: entities.champion?.champion ?? null,
    league: ((plan?.input ?? (route.kind === "tool" ? route.input : {})).league as string | null | undefined) ?? entities.league,
    rowCount: raw.length,
    totals: {},
    ambiguities: amb.ambiguities,
    attempts: plan?.attempt ?? 0,
  };

  if (!raw.length || !plan) {
    step.add(entry({ status: "warn", title: "Réponse vide mise en forme" }));
    step.done("warn", route.kind === "out_of_scope" ? "Hors périmètre" : "Pas de résultat");
    return {
      title: route.kind === "out_of_scope" ? "Hors périmètre" : "Pas de résultat",
      summary: emptySummary(entities, route, plan),
      rows: [],
      table: null,
      sources: [],
      followUps: [...amb.followUps, ...EXAMPLES].slice(0, 4),
      notes,
      meta,
    };
  }

  // Text-to-SQL result: generic table.
  if (plan.intent === "sql") {
    const columns = Object.keys(raw[0]);
    step.add(entry({ status: "ok", title: `Tableau générique (${raw.length} lignes, ${columns.length} colonnes)` }));
    step.done("ok", `${raw.length} lignes`);
    const pages = [...new Set(raw.flatMap((r) => [r.event_page, r.tournament_page, r.player].filter((v) => typeof v === "string") as string[]))];
    return {
      title: question,
      summary: `${raw.length} ligne(s) renvoyée(s) par une requête générée, validée par le garde-fou.`,
      rows: [],
      table: { columns, rows: raw.map((r) => columns.map((c) => r[c])) },
      sources: pages.length
        ? pages.slice(0, 15).map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) }))
        : [{ label: "Leaguepedia", url: wikiUrl("League of Legends Esports Wiki") }],
      followUps: [...amb.followUps, ...EXAMPLES].slice(0, 4),
      notes,
      meta,
    };
  }

  const out = TOOLS[plan.intent].format(db, plan.input, raw);
  meta.totals = out.totals;
  const summary = (await decide({ question, facts: out.facts, rows: out.rows ?? out.table }, [templateSummary, llmSummary], { threshold: 0.8 }))!;
  step.add(decisionEntry(summary, `Synthèse (${summary.level === "llm" ? "LLM" : "modèle de phrase"})`));
  const followUps = [...new Set([...amb.followUps, ...out.followUps])].slice(0, 4);
  step.add(
    entry({
      status: "ok",
      title: `Tableau de ${out.rows?.length ?? out.table?.rows.length ?? 0} lignes, ${out.sources.length} sources, ${followUps.length} suites`,
    }),
  );
  step.done("ok", `${out.rows?.length ?? out.table?.rows.length ?? 0} lignes · ${out.sources.length} sources`);
  return {
    title: out.title,
    summary: summary.result,
    rows: out.rows ?? [],
    table: out.table ?? null,
    sources: out.sources,
    followUps,
    notes,
    meta,
  };
}

/** Runs the four steps, emitting each step's progress and the final answer. */
export async function runAgent(question: string, emit: Emit): Promise<Answer> {
  const db = openDb();
  const notes: string[] = [];
  const entities = await understand(db, question, emit);
  const route = routeQuestion(question, entities);
  let rows: Record<string, unknown>[] = [];
  let plan: QueryPlan | null = null;

  const first = await build(db, question, entities, route, emit, notes);
  if (first) {
    const result = await execute(db, question, entities, first, emit, notes);
    rows = result.rows;
    plan = result.plan;
  } else {
    const step = new Step("execute", "Exécution…", emit);
    step.done("warn", "Rien à exécuter");
  }
  const answer = await format(db, question, entities, route, plan, rows, emit, notes);
  emit({ type: "answer", answer });
  return answer;
}
