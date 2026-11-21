import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const args = process.argv.slice(2);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const Measured = z.object({ id: z.string(), question: z.string(), ms: z.array(z.number()), fingerprint: z.string(), route: z.string(), rows: z.number(), title: z.string() });

const Report = z.object({ database: z.string(), startedAt: z.string(), passes: z.number(), firstMs: z.number(), questions: z.array(Measured) });

type Measured = z.infer<typeof Measured>;

type Report = z.infer<typeof Report>;

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : Number.NaN;
};

const summary = (r: Report) => {
  const per = r.questions.map((q) => percentile(q.ms.length > 1 ? q.ms.slice(1) : q.ms, 50));

  return { p50: percentile(per, 50), p95: percentile(per, 95), p99: percentile(per, 99), max: Math.max(...per) };
};

const line = (r: Report) => {
  const s = summary(r);

  return `${r.database}: ${r.questions.length} questions, first ${r.firstMs} ms, p50 ${s.p50} ms, p95 ${s.p95} ms, p99 ${s.p99} ms, max ${s.max} ms`;
};

const compare = option("compare");

if (compare) {
  const [a, b] = compare.split(",").map((f) => Report.parse(JSON.parse(readFileSync(f, "utf8"))));
  const before = new Map(a.questions.map((q) => [q.id, q]));
  const after = new Map(b.questions.map((q) => [q.id, q]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  const differ = [...ids].filter((id) => before.get(id)?.fingerprint !== after.get(id)?.fingerprint);
  const describe = (q: Measured | undefined) => q ? `${q.route}/${q.rows} "${q.title}"` : "absent";

  console.log(`A ${line(a)}`);
  console.log(`B ${line(b)}`);
  console.log(`same answer: ${ids.size - differ.length}/${ids.size}`);

  for (const id of differ) console.log(`  ${id}: ${describe(before.get(id))} ≠ ${describe(after.get(id))}`);

  process.exit(0);
}

const out = option("out");

if (!out) throw new Error("--out=<file> is required");

const passes = Number(option("passes") ?? 2);

if (!Number.isSafeInteger(passes) || passes < 2) throw new Error("--passes must be an integer of at least 2 (including the warm-up)");

delete process.env.OPENROUTER_API_KEY;

delete process.env.LANGFUSE_PUBLIC_KEY;

const { runAgent } = await import("../../src/lib/agent/run");

type Answer = Awaited<ReturnType<typeof runAgent>>;

const Questions = z.object({ now: z.string(), questions: z.array(z.object({ id: z.string(), question: z.string(), tags: z.array(z.string()), locale: z.enum(["fr", "en"]).optional() })) });
const file = Questions.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../eval/questions.json"), "utf8")));
const now = new Date(file.now);
const cases = file.questions.filter((q) => !q.tags.includes("timeline"));
const fingerprint = (answer: Answer) => createHash("sha256").update(JSON.stringify(answer)).digest("hex").slice(0, 16);
const measured: Measured[] = [];
const answers = new Map<string, Answer>();
let firstMs = 0;

for (let pass = 0; pass < passes; pass++) {
  for (const [i, c] of cases.entries()) {
    const started = performance.now();
    const answer = await runAgent(c.question, () => {}, now, undefined, c.locale ?? "fr");
    const ms = Math.round(performance.now() - started);

    if (pass > 0) {
      measured[i].ms.push(ms);
      continue;
    }

    if (i === 0) firstMs = ms;

    answers.set(c.id, answer);
    measured.push({ id: c.id, question: c.question, ms: [ms], fingerprint: fingerprint(answer), route: answer.meta.route, rows: answer.meta.rowCount, title: answer.title });
  }
}

const report: Report = { database: "postgres", startedAt: new Date().toISOString(), passes, firstMs, questions: measured };

writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);

const dump = option("answers");

if (dump) writeFileSync(dump, `${JSON.stringify(Object.fromEntries(answers), null, 1)}\n`);

console.log(line(report));

process.exit(0);
