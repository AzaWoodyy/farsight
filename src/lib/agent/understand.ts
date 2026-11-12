import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeAlias } from "../aliases";
import type { Entities, ResolvedPlayer } from "./types";
import { getChatModel } from "./llm";

/** Canonical league labels (as stored in tournaments.league) and their cues. */
const LEAGUES: { label: string; pattern: RegExp }[] = [
  {
    label: "World Championship",
    pattern:
      /\b(worlds?|world championship|mondiaux|mondial|championnats? du monde|coupe du monde)\b/i,
  },
  { label: "Mid-Season Invitational", pattern: /\b(msi|mid[- ]season invitational)\b/i },
  { label: "LCK", pattern: /\blck\b/i },
  { label: "LPL", pattern: /\blpl\b/i },
  { label: "LEC", pattern: /\blec\b/i },
  { label: "LCS", pattern: /\blcs\b/i },
];

const STOPWORDS = new Set(
  (
    "a à au aux de des du d le la les l un une et ou en dans sur pour par avec " +
    "tous toutes tout toute ses son sa leurs leur quel quels quelle quelles " +
    "resultat resultats résultat résultats bilan stats statistiques champions " +
    "champion joue joués jouer depuis entre avant apres après annee annees année " +
    "années saison saisons edition editions édition éditions the of at in on all " +
    "results result record by for with from to and stats year years every each " +
    "worlds world championship mondiaux mondial msi lck lpl lec lcs show me give " +
    "what which how montre donne quelles quels est sont été"
  ).split(/\s+/),
);

type AliasHit = {
  player: string;
  raw_alias: string;
  source: string;
  games: number;
};

function lookupAlias(db: DatabaseSync, mention: string): AliasHit[] {
  return db
    .prepare(
      `SELECT a.player, a.raw_alias, a.source,
              (SELECT COUNT(*) FROM games_players g WHERE g.player = a.player) AS games
       FROM player_aliases a
       WHERE a.alias = ?
       ORDER BY games DESC`,
    )
    .all(normalizeAlias(mention)) as AliasHit[];
}

export function resolvePlayer(
  db: DatabaseSync,
  mention: string,
): ResolvedPlayer | null {
  const hits = lookupAlias(db, mention);
  if (hits.length === 0) return null;
  const byPlayer = [...new Map(hits.map((h) => [h.player, h])).values()];
  const best = byPlayer[0];
  const info = db
    .prepare("SELECT real_name, native_name FROM players WHERE player = ?")
    .get(best.player) as { real_name: string | null; native_name: string | null } | undefined;
  return {
    mention,
    player: best.player,
    matchedAlias: best.raw_alias,
    aliasSource: best.source,
    realName: info?.real_name ?? null,
    nativeName: info?.native_name ?? null,
    otherCandidates: byPlayer.slice(1).map((h) => h.player),
  };
}

function detectLeague(question: string) {
  for (const l of LEAGUES) {
    const m = l.pattern.exec(question);
    if (m) return { league: l.label, mention: m[0] };
  }
  return { league: null, mention: null };
}

function detectPeriod(question: string) {
  const years = [...question.matchAll(/\b(20[1-3]\d)\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return { yearFrom: null, yearTo: null };
  const since = /\b(depuis|since|apr[eè]s|after|from)\s+(20[1-3]\d)\b/i.exec(question);
  const before = /\b(avant|before|until|jusqu'?en)\s+(20[1-3]\d)\b/i.exec(question);
  if (since && years.length === 1) return { yearFrom: Number(since[2]), yearTo: null };
  if (before && years.length === 1) return { yearFrom: null, yearTo: Number(before[2]) };
  return { yearFrom: Math.min(...years), yearTo: Math.max(...years) };
}

/** Rule-based player detection: longest n-gram that matches a known alias. */
function detectPlayerMentions(db: DatabaseSync, question: string): string[] {
  const tokens = question
    .replace(/[’']/g, " ")
    .split(/[^\p{L}\p{N}.\-]+/u)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter(Boolean);
  const found: string[] = [];
  const used = new Set<number>();
  for (let size = 3; size >= 1; size--) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const span = Array.from({ length: size }, (_, k) => i + k);
      if (span.some((k) => used.has(k))) continue;
      const words = tokens.slice(i, i + size);
      if (words.every((w) => STOPWORDS.has(w.toLowerCase()))) continue;
      if (size === 1 && STOPWORDS.has(words[0].toLowerCase())) continue;
      if (/^\d+$/.test(words.join(""))) continue;
      const mention = words.join(" ");
      const norm = normalizeAlias(mention);
      const isHangulOrHan = /[\p{Script=Hangul}\p{Script=Han}]/u.test(mention);
      if (norm.length < (isHangulOrHan ? 2 : 3)) continue;
      if (lookupAlias(db, mention).length > 0) {
        found.push(mention);
        span.forEach((k) => used.add(k));
      }
    }
  }
  return found;
}

const LlmEntities = z.object({
  players: z
    .array(z.string())
    .describe("Player names exactly as written in the question (handles, real names, Hangul)."),
  teams: z.array(z.string()).describe("Team names mentioned."),
  league: z
    .enum(["World Championship", "Mid-Season Invitational", "LCK", "LPL", "LEC", "LCS"])
    .nullable()
    .describe("Competition the question is about. Worlds / Mondiaux = World Championship."),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
});

export type UnderstandOutput = {
  entities: Entities;
  method: "llm" | "rules";
  llmError?: string;
};

export async function understandQuestion(
  db: DatabaseSync,
  question: string,
): Promise<UnderstandOutput> {
  const llm = await getChatModel();
  let raw: z.infer<typeof LlmEntities> | null = null;
  let llmError: string | undefined;

  if (llm) {
    try {
      raw = await llm.model.withStructuredOutput(LlmEntities).invoke([
        {
          role: "system",
          content:
            "Extract League of Legends esports entities from the user's question. " +
            "Do not translate or correct player names; copy them as written.",
        },
        { role: "user", content: question },
      ]);
    } catch (err) {
      llmError = (err as Error).message;
    }
  }

  const rulesLeague = detectLeague(question);
  const rulesPeriod = detectPeriod(question);
  const mentions = raw?.players.length ? raw.players : detectPlayerMentions(db, question);

  const players: ResolvedPlayer[] = [];
  const unresolved: string[] = [];
  for (const m of mentions) {
    const p = resolvePlayer(db, m);
    if (p) players.push(p);
    else unresolved.push(m);
  }

  return {
    method: raw ? "llm" : "rules",
    llmError,
    entities: {
      players,
      unresolved,
      teams: raw?.teams ?? [],
      league: raw?.league ?? rulesLeague.league,
      leagueMention: rulesLeague.mention,
      yearFrom: raw?.yearFrom ?? rulesPeriod.yearFrom,
      yearTo: raw?.yearTo ?? rulesPeriod.yearTo,
    },
  };
}
