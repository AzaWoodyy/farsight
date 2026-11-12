/**
 * Replays the reference questions (eval/questions.json) through the agent and
 * scores each one against its expectations.
 *
 *   bun run eval                   uses OPENROUTER_API_KEY if it is set, else deterministic
 *   bun run eval --deterministic   ignores the key (rules level only)
 *   bun run eval --only=worlds-chovy,alias-hangul
 *   bun run eval --strict          exit 1 unless every check passes
 *   bun run eval --verbose         print every check, not only the failing ones
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
if (flag("deterministic")) delete process.env.OPENROUTER_API_KEY;

// Imported after the flag so the LLM client never sees an ignored key.
const { runAgent } = await import("../src/lib/agent/run");
const { getLlm } = await import("../src/lib/agent/llm");
const { STEPS } = await import("../src/lib/agent/types");
type Answer = import("../src/lib/agent/types").Answer;
type StepPart = import("../src/lib/agent/types").StepPart;

type Expect = {
  route: string;
  players?: string[];
  teams?: string[];
  champion?: string;
  league?: string;
  input?: Record<string, unknown>;
  rows?: number | { min?: number; max?: number };
  totals?: Record<string, string | number>;
  ambiguity?: { mention: string; chosen: string; alternatives?: string[] };
  attempts?: number;
  notes?: string[];
  sources?: number;
};
type Case = { id: string; question: string; tags: string[]; expect: Expect };
type Check = { name: string; ok: boolean | null; detail?: string }; // null = skipped

const file = resolve(import.meta.dirname, "../eval/questions.json");
const cases = (JSON.parse(readFileSync(file, "utf8")) as { questions: Case[] }).questions.filter(
  (c) => !only || only.includes(c.id),
);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => JSON.stringify(v);

function score(c: Case, answer: Answer, steps: Map<string, StepPart>): Check[] {
  const e = c.expect;
  const m = answer.meta;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, detail });
  // Without a key, text-to-SQL cannot run: the routing is still checked, the result is not.
  const noResult = e.route === "sql" && !m.sqlAvailable;
  const result = (name: string, ok: boolean, detail?: string) => add(name, noResult ? null : ok, noResult ? "pas de clé OpenRouter" : detail);

  const done = STEPS.filter((s) => steps.get(s)?.state === "done");
  add("4 étapes visibles", done.length === STEPS.length, `${done.length}/4 terminées`);
  add("route", m.route === e.route, `attendu ${e.route}, obtenu ${m.route}`);
  if (e.players) add("joueurs", same(m.players, e.players), `attendu ${show(e.players)}, obtenu ${show(m.players)}`);
  if (e.teams) add("équipes", same(m.teams, e.teams), `attendu ${show(e.teams)}, obtenu ${show(m.teams)}`);
  if (e.champion) add("champion", m.champion === e.champion, `attendu ${e.champion}, obtenu ${m.champion}`);
  if (e.league) add("compétition", m.league === e.league, `attendu ${e.league}, obtenu ${m.league}`);
  if (e.input)
    for (const [k, v] of Object.entries(e.input))
      add(`entrée ${k}`, same(m.input[k] ?? null, v), `attendu ${show(v)}, obtenu ${show(m.input[k])}`);
  if (e.ambiguity) {
    const a = m.ambiguities.find((x) => x.mention === e.ambiguity!.mention);
    add(
      "alias ambigu signalé",
      !!a && a.chosen === e.ambiguity.chosen && (e.ambiguity.alternatives ?? []).every((x) => a.alternatives.includes(x)),
      a ? `retenu ${a.chosen}, autres ${show(a.alternatives.slice(0, 4))}` : "aucune ambiguïté signalée",
    );
  }
  if (e.rows !== undefined) {
    const n = answer.rows.length || answer.table?.rows.length || 0;
    const ok = typeof e.rows === "number" ? n === e.rows : n >= (e.rows.min ?? 0) && n <= (e.rows.max ?? Infinity);
    result("lignes", ok, `attendu ${show(e.rows)}, obtenu ${n}`);
  }
  if (e.totals)
    for (const [k, v] of Object.entries(e.totals)) result(`total ${k}`, m.totals[k] === v, `attendu ${show(v)}, obtenu ${show(m.totals[k])}`);
  if (e.attempts !== undefined) result("tentatives", m.attempts === e.attempts, `attendu ${e.attempts}, obtenu ${m.attempts}`);
  if (e.notes)
    for (const n of e.notes) add(`note « ${n} »`, answer.notes.some((x) => x.includes(n)), answer.notes.join(" | ") || "aucune note");
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
const t0 = performance.now();
for (const c of cases) {
  const steps = new Map<string, StepPart>();
  let checks: Check[];
  const started = performance.now();
  try {
    const answer = await runAgent(c.question, (ev) => {
      if (ev.type === "step") steps.set(ev.part.step, ev.part);
    });
    checks = score(c, answer, steps);
  } catch (err) {
    checks = [{ name: "exécution", ok: false, detail: (err as Error).message }];
  }
  const scored = checks.filter((k) => k.ok !== null);
  const passed = scored.filter((k) => k.ok).length;
  const s = scored.length ? passed / scored.length : 0;
  total += s;
  skipped += checks.length - scored.length;
  if (s === 1) full++;
  else failures.push(c.id);
  const ms = Math.round(performance.now() - started);
  console.log(
    `${s === 1 ? "✓" : "✗"} ${String(Math.round(100 * s)).padStart(3)} %  ${passed}/${scored.length}` +
      `${checks.length > scored.length ? ` (+${checks.length - scored.length} ignorés)` : ""}  ${c.id.padEnd(24)} ${c.question}  [${ms} ms]`,
  );
  for (const k of checks)
    if (flag("verbose") || k.ok === false)
      console.log(`      ${k.ok === null ? "–" : k.ok ? "ok" : "xx"} ${k.name}${k.detail ? ` : ${k.detail}` : ""}`);
}

const global = cases.length ? (100 * total) / cases.length : 0;
console.log(
  `\nscore global : ${global.toFixed(1)} % · ${full}/${cases.length} questions entièrement réussies` +
    `${skipped ? ` · ${skipped} vérifications ignorées (text-to-SQL sans clé)` : ""} · ${Math.round(performance.now() - t0)} ms`,
);
if (failures.length) console.log(`échecs : ${failures.join(", ")}`);
if (flag("strict") && full < cases.length) process.exit(1);
