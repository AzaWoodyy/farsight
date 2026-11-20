/**
 * Replays the reference questions (eval/questions.json) through the agent and
 * scores each one against its expectations.
 *
 *   bun run eval                   uses OPENROUTER_API_KEY if it is set, else deterministic
 *   bun run eval --deterministic   ignores the key (rules level only)
 *   bun run eval --only=worlds-chovy,alias-hangul   exit 1 on an unknown id
 *   bun run eval --strict          exit 1 unless every check passes, or when no case could be judged
 *   bun run eval --verbose         print every check, not only the failing ones
 *   bun run eval --llm-only        only the cases marked `llm` (the ones the rules hand to the LLM)
 *
 * A case marked `llm` cannot pass on the rules alone: without a key only what
 * the rules decide is scored (entities, unread words) and the case is listed
 * as needing the LLM instead of being counted as passed.
 *
 * A selection that keeps no case (`--only`, `--exclude-tags`, `--llm-only`)
 * always exits 1: a gate that runs nothing must not pass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");

if (flag("deterministic")) delete process.env.OPENROUTER_API_KEY;

// Imported after the flag so the LLM client never sees an ignored key.
const { runAgent } = await import("../src/lib/agent/run");
const { getLlm } = await import("../src/lib/agent/llm");
const { TOOLS } = await import("../src/lib/agent/tools");
const { STEPS } = await import("../src/lib/agent/types");

type Answer = import("../src/lib/agent/types").Answer;

type StepPart = import("../src/lib/agent/types").StepPart;

/** A scalar of a tool input or a total, as written in questions.json. */
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

type Scalar = z.infer<typeof Scalar>;

const Expect = z.strictObject({
  route: z.enum([...Object.keys(TOOLS), "sql", "out_of_scope", "missing_data", "none"]),
  players: z.array(z.string()).optional(),
  teams: z.array(z.string()).optional(),
  champion: z.string().optional(),
  league: z.string().optional(),
  /** Subset of the tool input. */
  input: z.record(z.string(), Scalar).optional(),
  /** Exact row count, or a minimum with `rowsMin`. */
  rows: z.number().int().optional(),
  rowsMin: z.number().int().optional(),
  totals: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  ambiguity: z.object({ mention: z.string(), chosen: z.string(), alternatives: z.array(z.string()).optional() }).optional(),
  attempts: z.number().int().optional(),
  notes: z.array(z.string()).optional(),
  sources: z.number().int().optional(),
  /** Substrings the summary must contain, and must not contain (case-insensitive). */
  summaryIncludes: z.array(z.string()).optional(),
  summaryExcludes: z.array(z.string()).optional(),
  /** The answer gives no figure: no row, no table, no digit in the summary. */
  noFigure: z.boolean().optional(),
  /** Words the rules did not understand and handed to the LLM router (answer.meta.unread). */
  unread: z.array(z.string()).optional(),
});

const Case = z.strictObject({
  id: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
  /** Language the answer is asked in, like a page of that language does (default: French). */
  locale: z.enum(["fr", "en"]).optional(),
  /** The expected answer needs the LLM (tool choice or entities): not scored as passed without a key. */
  llm: z.boolean().optional(),
  expect: Expect,
});

type Case = z.infer<typeof Case>;

const QuestionsFile = z.object({
  $comment: z.string().optional(),
  /** Date the relative seasons are resolved against ("l'an dernier"), so the expectations do not move with the calendar. */
  now: z.iso.date(),
  questions: z.array(Case),
});

type Check = { name: string; ok: boolean | null; detail?: string }; // null = skipped

const file = resolve(import.meta.dirname, "../eval/questions.json");

const questions = QuestionsFile.parse(JSON.parse(readFileSync(file, "utf8")));
const now = new Date(questions.now);
const excludedTags = args.find((a) => a.startsWith("--exclude-tags="))?.slice(15).split(",") ?? [];
const cases = questions.questions.filter((c) => !c.tags.some((t) => excludedTags.includes(t)) && (!only || only.includes(c.id)) && (!flag("llm-only") || c.llm));

const unknown = only?.filter((id) => !questions.questions.some((c) => c.id === id)) ?? [];

if (unknown.length) {
  console.error(`--only : cas inconnu(s) : ${unknown.join(", ")}`);
  process.exit(1);
}

if (!cases.length) {
  console.error("aucun cas sélectionné");
  process.exit(1);
}

type Shown = Scalar | Scalar[] | undefined;

const same = (a: Shown, b: Shown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: Shown) => JSON.stringify(v);

function score(c: Case, answer: Answer, steps: Map<string, StepPart>): Check[] {
  const e = c.expect;
  const m = answer.meta;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, detail });
  // Without a key, text-to-SQL cannot run: the routing is still checked, the result is not.
  const noResult = e.route === "sql" && !m.sqlAvailable;
  // Without a key, a case that needs the LLM is only scored on what the rules decide.
  const noLlm = c.llm === true && !m.sqlAvailable;

  const result = (name: string, ok: boolean, detail?: string) =>
    add(name, noLlm || noResult ? null : ok, noLlm ? "demande le LLM" : noResult ? "pas de clé OpenRouter" : detail);

  const routed = (name: string, ok: boolean, detail?: string) => add(name, noLlm ? null : ok, noLlm ? "demande le LLM" : detail);

  const done = STEPS.filter((s) => steps.get(s)?.state === "done");
  add("4 étapes visibles", done.length === STEPS.length, `${done.length}/4 terminées`);
  routed("route", m.route === e.route, `attendu ${e.route}, obtenu ${m.route}`);

  if (e.players) add("joueurs", same(m.players, e.players), `attendu ${show(e.players)}, obtenu ${show(m.players)}`);

  if (e.teams) add("équipes", same(m.teams, e.teams), `attendu ${show(e.teams)}, obtenu ${show(m.teams)}`);

  if (e.champion) add("champion", m.champion === e.champion, `attendu ${e.champion}, obtenu ${m.champion}`);

  if (e.unread) add("mots non compris", same(m.unread, e.unread), `attendu ${show(e.unread)}, obtenu ${show(m.unread)}`);

  if (e.league) routed("compétition", m.league === e.league, `attendu ${e.league}, obtenu ${m.league}`);

  if (e.input) {
    const input = new Map<string, Scalar>(Object.entries(m.input ?? {}));

    for (const [k, v] of Object.entries(e.input))
      routed(`entrée ${k}`, same(input.get(k), v), `attendu ${show(v)}, obtenu ${show(input.get(k))}`);
  }

  if (e.ambiguity) {
    const a = m.ambiguities.find((x) => x.mention === e.ambiguity!.mention);
    add(
      "alias ambigu signalé",
      !!a && a.chosen === e.ambiguity.chosen && (e.ambiguity.alternatives ?? []).every((x) => a.alternatives.includes(x)),
      a ? `retenu ${a.chosen}, autres ${show(a.alternatives.slice(0, 4))}` : "aucune ambiguïté signalée",
    );
  }

  if (e.rows !== undefined || e.rowsMin !== undefined) {
    const n = answer.rows.length || answer.table?.rows.length || 0;
    const ok = e.rows !== undefined ? n === e.rows : n >= (e.rowsMin ?? 0);
    result("lignes", ok, `attendu ${e.rows ?? `≥ ${e.rowsMin}`}, obtenu ${n}`);
  }

  if (e.totals)
    for (const [k, v] of Object.entries(e.totals)) result(`total ${k}`, m.totals[k] === v, `attendu ${show(v)}, obtenu ${show(m.totals[k])}`);

  if (e.attempts !== undefined) result("tentatives", m.attempts === e.attempts, `attendu ${e.attempts}, obtenu ${m.attempts}`);

  if (e.notes)
    for (const n of e.notes) routed(`note « ${n} »`, answer.notes.some((x) => x.includes(n)), answer.notes.join(" | ") || "aucune note");

  const summary = answer.summary.toLowerCase();
  // A text-to-SQL summary says what the query returned: without a key there is none to check.
  const said = e.route === "sql" ? result : routed;

  if (e.summaryIncludes)
    for (const t of e.summaryIncludes) said(`synthèse contient « ${t} »`, summary.includes(t.toLowerCase()), answer.summary);

  if (e.summaryExcludes)
    for (const t of e.summaryExcludes) said(`synthèse sans « ${t} »`, !summary.includes(t.toLowerCase()), answer.summary);

  if (e.noFigure) {
    const figures = answer.rows.length + (answer.table?.rows.length ?? 0);
    routed("aucun chiffre donné", figures === 0 && !/\d/.test(answer.summary), `${figures} ligne(s) · ${answer.summary}`);
  }

  if (e.sources !== undefined || (e.route !== "out_of_scope" && answer.meta.rowCount > 0)) {
    const min = e.sources ?? 1;
    const wiki = answer.sources.filter((s) => s.url.startsWith("https://lol.fandom.com/wiki/"));
    result("sources Leaguepedia", wiki.length >= min, `attendu ≥ ${min}, obtenu ${wiki.length}`);
  }

  return checks;
}

const llm = getLlm();

console.log(`eval : ${cases.length} questions · mode ${llm ? `LLM (${llm.id})` : "déterministe (sans clé)"}\n`);

let total = 0;
let full = 0;
let skipped = 0;
const failures: string[] = [];
const needLlm: string[] = [];
const t0 = performance.now();

for (const c of cases) {
  const steps = new Map<string, StepPart>();
  let checks: Check[];
  const started = performance.now();

  try {
    const answer = await runAgent(
      c.question,
      (ev) => {
        if (ev.type === "step") steps.set(ev.part.step, ev.part);
      },
      now,
      undefined,
      c.locale,
    );

    checks = score(c, answer, steps);

    if (llm && !answer.meta.sqlAvailable && (c.llm || c.expect.route === "sql"))
      checks.push({ name: "disponibilité du LLM", ok: false, detail: "le modèle configuré est devenu indisponible" });
  } catch (err) {
    checks = [{ name: "exécution", ok: false, detail: err instanceof Error ? err.message : String(err) }];
  }

  const scored = checks.filter((k) => k.ok !== null);
  const passed = scored.filter((k) => k.ok).length;
  const s = scored.length ? passed / scored.length : 0;
  skipped += checks.length - scored.length;

  // A case that needs the LLM is not passed without a key, even when the rules' part is right.
  const pending = s === 1 && c.llm === true && !llm;

  if (pending) needLlm.push(c.id);
  else {
    total += s;

    if (s === 1) full++;
    else failures.push(c.id);
  }

  const ms = Math.round(performance.now() - started);
  console.log(
    `${pending ? "~" : s === 1 ? "✓" : "✗"} ${String(Math.round(100 * s)).padStart(3)} %  ${passed}/${scored.length}` +
      `${checks.length > scored.length ? ` (+${checks.length - scored.length} ignorés)` : ""}  ${c.id.padEnd(24)} ${c.question}  [${ms} ms]`,
  );

  for (const k of checks)
    if (flag("verbose") || k.ok === false)
      console.log(`      ${k.ok === null ? "–" : k.ok ? "ok" : "xx"} ${k.name}${k.detail ? ` : ${k.detail}` : ""}`);
}

const judged = cases.length - needLlm.length;
const global = judged ? (100 * total) / judged : 0;

console.log(
  `\nscore global : ${global.toFixed(1)} % · ${full}/${judged} questions entièrement réussies` +
    `${skipped ? ` · ${skipped} vérifications ignorées (LLM ou text-to-SQL sans clé)` : ""} · ${Math.round(performance.now() - t0)} ms`,
);

if (needLlm.length) console.log(`demandent le LLM, non vérifiés sans clé (${needLlm.length}) : ${needLlm.join(", ")}`);

if (failures.length) console.log(`échecs : ${failures.join(", ")}`);

if (flag("strict") && !judged) console.error("--strict : aucun cas vérifié (tous demandent le LLM)");

if (flag("strict") && (failures.length || !judged)) process.exit(1);
