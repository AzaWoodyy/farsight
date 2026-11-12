import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { normalizeAlias } from "../aliases";
import { type Decider, decide } from "./decide";
import { getLlm, LLM_CALL } from "./llm";
import type { Entities, ResolvedPlayer } from "./types";

/** Cues for the Leaguepedia `League` values of the scope (leagues.name). */
const LEAGUE_CUES: { league: string; pattern: RegExp }[] = [
  {
    league: "World Championship",
    pattern: /\b(worlds?|world championship|mondiaux|mondial|championnats? du monde|coupe du monde)\b/i,
  },
  { league: "Mid-Season Invitational", pattern: /\b(msi|mid[- ]season invitational)\b/i },
  { league: "LCK Challengers League", pattern: /\b(lck cl|lck challengers)\b/i },
  { league: "LCK Academy Series", pattern: /\blck (as|academy)\b/i },
  { league: "LoL Champions Korea", pattern: /\blck\b/i },
  { league: "LoL The Champions", pattern: /\b(ogn|champions korea \d{4}|the champions)\b/i },
  { league: "Challengers Korea", pattern: /\bchallengers korea\b/i },
  { league: "Tencent LoL Pro League", pattern: /\blpl\b/i },
  { league: "LoL EMEA Championship", pattern: /\blec\b/i },
  { league: "Europe League Championship Series", pattern: /\beu ?lcs\b/i },
  { league: "EMEA Masters", pattern: /\bemea masters\b/i },
  { league: "European Masters", pattern: /\b(eu masters|european masters)\b/i },
  { league: "North America League Championship Series", pattern: /\bna ?lcs\b/i },
  { league: "League of Legends Championship Series", pattern: /\blcs\b/i },
  { league: "League of Legends Championship of The Americas North", pattern: /\blta (north|nord)\b/i },
  { league: "League of Legends Championship of The Americas", pattern: /\blta\b/i },
  { league: "La Ligue Française Division 2", pattern: /\b(lfl d(iv(ision)?)? ?2|div2)\b/i },
  { league: "La Ligue Française", pattern: /\blfl\b/i },
  { league: "LVP SuperLiga 2nd Division", pattern: /\b(superliga|sl 2nd)\b/i },
];

const STOPWORDS = new Set(
  (
    "a à au aux de des du d le la les l un une et ou en dans sur pour par avec " +
    "tous toutes tout toute ses son sa leurs leur quel quels quelle quelles " +
    "resultat resultats résultat résultats bilan stats statistiques champions " +
    "champion joue joués jouer depuis entre avant apres après annee annees année " +
    "années saison saisons edition editions édition éditions the of at in on all " +
    "results result record by for with from to and stats year years every each " +
    "worlds world championship mondiaux mondial msi lck lpl lec lcs lfl lta show me give " +
    "what which how montre donne est sont été"
  ).split(/\s+/),
);

type AliasHit = { player: string; raw: string; real_name: string | null; native_name: string | null; games: number };

function lookupAlias(db: DatabaseSync, mention: string): AliasHit[] {
  return db
    .prepare(
      `SELECT p.page AS player, a.raw, p.real_name, p.native_name,
              (SELECT COUNT(*) FROM game_players g WHERE g.player_id = p.id) AS games
       FROM player_aliases a JOIN players p ON p.id = a.player_id
       WHERE a.alias = ?
       ORDER BY games DESC`,
    )
    .all(normalizeAlias(mention)) as AliasHit[];
}

export function resolvePlayer(db: DatabaseSync, mention: string): ResolvedPlayer | null {
  const hits = lookupAlias(db, mention);
  if (hits.length === 0) return null;
  const byPlayer = [...new Map(hits.map((h) => [h.player, h])).values()];
  const best = byPlayer[0];
  return {
    mention,
    player: best.player,
    matchedAlias: best.raw,
    realName: best.real_name,
    nativeName: best.native_name,
    otherCandidates: byPlayer.slice(1).map((h) => h.player),
  };
}

function detectLeague(question: string) {
  for (const l of LEAGUE_CUES) {
    const m = l.pattern.exec(question);
    if (m) return { league: l.league, mention: m[0] };
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

function leagueShort(db: DatabaseSync, league: string | null): string | null {
  if (!league) return null;
  const row = db.prepare("SELECT short_name FROM leagues WHERE name = ?").get(league) as
    | { short_name: string }
    | undefined;
  return row?.short_name ?? null;
}

function buildEntities(
  db: DatabaseSync,
  question: string,
  mentions: string[],
  overrides: Partial<Pick<Entities, "league" | "yearFrom" | "yearTo">> = {},
): Entities {
  const rulesLeague = detectLeague(question);
  const rulesPeriod = detectPeriod(question);
  const players: ResolvedPlayer[] = [];
  const unresolved: string[] = [];
  for (const m of mentions) {
    const p = resolvePlayer(db, m);
    if (p) players.push(p);
    else unresolved.push(m);
  }
  const league = overrides.league !== undefined ? overrides.league : rulesLeague.league;
  return {
    players,
    unresolved,
    league,
    leagueShort: leagueShort(db, league),
    leagueMention: rulesLeague.mention,
    yearFrom: overrides.yearFrom !== undefined ? overrides.yearFrom : rulesPeriod.yearFrom,
    yearTo: overrides.yearTo !== undefined ? overrides.yearTo : rulesPeriod.yearTo,
  };
}

type Input = { db: DatabaseSync; question: string };

/** Level 1: regex + alias table. Confident when exactly one unambiguous player is found. */
const rulesDecider: Decider<Input, Entities> = {
  level: "rules",
  name: "regex + alias",
  run: ({ db, question }) => {
    const entities = buildEntities(db, question, detectPlayerMentions(db, question));
    const n = entities.players.length;
    let confidence = n === 0 ? 0.2 : n === 1 ? 0.9 : 0.6;
    if (n === 1 && entities.players[0].otherCandidates.length) confidence -= 0.1;
    if (!entities.league) confidence -= 0.05;
    return {
      result: entities,
      confidence,
      level: "rules",
      reason:
        n === 0 ? "aucun alias connu dans la question" : `${n} joueur(s) reconnu(s) par la table d'alias`,
    };
  },
};

const LEAGUE_NAMES = LEAGUE_CUES.map((l) => l.league) as [string, ...string[]];
const LlmEntities = z.object({
  players: z
    .array(z.string())
    .describe("Player names exactly as written in the question (handles, real names, Hangul)."),
  league: z
    .enum(LEAGUE_NAMES)
    .nullable()
    .describe("Competition the question is about. Worlds / Mondiaux = World Championship. LCK = LoL Champions Korea."),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
});

/** Level 3: the LLM extracts mentions; players are still resolved against the alias table. */
const llmDecider: Decider<Input, Entities> = {
  level: "llm",
  name: "OpenRouter",
  run: async ({ db, question }) => {
    const llm = getLlm();
    if (!llm) return null;
    const { output } = await generateText({
      model: llm.model,
      output: Output.object({ schema: LlmEntities }),
      instructions:
        "Extract League of Legends esports entities from the user's question. " +
        "Do not translate or correct player names; copy them as written.",
      prompt: question,
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: AbortSignal.timeout(LLM_CALL.timeoutMs),
    });
    const entities = buildEntities(db, question, output.players, {
      league: output.league,
      yearFrom: output.yearFrom,
      yearTo: output.yearTo,
    });
    return {
      result: entities,
      confidence: entities.players.length ? 0.85 : 0.5,
      level: "llm",
      reason: `${llm.id} : ${output.players.length} mention(s) extraite(s)`,
    };
  },
};

export function understandQuestion(db: DatabaseSync, question: string) {
  return decide({ db, question }, [rulesDecider, llmDecider], { threshold: 0.8 });
}
