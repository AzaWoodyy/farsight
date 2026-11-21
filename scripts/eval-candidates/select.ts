import type { Locale } from "../../src/lib/locale";

export type TracedQuestion = {
  traceId: string;
  date: string;
  question: string;
  route: string | null;
  unread: string[];
  locale: Locale;
  localeGuessed: boolean;
  rating: "up" | "down" | null;
};

export type Reason = "sql" | "down" | "missing_data" | "unread";

export const REASONS: readonly Reason[] = ["sql", "down", "missing_data", "unread"];

export function reasonsOf(t: Pick<TracedQuestion, "route" | "unread" | "rating">): Reason[] {
  const on: Record<Reason, boolean> = {
    sql: t.route === "sql",
    down: t.rating === "down",
    missing_data: t.route === "missing_data",
    unread: t.unread.length > 0,
  };

  return REASONS.filter((r) => on[r]);
}

export function normalizeQuestion(question: string): string {
  return question
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type Candidate = {
  key: string;
  question: string;
  locale: Locale;
  localeGuessed: boolean;
  reasons: Reason[];
  routes: string[];
  unread: string[];
  rating: { up: number; down: number };
  traces: number;
  firstSeen: string;
  lastSeen: string;
  lastTraceId: string;
};

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

export type EvalQuestion = { question: string; locale?: Locale };

export function withoutEvalCases(candidates: Candidate[], cases: EvalQuestion[]): Candidate[] {
  const known = new Set(cases.map((c) => `${c.locale ?? "fr"}:${normalizeQuestion(c.question)}`));

  return candidates.filter((c) => !known.has(c.key));
}

const ENGLISH = new Set(["the", "and", "of", "in", "games", "game", "won", "played", "no", "with", "at", "his", "their", "wins", "against"]);

const FRENCH = new Set(["le", "la", "les", "des", "du", "de", "et", "en", "une", "aucun", "aucune", "partie", "parties", "joué", "victoires", "contre", "avec", "sur"]);

export function guessLocale(answer: string): Locale {
  const words = answer.toLowerCase().split(/[^\p{L}]+/u);
  const en = words.filter((w) => ENGLISH.has(w)).length;
  const fr = words.filter((w) => FRENCH.has(w)).length;

  return en > fr ? "en" : "fr";
}
