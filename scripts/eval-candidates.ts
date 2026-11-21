/**
 * Proposes candidate eval cases from the production Langfuse traces: the
 * questions that went to generated SQL, got a thumbs down, ended on
 * `missing_data` or left words the rules did not read. Each one is replayed
 * deterministically (rules only, no LLM) to show where it goes today.
 *
 *   bun run eval:candidates                  last 30 days of production
 *   bun run eval:candidates --days=90        a longer window
 *   bun run eval:candidates --env=preview    another Langfuse environment
 *   bun run eval:candidates --no-replay      without the database (route then only)
 *   bun run eval:candidates --out=DIR        another output directory (see below)
 *
 * Privacy, the repository being public: what visitors typed (questions, trace
 * and session ids) is never committed, pushed or quoted in a PR, a commit or
 * a comment. The report is written outside the repository, in
 * ~/.farsight/eval-candidates/ (0700, files 0600); `--out` inside the
 * repository is refused unless git ignores it. The questions are masked again
 * (src/lib/tracing/mask.ts), which does not replace a human review: the
 * script only proposes, Enzo decides what becomes a case of
 * eval/questions.json, reformulated when needed. Tests use synthetic traces
 * only (scripts/eval-candidates.test.ts).
 *
 * Langfuse: read-only calls (GET /api/public/v2/observations and
 * /api/public/v3/scores). Keys come from LANGFUSE_PUBLIC_KEY,
 * LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (.env, .env.local, or
 * ~/.farsight/langfuse.env), and are never printed. The replay reads
 * DATABASE_URL like `bun run eval`. Details: docs/eval-candidates.md.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { LOCALES } from "../src/lib/locale";
import { maskPersonalData } from "../src/lib/tracing/mask";
import { type Candidate, candidatesOf, guessLocale, REASONS, type TracedQuestion, withoutEvalCases } from "./eval-candidates/select";

const args = process.argv.slice(2);
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const days = Number(option("days") ?? 30);
const environment = option("env") ?? "production";
const replay = !args.includes("--no-replay");
const repo = resolve(import.meta.dirname, "..");
const outDir = resolve(option("out") ?? join(homedir(), ".farsight", "eval-candidates"));

if (!Number.isFinite(days) || days <= 0) {
  console.error("--days : un nombre de jours positif");
  process.exit(1);
}

/** A directory inside the repository is accepted only when git ignores what goes in it. */
function checkOutDir(dir: string) {
  const inside = relative(repo, dir);

  if (inside.startsWith("..") || resolve(repo, inside) !== dir) return;

  try {
    execFileSync("git", ["check-ignore", "-q", join(inside, "report.json")], { cwd: repo, stdio: "ignore" });
  } catch {
    console.error(`--out : ${inside || "."} est dans le dépôt et git ne l'ignore pas ; le rapport n'y est jamais écrit`);
    process.exit(1);
  }
}

checkOutDir(outDir);

/** LANGFUSE_* from the environment (Bun reads .env and .env.local), else from ~/.farsight/langfuse.env. */
function langfuseKeys() {
  const file = join(homedir(), ".farsight", "langfuse.env");
  const fromFile: Record<string, string> = {};

  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(LANGFUSE_[A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);

      if (m) fromFile[m[1]] = m[2];
    }

  const read = (name: string) => process.env[name]?.trim() || fromFile[name]?.trim() || "";
  const keys = { publicKey: read("LANGFUSE_PUBLIC_KEY"), secretKey: read("LANGFUSE_SECRET_KEY"), baseUrl: read("LANGFUSE_BASE_URL").replace(/\/+$/, "") };

  // The replay never needs them: out of the environment before the agent is imported.
  for (const name of Object.keys(process.env)) if (name.startsWith("LANGFUSE_")) delete process.env[name];

  if (!keys.publicKey || !keys.secretKey || !keys.baseUrl) {
    console.error("LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY et LANGFUSE_BASE_URL sont requis (.env, .env.local ou ~/.farsight/langfuse.env)");
    process.exit(1);
  }

  return keys;
}

const keys = langfuseKeys();
const authorization = `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString("base64")}`;

/** A text field of Langfuse, empty when absent or of another kind. */
const Text = z.string().catch("");

/** Root observation `answer-question`: the question in, the summary out, and the metadata `recordOutcome` writes. */
const Root = z.object({
  traceId: z.string(),
  startTime: z.string(),
  input: Text,
  output: Text,
  metadata: z
    .object({
      question: Text,
      route: Text,
      unread: z.array(z.string()).catch([]),
      locale: z.enum(LOCALES).optional().catch(undefined),
    })
    .catch({ question: "", route: "", unread: [], locale: undefined }),
});

/** A `response_rating` score: a boolean on its trace. */
const Score = z.object({ value: z.union([z.boolean(), z.number()]).catch(0), subject: z.object({ kind: z.string(), id: z.string() }).nullish() });

const Page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), meta: z.object({ cursor: z.string().nullish() }).partial().nullish() });

/**
 * Every page of a cursor-paginated list of the Langfuse public API, parsed.
 * An error names the path and the status, never the request.
 */
async function all<T extends z.ZodType>(path: string, query: Record<string, string>, item: T): Promise<z.infer<T>[]> {
  const items: z.infer<T>[] = [];
  let cursor: string | null | undefined;

  do {
    const url = new URL(`${keys.baseUrl}${path}`);

    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(30_000) });

    if (!res.ok) throw new Error(`Langfuse ${path} : HTTP ${res.status}`);
    const page = Page(item).parse(await res.json());

    items.push(...page.data);
    cursor = page.meta?.cursor;
  } while (cursor);

  return items;
}

const since = new Date(Date.now() - days * 86_400_000).toISOString();

const [roots, scores] = await Promise.all([
  all("/api/public/v2/observations", { name: "answer-question", environment, fromStartTime: since, fields: "core,basic,io,metadata", expandMetadata: "question,unread", limit: "1000" }, Root),
  all("/api/public/v3/scores", { name: "response_rating", environment, fields: "subject", limit: "100" }, Score),
]);

const ratings = new Map<string, "up" | "down">();

for (const s of scores) if (s.subject?.kind === "trace") ratings.set(s.subject.id, s.value === true || s.value === 1 ? "up" : "down");

const traced: TracedQuestion[] = roots.flatMap((r) => {
  // The root's input is the whole question; the metadata keeps its first 200 characters.
  const question = maskPersonalData(r.input || r.metadata.question).trim();

  if (!question) return [];
  const recorded = r.metadata.locale;

  return [{
    traceId: r.traceId,
    date: r.startTime,
    question,
    route: r.metadata.route || null,
    unread: r.metadata.unread,
    locale: recorded ?? guessLocale(r.output),
    localeGuessed: !recorded,
    rating: ratings.get(r.traceId) ?? null,
  }];
});

const EvalFile = z.object({ questions: z.array(z.object({ question: z.string(), locale: z.enum(LOCALES).optional() })) });

const evalCases = EvalFile.parse(JSON.parse(readFileSync(join(repo, "eval", "questions.json"), "utf8"))).questions;
const merged = candidatesOf(traced);
const candidates = withoutEvalCases(merged, evalCases);

/** Where the question goes today, on the rules alone. */
type Now = { route: string; unread: string[]; title: string } | { error: string };

async function replayAll(list: Candidate[]): Promise<Map<string, Now>> {
  const result = new Map<string, Now>();

  if (!replay) return result;
  // Imported after the key is gone, like `bun run eval --deterministic`: the replay never calls a model.
  delete process.env.OPENROUTER_API_KEY;
  const { runAgent } = await import("../src/lib/agent/run");

  for (const c of list) {
    try {
      const answer = await runAgent(c.question, () => {}, new Date(), undefined, c.locale);
      result.set(c.key, { route: answer.meta.route, unread: answer.meta.unread, title: answer.title });
    } catch (err) {
      result.set(c.key, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

const now = await replayAll(candidates);

type Status = "still-sql" | "fixed" | "changed" | "same" | "not-replayed";

/** What the replay says of a candidate: still to SQL, now answered by a typed tool without unread word, or else. */
function statusOf(c: Candidate, n: Now | undefined): Status {
  if (!n || "error" in n) return "not-replayed";

  if (n.route === "sql") return "still-sql";
  const typed = !["out_of_scope", "missing_data", "none"].includes(n.route);

  if (typed && n.unread.length === 0) return "fixed";

  return n.route === c.routes.at(-1) ? "same" : "changed";
}

const report = candidates.map((c) => {
  const n = now.get(c.key);

  return {
    question: c.question,
    locale: c.locale,
    localeGuessed: c.localeGuessed,
    reasons: c.reasons,
    routeThen: c.routes,
    unreadThen: c.unread,
    routeNow: n && !("error" in n) ? n.route : null,
    unreadNow: n && !("error" in n) ? n.unread : null,
    replayError: n && "error" in n ? n.error : null,
    status: statusOf(c, n),
    feedback: c.rating,
    traces: c.traces,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
    lastTraceId: c.lastTraceId,
  };
});

const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;

const summary = {
  generatedAt: new Date().toISOString(),
  environment,
  since,
  traces: traced.length,
  questionsWithReason: merged.length,
  alreadyInEval: merged.length - candidates.length,
  candidates: candidates.length,
  byReason: Object.fromEntries(REASONS.map((r) => [r, count(candidates, (c) => c.reasons.includes(r))])),
  byStatus: Object.fromEntries((["still-sql", "fixed", "changed", "same", "not-replayed"] as const).map((s) => [s, count(report, (r) => r.status === s)])),
  byLocale: Object.fromEntries(LOCALES.map((l) => [l, count(candidates, (c) => c.locale === l)])),
};

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

const markdown = [
  "# Candidats d'eval (local, ne jamais committer)",
  "",
  `Environnement ${environment}, depuis ${since.slice(0, 10)}, généré le ${summary.generatedAt.slice(0, 16)}Z.`,
  `${summary.traces} traces, ${summary.questionsWithReason} questions à motif, ${summary.alreadyInEval} déjà dans l'eval, **${summary.candidates} candidats**.`,
  `Aujourd'hui (règles seules) : ${Object.entries(summary.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
  "",
  "Langue suivie de `?` : devinée d'après la réponse (trace antérieure à la métadonnée `locale`).",
  "",
  "| question | langue | motifs | route alors | route aujourd'hui | non lus alors → aujourd'hui | avis 👍/👎 | traces | dernière |",
  "|---|---|---|---|---|---|---|---|---|",
  ...report.map((r) =>
    `| ${cell(r.question)} | ${r.locale}${r.localeGuessed ? "?" : ""} | ${r.reasons.join(", ")} | ${r.routeThen.join(" → ")} | ${r.routeNow ?? r.replayError ?? "—"} (${r.status}) | ${r.unreadThen.join(" ") || "—"} → ${r.unreadNow?.join(" ") || "—"} | ${r.feedback.up}/${r.feedback.down} | ${r.traces} | ${r.lastSeen.slice(0, 10)} |`,
  ),
  "",
].join("\n");

mkdirSync(outDir, { recursive: true, mode: 0o700 });

chmodSync(outDir, 0o700);

const stamp = summary.generatedAt.replace(/[:.]/g, "-").slice(0, 19);

for (const [name, body] of [[`candidates-${stamp}.json`, JSON.stringify({ summary, candidates: report }, null, 2)], [`candidates-${stamp}.md`, markdown]] as const) {
  writeFileSync(join(outDir, name), body, { mode: 0o600 });
}

// Counts only on the terminal: the questions stay in the report.
console.log(JSON.stringify(summary, null, 2));

console.log(`rapport : ${join(outDir, `candidates-${stamp}.md`)}`);
