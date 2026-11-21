/**
 * Selection of the candidate eval cases (scripts/eval-candidates.ts): which
 * traces show a router gap, how their questions are merged, and which ones the
 * eval already covers. Pure functions, tested on synthetic traces only
 * (scripts/eval-candidates.test.ts): never put a real visitor question in a
 * fixture, the repository is public.
 */
import type { Locale } from "../../src/lib/locale";

/** One question as its trace recorded it (root observation `answer-question`, and its `response_rating` score). */
export type TracedQuestion = {
  traceId: string;
  /** ISO start time of the trace. */
  date: string;
  /** The question, personal data already masked. */
  question: string;
  /** `answer.meta.route` when it was answered. */
  route: string | null;
  /** `answer.meta.unread`: words the rules did not understand. */
  unread: string[];
  /** The page's language when the trace records it, else guessed from the answer (`localeGuessed`). */
  locale: Locale;
  localeGuessed: boolean;
  rating: "up" | "down" | null;
};

/** Why a question is a candidate. */
export type Reason = "sql" | "down" | "missing_data" | "unread";

export const REASONS: readonly Reason[] = ["sql", "down", "missing_data", "unread"];

/** The reasons a trace points at a gap of the router; none means the question was answered as expected. */
export function reasonsOf(t: Pick<TracedQuestion, "route" | "unread" | "rating">): Reason[] {
  const on: Record<Reason, boolean> = {
    sql: t.route === "sql",
    down: t.rating === "down",
    missing_data: t.route === "missing_data",
    unread: t.unread.length > 0,
  };

  return REASONS.filter((r) => on[r]);
}

/**
 * The key two questions share when they ask the same thing: case, accents,
 * punctuation and spacing aside ("Résultats de Chovy ?" = "resultats de chovy").
 */
export function normalizeQuestion(question: string): string {
  return question
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** One question to review, every trace that asked it merged. */
export type Candidate = {
  key: string;
  /** The question as last asked. */
  question: string;
  locale: Locale;
  localeGuessed: boolean;
  reasons: Reason[];
  /** Routes it took, oldest first, without repeats. */
  routes: string[];
  unread: string[];
  rating: { up: number; down: number };
  traces: number;
  firstSeen: string;
  lastSeen: string;
  /** Id of the last trace, to open it in Langfuse. Local report only. */
  lastTraceId: string;
};

/**
 * The candidates among the traces: those with at least one reason, merged by
 * normalized question and language (the same words asked from the English
 * page are another case), most recent first.
 */
export function candidatesOf(traces: TracedQuestion[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const sorted = [...traces].sort((a, b) => a.date.localeCompare(b.date));

  for (const t of sorted) {
    const reasons = reasonsOf(t);

    if (!reasons.length) continue;
    const key = `${t.locale}:${normalizeQuestion(t.question)}`;
    const c = byKey.get(key);

    if (!c) {
      byKey.set(key, {
        key,
        question: t.question,
        locale: t.locale,
        localeGuessed: t.localeGuessed,
        reasons,
        routes: t.route ? [t.route] : [],
        unread: [...t.unread],
        rating: { up: t.rating === "up" ? 1 : 0, down: t.rating === "down" ? 1 : 0 },
        traces: 1,
        firstSeen: t.date,
        lastSeen: t.date,
        lastTraceId: t.traceId,
      });
      continue;
    }

    c.question = t.question;
    c.localeGuessed &&= t.localeGuessed;
    c.reasons = REASONS.filter((r) => c.reasons.includes(r) || reasons.includes(r));
    c.unread = [...new Set([...c.unread, ...t.unread])];
    c.traces += 1;
    c.lastSeen = t.date;
    c.lastTraceId = t.traceId;

    if (t.route && !c.routes.includes(t.route)) c.routes.push(t.route);

    if (t.rating) c.rating[t.rating] += 1;
  }

  return [...byKey.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** The eval's own questions (eval/questions.json), with their language: French unless a case sets one. */
export type EvalQuestion = { question: string; locale?: Locale };

/** Candidates the eval does not ask yet, in the same language. */
export function withoutEvalCases(candidates: Candidate[], cases: EvalQuestion[]): Candidate[] {
  const known = new Set(cases.map((c) => `${c.locale ?? "fr"}:${normalizeQuestion(c.question)}`));

  return candidates.filter((c) => !known.has(c.key));
}

const ENGLISH = new Set(["the", "and", "of", "in", "games", "game", "won", "played", "no", "with", "at", "his", "their", "wins", "against"]);

const FRENCH = new Set(["le", "la", "les", "des", "du", "de", "et", "en", "une", "aucun", "aucune", "partie", "parties", "joué", "victoires", "contre", "avec", "sur"]);

/**
 * The language of an answer, for the traces recorded before the trace kept
 * the page's: the agent answers in the page's language, so its summary tells
 * it. French when nothing decides, like the agent.
 */
export function guessLocale(answer: string): Locale {
  const words = answer.toLowerCase().split(/[^\p{L}]+/u);
  const en = words.filter((w) => ENGLISH.has(w)).length;
  const fr = words.filter((w) => FRENCH.has(w)).length;

  return en > fr ? "en" : "fr";
}
