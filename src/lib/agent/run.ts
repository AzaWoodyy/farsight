import { executeGeneratedQuery, SqlTimeoutError } from "../db/generated-query";
import { periodProblem } from "../domain/years";
import { leagueMembers, SCOPE_LABEL } from "../domain/leagues";
import { claimsBeyondFacts } from "./summary";
import { type EmptyExplanation, explainEmpty, unrecognizedNote } from "./empty";
import { CHAMPION_COLUMN } from "../champions";
import type { DatabaseSync } from "node:sqlite";
import { generateText } from "ai";
import { z } from "zod";
import { openDb, readSchema, selectAll, type SqlRow } from "../db";
import { wikiUrl } from "../sources/leaguepedia";
import { type DecideOutcome, type Decider, decide, describeAttempts } from "./decide";
import { ALLOWED_OBJECTS, guardQuery, VIEWS } from "./guard";
import { getLlm, LLM_CALL, llmStatus, llmSignal, requestAborted, withLlmSignal } from "./llm";
import { msg, withLocale } from "./messages";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { buildQuery, type CorrectInput, correctQuery, coverageLookup, type Route, routeQuestion } from "./query";
import { buildReport, executeReport, formatReport, recordOutcome, traceStep, understandReport } from "./trace";
import type { Answer, AnswerMeta, Entities, QueryPlan, StepName, StepPart, TraceEntry, TraceStatus } from "./types";
import { playerProfiles, type ToolCall } from "./tools";
import { teamBadges, teamNames } from "./team-badges";
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
    detail: [extra, d.reason, msg().run.cascade(describeAttempts(d.attempts))].filter(Boolean).join("\n"),
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

/** Notes and follow-ups for aliases shared by several players: never a silent pick. */
function ambiguityNotes(question: string, entities: Entities) {
  const notes: string[] = [];
  const followUps: string[] = [];
  const ambiguities: AnswerMeta["ambiguities"] = [];

  for (const p of entities.players) {
    if (!p.ambiguity) continue;
    const others = p.ambiguity.candidates.slice(1);
    const shown = p.ambiguity.candidates.slice(0, 4).map((c) => msg().run.candidate(c.player, c.games));
    const list = shown.join(", ") + (p.ambiguity.candidates.length > 4 ? msg().run.otherCandidates(p.ambiguity.candidates.length - 4) : "");
    notes.push(
      msg().run.ambiguity(p.mention, list, p.player, p.ambiguity.reason) + (p.ambiguity.uncertain ? msg().run.uncertainChoice : ""),
    );

    for (const o of others.slice(0, 2)) followUps.push(question.replace(p.mention, o.player));
    ambiguities.push({ mention: p.mention, chosen: p.player, alternatives: others.map((o) => o.player), uncertain: p.ambiguity.uncertain });
  }

  return { notes, followUps, ambiguities };
}

// 1. Understand ---------------------------------------------------------------
async function understand(db: DatabaseSync, question: string, emit: Emit, now: Date) {
  const m = msg().run;
  const step = new Step("understand", m.analysing, emit);
  const decision = (await understandQuestion(db, question, now))!;
  const entities = decision.result;

  const lines = [
    ...entities.players.map((p) => {
      const ids = [p.realName, p.nativeName].filter(Boolean).join(" · ");
      const via = p.mention === p.player ? "" : m.viaAlias(p.matchedAlias);

      const others = p.otherCandidates.length
        ? m.homonyms(p.otherCandidates.slice(0, 5).join(", "), p.otherCandidates.length > 5, p.ambiguity!.reason, p.ambiguity!.uncertain)
        : "";

      return m.playerLine(p.mention, p.player, ids, `${via}${others}`);
    }),
    ...entities.teams.map(
      (t) => m.teamLine(t.mention, t.team, t.members.length > 1 || t.members[0] !== t.team ? t.members.join(", ") : null),
    ),
    ...(entities.champion ? [m.championLine(entities.champion.mention, entities.champion.champion)] : []),
    ...(entities.opponentChampion ? [m.opponentLine(entities.opponentChampion.mention, entities.opponentChampion.champion)] : []),
    ...entities.unresolved.map((mention) => m.unknownPlayer(mention)),
    m.leagueLine(entities.league, entities.leagueMention),
    m.periodLine(entities.yearFrom, entities.yearTo, entities.split),
    ...(entities.outOfScope ? [m.outOfScopeLine(entities.outOfScope)] : []),
  ];

  const names = [
    ...entities.players.map((p) => p.player),
    ...entities.teams.map((t) => t.team),
    ...(entities.champion ? [entities.champion.champion] : []),
    ...(entities.opponentChampion ? [entities.opponentChampion.champion] : []),
  ];

  const ambiguous = entities.players.some((p) => p.ambiguity);
  const status: TraceStatus = entities.outOfScope ? "warn" : names.length || entities.league ? (ambiguous ? "warn" : "ok") : "warn";
  step.add(decisionEntry(decision, names.length ? m.recognized : m.noEntity, status, lines.join("\n")));
  step.done(
    status,
    entities.outOfScope
      ? m.outOfScopeNamed(entities.outOfScope)
      : names.length || entities.league
        ? [names.join(", "), entities.leagueShort].filter(Boolean).join(" · ") + (ambiguous ? m.ambiguousAlias : "")
        : m.noEntity,
  );

  return entities;
}

// 2. Build (typed tool or text-to-SQL) + guard ---------------------------------
/** `missing` collects the data the database does not hold (rules or text-to-SQL); the answer then gives no figure. */
async function build(db: DatabaseSync, question: string, entities: Entities, route: Route, emit: Emit, notes: string[], missing: string[]) {
  const step = new Step("build", msg().run.building, emit);
  const m = msg().run;

  if (route.kind === "out_of_scope") {
    step.add(entry({ status: "warn", title: m.outOfScopeQuestion, detail: route.reason }));
    step.done("warn", m.outOfScope);

    return null;
  }

  if (route.kind === "missing") {
    missing.push(...route.concepts);
    step.add(entry({ status: "warn", title: m.missingData, detail: m.noQuery(route.reason) }));
    step.done("warn", m.missingData);

    return null;
  }

  const decision = await buildQuery({ db, question, entities, route });

  if (!decision) {
    const status = llmStatus();
    step.add(
      entry({
        status: "warn",
        title: m.noTool,
        detail: [route.reason, m.sqlFallbackDetail[status]].join("\n"),
      }),
    );
    step.done("warn", m.sqlFallbackTitle[status]);

    return null;
  }

  notes.push(...decision.result.notes);

  if (decision.result.plan === null) {
    missing.push(...decision.result.missing);
    step.add(decisionEntry(decision, m.missingData, "warn", decision.result.missing.join("\n")));
    step.done("warn", m.missingData);

    return null;
  }

  const { plan } = decision.result;
  const label = plan.tool ? m.typedTool(plan.tool.label) : m.generatedQuery;
  step.add(
    decisionEntry(
      decision,
      label,
      "ok",
      `${plan.tool ? `${plan.intent}(${JSON.stringify(plan.tool.call.input)})\n\n` : ""}${plan.sql}\n\n${m.parameters(JSON.stringify(plan.params))}`,
    ),
  );
  step.done("ok", plan.intent === "sql" ? "text-to-SQL" : m.toolDone(plan.intent));

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

    step.add(entry({ status: "error", title: msg().run.guardRejected(plan.attempt), detail: message }));

    return { rows: null, problem: { kind: "guard", message } };
  }

  step.add(
    entry({
      status: "ok",
      title: msg().run.guardOk(plan.attempt, plan.tool != null),
    }),
  );

  const started = performance.now();

  // Throws when the request was cancelled: no SQL for a visitor who left.
  llmSignal();

  try {
    const rows = plan.tool ? db.prepare(guard.sql).all(plan.params) : await executeGeneratedQuery(guard.sql, plan.params, { signal: llmSignal() });
    const ms = Math.round(performance.now() - started);

    if (rows.length) {
      step.add(entry({ status: "ok", title: msg().run.rowsIn(rows.length, ms) }));

      return { rows, problem: null };
    }

    step.add(entry({ status: "warn", title: msg().run.emptyIn(ms) }));

    return { rows: null, problem: { kind: "empty", message: msg().run.emptyResult } };
  } catch (err) {
    if (requestAborted()) throw err;
    const message = err instanceof Error ? err.message : String(err);

    step.add(entry({ status: "error", title: msg().run.sqliteError, detail: message }));

    return { rows: null, problem: { kind: err instanceof SqlTimeoutError ? "timeout" : "error", message } };
  }
}

type Executed = { rows: SqlRow[]; plan: QueryPlan; problem: Problem | null; empty: EmptyExplanation | null };

export async function execute(db: DatabaseSync, question: string, entities: Entities, first: QueryPlan, emit: Emit, notes: string[]): Promise<Executed> {
  const m = msg().run;
  const step = new Step("execute", m.executing, emit);
  const schema = readSchema(db);
  let plan = first;

  for (;;) {
    const { rows, problem } = await attempt(db, schema, plan, step);

    if (rows) {
      step.done(plan.attempt > 1 ? "fix" : "ok", m.rowsDone(rows.length, plan.attempt - 1));

      return { rows, plan, problem: null, empty: null };
    }

    // An empty generated query whose scope explains it: another query would come back empty too.
    const empty = problem.kind === "empty" && !plan.tool ? explainEmpty(db, entities, plan.sql) : null;

    if (empty?.conclusive) {
      step.add(entry({ status: "warn", title: m.emptyExplained, detail: empty.summary }));
      step.done("warn", empty.title);

      return { rows: [], plan, problem, empty };
    }

    if (problem.kind === "timeout" || plan.attempt >= MAX_ATTEMPTS) {
      // An empty result is no failure of the query: the answer then says what the scope holds.
      step.done(problem.kind === "empty" ? "warn" : "error", problem.kind === "empty" ? m.noRowsAfter(plan.attempt) : m.givenUpAfter(plan.attempt));

      return { rows: [], plan, problem, empty: null };
    }

    const fix = await correctQuery({ db, question, entities, plan, problem });

    if (!fix) {
      step.add(entry({ status: "error", title: m.noFix, detail: problem.message }));
      step.done(problem.kind === "empty" ? "warn" : "error", problem.kind === "empty" ? m.noRows : m.failed);

      return { rows: [], plan, problem, empty: null };
    }

    if (fix.result.note) notes.push(fix.result.note);
    plan = fix.result.plan;
    step.add(decisionEntry(fix, m.selfCorrection(fix.reason ?? ""), "fix", `${problem.message}\n→\n${plan.sql}`));
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
  run: ({ facts }) => ({ result: facts, confidence: 0.7, level: "rules", reason: msg().run.summaryFromAggregates }),
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
      instructions: msg().run.summaryPrompt,
      prompt: JSON.stringify({ question, [msg().run.factsKey]: facts }),
      telemetry: { functionId: "write-summary" },
      maxOutputTokens: 300,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: llmSignal(LLM_CALL.timeoutMs),
    });

    const sentence = text.trim();

    if (!sentence) return null;
    const beyond = claimsBeyondFacts(sentence, facts, question);

    // Thrown so the trace shows why the template sentence was kept.
    if (beyond.length) throw new Error(msg().run.summaryRejected(beyond.join(", ")));

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
  const m = msg().run;

  if (route.kind === "out_of_scope")
    return m.outOfScopeSummary(route.reason.replace(/\.$/, ""), SCOPE_LABEL);

  // In the visitor's words: which part of the agent gave up (no typed tool, no model for the generated query)
  // is in the trace, for who opens it.
  if (!plan) return llmStatus() === "ready" ? m.searchGaveNothing : m.cannotAnswerYet;

  const who = [...entities.players.map((p) => p.player), ...entities.teams.map((t) => t.team), entities.champion?.champion]
    .filter(Boolean)
    .join(", ");

  return m.noResultFor(who, entities.league ? (entities.leagueShort ?? entities.league) : null);
}

const ROUTE_LABEL: Partial<Record<Route["kind"], AnswerMeta["route"]>> = { out_of_scope: "out_of_scope", sql: "sql" };

/** Says which data is missing and what the database does hold. States no figure. */
function missingSummary(missing: string[], route: Route): string {
  const m = msg().run;
  const head = m.missingHead([...new Set(missing)].join(", "));

  return head + (route.kind === "missing" && route.coverage ? m.missingForScope : m.missingInGeneral);
}

/** Every view empty: what an answer holds before a tool or a table fills it. */
/**
 * The players an answer is about, profiled on the scope it ran on (a relaxation may have widened the one asked):
 * both sides of a comparison, the one player of a player's statistics. Their photo heads the answer.
 */
export function answerProfiles(db: DatabaseSync, call: ToolCall) {
  switch (call.tool) {
    case "player_comparison":
      return playerProfiles(db, [call.input.playerA, call.input.playerB], call.input);
    case "player_event_history":
    case "player_ingame_stats":
    case "player_recent_games":
      return playerProfiles(db, [call.input.player], call.input);
    case "champion_pool":
      return call.input.subject === "player" ? playerProfiles(db, [call.input.name], call.input) : [];
    default:
      return [];
  }
}

const EMPTY_VIEWS = {
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
  iconTones: {},
  teamLeagues: {},
  profiles: [],
  sources: [],
} satisfies Partial<Answer>;

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
  explained: EmptyExplanation | null,
): Promise<Answer> {
  const m = msg().run;
  const step = new Step("format", m.formatting, emit);
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
    empty: null,
  };

  if (missing.length) {
    step.add(entry({ status: "warn", title: m.missingFormatted }));
    step.done("warn", m.missingData);

    return {
      ...EMPTY_VIEWS,
      title: m.missingData,
      summary: missingSummary(missing, route),
      followUps: [...amb.followUps, ...m.examples].slice(0, 4),
      notes,
      meta,
    };
  }

  if (problem && problem.kind !== "empty") {
    const summary = problem.kind === "timeout"
      ? m.timedOut
      : problem.kind === "guard" ? m.guardRefused
      : m.queryFailed;

    step.done("error", m.interruptedOrRejected);

    return { ...EMPTY_VIEWS, title: m.failureTitle, summary, followUps: m.examples, notes, meta };
  }

  if (!raw.length || !plan) {
    // What the scope holds says why nothing came back; a typed tool is explained once its relaxations are spent.
    const why = explained ?? (plan ? explainEmpty(db, entities, plan.sql) : null);
    const unrecognized = route.kind === "out_of_scope" ? null : unrecognizedNote(entities, meta.unread);
    const summary = [why?.summary ?? emptySummary(entities, route, plan), unrecognized].filter(Boolean).join(" ");
    const title = route.kind === "out_of_scope" ? m.outOfScope : why && why.reason !== "unexplained" ? why.title : unrecognized ? m.unrecognizedQuestion : m.noResult;
    meta.empty = why?.reason ?? null;

    step.add(entry({ status: "warn", title: why ? m.emptyExplainedBy(why.reason) : m.emptyFormatted, detail: summary }));
    step.done("warn", title);

    return {
      ...EMPTY_VIEWS,
      title,
      summary,
      table: why?.table ?? null,
      icons: why?.table ? championIcons(db, why.table.columns, why.table.rows.map((r) => Object.fromEntries(why.table!.columns.map((c, i) => [c, r[i]])))) : {},
      iconTones: {},
      sources: why?.sources.length
        ? why.sources.slice(0, 15).map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) }))
        : [],
      followUps: [...amb.followUps, ...m.examples].slice(0, 4),
      notes,
      meta,
    };
  }

  // Text-to-SQL result: generic table.
  if (!plan.tool) {
    const columns = Object.keys(raw[0]);
    const table = { columns, rows: raw.map((r) => columns.map((c) => Cell.parse(r[c]))) };
    const badges = teamBadges(db, teamNames({ table }, meta.teams), entities);
    step.add(entry({ status: "ok", title: m.genericTable(raw.length, columns.length) }));
    step.done("ok", m.rowCount(raw.length));
    const pages = [...new Set(raw.flatMap((r) => PageColumns.parse(r).flatMap((v) => v ?? [])))];

    return {
      ...EMPTY_VIEWS,
      title: question,
      summary: m.generatedSummary(raw.length),
      table,
      // A column of champion names gets the champion layout, with their icons.
      icons: { ...badges.icons, ...championIcons(db, columns, raw) },
      iconTones: badges.tones,
      teamLeagues: badges.leagues,
      // The named players: the comparison layouts show their team and role next to the generated table, and one
      // player alone heads the answer with their photo.
      profiles: entities.players.length ? playerProfiles(db, entities.players.map((p) => p.player), entities) : [],
      sources: pages.length
        ? pages.slice(0, 15).map((p) => ({ label: `Leaguepedia — ${p}`, url: wikiUrl(p) }))
        : [{ label: "Leaguepedia", url: wikiUrl("League of Legends Esports Wiki") }],
      followUps: [...amb.followUps, ...m.examples].slice(0, 4),
      notes,
      meta,
    };
  }

  const formatStarted = performance.now();
  const out = await plan.tool.format(db, raw);
  const formatMs = Math.round(performance.now() - formatStarted);
  meta.totals = out.totals;

  for (const t of out.trace ?? []) step.add(entry(t));
  notes.push(...(out.notes ?? []));
  const summary = (await decide({ question, facts: out.facts }, [templateSummary, llmSummary], { threshold: 0.8 }))!;
  step.add(decisionEntry(summary, m.summaryBy(summary.level === "llm")));
  const followUps = [...new Set([...amb.followUps, ...out.followUps])].slice(0, 4);

  const shown = out.timeline
    ? m.timelineShown(out.timeline.gold.length, out.timeline.events.length)
    : m.tableShown(out.rows?.length ?? out.table?.rows.length ?? 0);

  step.add(entry({ status: "ok", title: m.formatted(shown, out.sources.length, followUps.length, formatMs) }));

  step.done(
    "ok",
    m.formatDone(out.timeline ? m.eventCount(out.timeline.events.length) : m.rowCount(out.rows?.length ?? out.table?.rows.length ?? 0), out.sources.length),
  );

  const call = plan.tool.call;
  const profiles = answerProfiles(db, call);
  // The period the answer covers: the one the tool chose, else the one it ran on (a relaxation may have widened
  // the one asked), else the question's.
  const period = out.period ?? PeriodInput.safeParse(input).data ?? entities;
  const badges = teamBadges(db, teamNames(out, meta.teams), period, out.roster ? { [out.roster.team]: out.roster.names } : {});

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
    icons: { ...badges.icons, ...out.icons },
    iconTones: badges.tones,
    teamLeagues: badges.leagues,
    profiles,
    sources: out.sources,
    followUps,
    notes,
    meta,
  };
}

/** The period of a tool input that has one. */
const PeriodInput = z.object({ yearFrom: z.number().nullable(), yearTo: z.number().nullable() });

/**
 * Runs the four steps, emitting each step's progress and the final answer.
 * Each step is one observation of the question's trace.
 * `now` dates the relative seasons of the question ("l'an dernier"); the eval passes a fixed date.
 * `locale` is the language the answer is written in: the one of the page that asks.
 */
export function runAgent(question: string, emit: Emit, now: Date = new Date(), signal?: AbortSignal, locale: Locale = DEFAULT_LOCALE): Promise<Answer> {
  return withLocale(locale, () => withLlmSignal(signal, () => run(question, emit, now)));
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

    if (members.length > 1) notes.push(msg().run.leagueNames(members.join(", ")));
    const missing: string[] = [];

    const first = await traceStep(
      "build",
      { question },
      () => build(db, question, entities, route, traced, notes, missing),
      (plan) => buildReport(route, plan, steps.get("build")),
    );

    const { rows, plan, problem, empty } = await traceStep(
      "execute",
      { sql: first?.sql ?? null, params: first?.params ?? {} },
      async () => {
        if (first) return execute(db, question, entities, first, traced, notes);
        new Step("execute", msg().run.executing, traced).done("warn", msg().run.nothingToRun);

        return { rows: [], plan: null, problem: null, empty: null };
      },
      (result) => executeReport(result.plan, result.rows.length, steps.get("execute")),
    );

    const answer = await traceStep(
      "format",
      { route: plan?.intent ?? route.kind, rowCount: rows.length },
      () => format(db, question, entities, route, plan, rows, traced, notes, missing, problem, empty),
      (a) => formatReport(a, steps.get("format")),
    );

    if (llmStatus() === "exhausted") answer.notes.push(msg().llm.quotaNote);
    recordOutcome(answer, entities, steps);
    emit({ type: "answer", answer });

    return answer;
  } catch (error) {
    for (const part of steps.values()) {
      if (part.state === "running") traced({ type: "step", part: { ...part, state: "done", status: "error", title: msg().run.stepInterrupted } });
    }

    throw error;
  }
}
