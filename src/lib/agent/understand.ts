import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { normalizeAlias } from "../aliases";
import { selectAll, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { getLlm, LLM_CALL } from "./llm";
import {
  type Ambiguity,
  type Entities,
  LEAGUE_NAMES,
  type LeagueName,
  type PlayerCandidate,
  type ResolvedChampion,
  type ResolvedPlayer,
  type ResolvedTeam,
  type Split,
} from "./types";

/** Cues for the Leaguepedia `League` values of the scope (leagues.name). */
const LEAGUE_CUES: { league: LeagueName; pattern: RegExp }[] = [
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

/**
 * Competitions and games outside the fixed scope. Named explicitly so the
 * agent says "not covered" instead of answering about something else.
 */
const OUT_OF_SCOPE =
  /\b(ljl|pcs|vcs|cblol|lla|tcl|lco|lcl|opl|lms|lst|lck cl? ?vietnam|valorant|vct|dota ?2?|counter[- ]strike|cs ?go|cs2|overwatch|fortnite|teamfight tactics|tft|wild rift|rocket league|fifa)\b/i;

const SPLIT_CUES: { split: Split; pattern: RegExp }[] = [
  { split: "Spring", pattern: /\b(spring|printemps)\b/i },
  { split: "Summer", pattern: /\bsummer\b|\b(?:split|saison) d['’ ]?[ée]t[ée](?![\p{L}])/iu },
  { split: "Winter", pattern: /\b(winter|hiver)\b/i },
];

const STOPWORDS = new Set(
  (
    "a à au aux de des du d le la les l un une et ou en dans sur pour par avec contre vs versus face " +
    "tous toutes tout toute ses son sa leurs leur quel quels quelle quelles qui quoi " +
    "resultat resultats résultat résultats bilan stats statistiques champions " +
    "champion joue joués jouer depuis entre avant apres après annee annees année " +
    "années saison saisons edition editions édition éditions the of at in on all " +
    "results result record by for with from to and stats year years every each " +
    "worlds world championship mondiaux mondial msi lck lpl lec lcs lfl lta show me give " +
    "what which how montre donne est sont été team équipe equipe historique history " +
    "palmarès palmares classement standings vainqueur vainqueurs gagné gagne won who " +
    "pick picks ban bans présence presence winrate taux victoire victoires défaites " +
    "confrontation confrontations spring summer winter printemps hiver playoffs split finale finales"
  ).split(/\s+/),
);

// Players -----------------------------------------------------------------------

const AliasHit = z.object({
  id: z.number(),
  player: z.string(),
  raw: z.string(),
  ign: z.string().nullable(),
  real_name: z.string().nullable(),
  native_name: z.string().nullable(),
  games: z.number(),
});

type AliasHit = z.infer<typeof AliasHit>;

const CountRow = z.object({ n: z.number() });

function lookupAlias(db: DatabaseSync, mention: string): AliasHit[] {
  return selectAll(
    db,
    AliasHit,
    `SELECT p.id, p.page AS player, a.raw, p.ign, p.real_name, p.native_name,
            (SELECT COUNT(*) FROM game_players g WHERE g.player_id = p.id) AS games
     FROM player_aliases a JOIN players p ON p.id = a.player_id
     WHERE a.alias = ?
     ORDER BY games DESC`,
    [normalizeAlias(mention)],
  );
}

type Context = { league: string | null; yearFrom: number | null; yearTo: number | null };

function contextGames(db: DatabaseSync, playerId: number, ctx: Context): number {
  const row = selectOne(
    db,
    CountRow,
    `SELECT COUNT(*) AS n FROM game_players gp
     JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
     JOIN leagues l ON l.id = t.league_id
     WHERE gp.player_id = :id AND t.stage <> 'qualifier'
       AND (:league IS NULL OR l.name = :league)
       AND (:yearFrom IS NULL OR t.year >= :yearFrom)
       AND (:yearTo IS NULL OR t.year <= :yearTo)`,
    { id: playerId, league: ctx.league, yearFrom: ctx.yearFrom, yearTo: ctx.yearTo },
  );

  return row?.n ?? 0;
}

/** Games ratio above which the most played homonym is a safe pick. */
const CLEAR_MARGIN = 3;

/**
 * Picks the most likely player behind an alias, in order: exact case of the
 * handle ("caPs" vs "Caps") if that player played in the context, games in
 * the competition / period of the question, then total games. Never silent: the ambiguity is returned so the
 * answer can say who was picked and offer the others.
 */
export function resolvePlayer(db: DatabaseSync, mention: string, ctx: Context = { league: null, yearFrom: null, yearTo: null }): ResolvedPlayer | null {
  const hits = lookupAlias(db, mention);

  if (hits.length === 0) return null;
  const byPlayer = [...new Map(hits.map((h) => [h.player, h])).values()];
  const hasContext = ctx.league != null || ctx.yearFrom != null || ctx.yearTo != null;

  const candidates: (PlayerCandidate & { hit: AliasHit })[] = byPlayer.map((h) => ({
    player: h.player,
    games: h.games,
    contextGames: byPlayer.length > 1 && hasContext ? contextGames(db, h.id, ctx) : h.games,
    exactCase: h.player === mention || h.ign === mention || (h.raw === mention && h.raw !== h.raw.toLowerCase()),
    hit: h,
  }));

  let ambiguity: Ambiguity | null = null;

  if (candidates.length > 1) {
    const exact = candidates.filter((c) => c.exactCase);
    let chosenBy: Ambiguity["chosenBy"];
    let uncertain = false;
    let reason: string;
    const rank = (a: PlayerCandidate, b: PlayerCandidate) => b.contextGames - a.contextGames || b.games - a.games;

    // Exact case wins, unless that player never played in the context of the question.
    if (exact.length === 1 && (!hasContext || exact[0].contextGames > 0)) {
      candidates.sort((a, b) => Number(b.exactCase) - Number(a.exactCase) || rank(a, b));
      chosenBy = "case";
      reason = `casse exacte « ${mention} »`;
    } else {
      candidates.sort(rank);
      const [top, second] = candidates;

      if (hasContext && top.contextGames > 0 && second.contextGames === 0) {
        chosenBy = "context";
        reason = `seul à avoir joué dans le contexte de la question (${top.contextGames} parties)`;
      } else if (hasContext && top.contextGames > 0) {
        chosenBy = "context";
        uncertain = top.contextGames < CLEAR_MARGIN * second.contextGames;
        reason = `plus de parties dans le contexte de la question (${top.contextGames} contre ${second.contextGames})`;
      } else {
        candidates.sort((a, b) => b.games - a.games);
        const [most, next] = candidates;
        chosenBy = "games";
        uncertain = most.games < CLEAR_MARGIN * next.games;
        reason = `plus de parties au total (${most.games} contre ${next.games})`;
      }
    }

    ambiguity = {
      candidates: candidates.map((c) => ({ player: c.player, games: c.games, contextGames: c.contextGames, exactCase: c.exactCase })),
      chosenBy,
      uncertain,
      reason,
    };
  }

  const best = candidates[0].hit;

  return {
    mention,
    player: best.player,
    matchedAlias: best.raw,
    realName: best.real_name,
    nativeName: best.native_name,
    otherCandidates: candidates.slice(1).map((c) => c.player),
    ambiguity,
  };
}

// Teams and champions -----------------------------------------------------------

/** Renamed teams grouped under their current name, with common shorthands. */
const FRANCHISES: { team: string; members: string[]; aliases: string[] }[] = [
  { team: "T1", members: ["T1", "SK Telecom T1"], aliases: ["t1", "skt", "skt t1", "sk telecom", "sk telecom t1"] },
  {
    team: "Dplus KIA",
    members: ["DAMWON Gaming", "DWG KIA", "Dplus KIA", "Dplus Kia"],
    aliases: ["dk", "dwg", "damwon", "dwg kia", "dplus", "dplus kia"],
  },
  { team: "Gen.G", members: ["Gen.G", "Samsung Galaxy"], aliases: ["gen.g", "geng", "gen g", "ssg", "samsung galaxy"] },
];

const TEAM_SHORTHANDS = {
  hle: "Hanwha Life Esports",
  hanwha: "Hanwha Life Esports",
  kt: "KT Rolster",
  g2: "G2 Esports",
  fnc: "Fnatic",
  tl: "Team Liquid",
  c9: "Cloud9",
  edg: "EDward Gaming",
  rng: "Royal Never Give Up",
  ig: "Invictus Gaming",
  jdg: "JD Gaming",
  blg: "Bilibili Gaming",
  tes: "Top Esports",
  fpx: "FunPlus Phoenix",
  lng: "LNG Esports",
  wbg: "Weibo Gaming",
  al: "Anyone's Legend",
  kc: "Karmine Corp",
  vit: "Team Vitality",
  "100t": "100 Thieves",
  tsm: "TSM",
  clg: "Counter Logic Gaming",
  drx: "DRX",
  ns: "Nongshim RedForce",
  kdf: "Kwangdong Freecs",
  bro: "OKSavingsBank BRION",
  mdk: "Movistar KOI",
  bds: "Team BDS",
  th: "Team Heretics",
};

const CHAMPION_SHORTHANDS = {
  tf: "Twisted Fate",
  mf: "Miss Fortune",
  lee: "Lee Sin",
  j4: "Jarvan IV",
  asol: "Aurelion Sol",
  monkeyking: "Wukong",
  nunu: "Nunu & Willump",
  mundo: "Dr. Mundo",
  kaisa: "Kai'Sa",
  renata: "Renata Glasc",
  xin: "Xin Zhao",
};

type TeamIndex = Map<string, ResolvedTeam & { games: number; curated: boolean }>;

type Indexes = { teams: TeamIndex; champions: Map<string, string> };

const indexes = new WeakMap<DatabaseSync, Indexes>();

function getIndexes(db: DatabaseSync): Indexes {
  const cached = indexes.get(db);

  if (cached) return cached;

  const rows = selectAll(
    db,
    z.object({ name: z.string(), games: z.number() }),
    `SELECT t.name, COUNT(g.id) AS games FROM teams t
     JOIN games g ON t.id IN (g.blue_team_id, g.red_team_id) GROUP BY t.id ORDER BY games DESC`,
  );

  const gamesOf = new Map(rows.map((r) => [r.name, r.games]));
  const teams: TeamIndex = new Map();

  const add = (alias: string, team: ResolvedTeam, curated: boolean) => {
    const key = normalizeAlias(alias);

    if (key.length < 2 || STOPWORDS.has(key)) return;
    const games = team.members.reduce((n, m) => n + (gamesOf.get(m) ?? 0), 0);
    const prev = teams.get(key);

    if (!prev || (curated && !prev.curated) || (curated === prev.curated && games > prev.games))
      teams.set(key, { ...team, games, curated });
  };

  for (const { name } of rows) {
    const team = { mention: "", team: name, members: [name] };
    add(name, team, false);

    const short = name
      .replace(/\s*\(.*?\)\s*$/, "")
      .replace(/^Team\s+/i, "")
      .replace(/\s+(Esports|e-Sports|Gaming|Esport)$/i, "");

    if (normalizeAlias(short).length >= 3) add(short, team, false);
  }

  for (const [alias, name] of Object.entries(TEAM_SHORTHANDS))
    if (gamesOf.has(name)) add(alias, { mention: "", team: name, members: [name] }, true);

  for (const f of FRANCHISES) {
    const team = { mention: "", team: f.team, members: f.members.filter((m) => gamesOf.has(m)) };

    for (const a of [...f.aliases, ...f.members]) add(a, team, true);
  }

  const champions = new Map<string, string>();

  for (const { name } of selectAll(db, z.object({ name: z.string() }), "SELECT name FROM champions"))
    if (!name.includes("&amp;")) champions.set(normalizeAlias(name), name);

  for (const [alias, name] of Object.entries(CHAMPION_SHORTHANDS))
    if ([...champions.values()].includes(name)) champions.set(normalizeAlias(alias), name);

  const result = { teams, champions };
  indexes.set(db, result);

  return result;
}

export function resolveTeam(db: DatabaseSync, mention: string): ResolvedTeam | null {
  const hit = getIndexes(db).teams.get(normalizeAlias(mention));

  return hit ? { mention, team: hit.team, members: hit.members } : null;
}

export function resolveChampion(db: DatabaseSync, mention: string): ResolvedChampion | null {
  const name = getIndexes(db).champions.get(normalizeAlias(mention));

  return name ? { mention, champion: name } : null;
}

// Mentions ----------------------------------------------------------------------

type Mentions = { players: string[]; teams: ResolvedTeam[]; champion: ResolvedChampion | null };

/**
 * Rule-based detection: longest n-gram that matches a known champion, team or
 * player alias. On the same words a champion wins over a player ("Ahri"), and
 * a team wins over a player when it is a known shorthand or has more games.
 */
function detectMentions(db: DatabaseSync, question: string): Mentions {
  const tokens = question
    .replace(/[’']/g, " ")
    .split(/[^\p{L}\p{N}.\-&]+/u)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);

  const found: Mentions = { players: [], teams: [], champion: null };
  const used = new Set<number>();
  const { teams } = getIndexes(db);

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

      if (norm.length < 2) continue;

      const champion = norm.length >= 3 || mention === "Vi" ? resolveChampion(db, mention) : null;

      if (champion && !found.champion) {
        found.champion = champion;
        span.forEach((k) => used.add(k));
        continue;
      }

      const team = teams.get(norm);
      const players = norm.length >= (isHangulOrHan ? 2 : 3) ? lookupAlias(db, mention) : [];

      if (team && (team.curated || !players.length || team.games >= players[0].games)) {
        if (!found.teams.some((t) => t.team === team.team))
          found.teams.push({ mention, team: team.team, members: team.members });
        span.forEach((k) => used.add(k));
        continue;
      }

      if (players.length) {
        found.players.push(mention);
        span.forEach((k) => used.add(k));
      }
    }
  }

  // Keep the order of the question (it decides sides in a head-to-head).
  const pos = (m: string) => question.indexOf(m);
  found.players.sort((a, b) => pos(a) - pos(b));
  found.teams.sort((a, b) => pos(a.mention) - pos(b.mention));

  return found;
}

// Competition and period ----------------------------------------------------------

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

/**
 * The same name covers different leagues over time: "LCS 2016" is NA LCS,
 * "LEC 2017" is EU LCS, "LCK 2014" is OGN Champions.
 */
function eraLeague(league: LeagueName | null, yearTo: number | null): LeagueName | null {
  if (league == null || yearTo == null) return league;

  if (league === "League of Legends Championship Series" && yearTo <= 2018) return "North America League Championship Series";

  if (league === "LoL EMEA Championship" && yearTo <= 2018) return "Europe League Championship Series";

  if (league === "LoL Champions Korea" && yearTo <= 2015) return "LoL The Champions";

  return league;
}

function leagueShort(db: DatabaseSync, league: string | null): string | null {
  if (!league) return null;

  return selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league])?.short_name ?? null;
}

function buildEntities(
  db: DatabaseSync,
  question: string,
  mentions: Mentions,
  overrides: Partial<Pick<Entities, "league" | "yearFrom" | "yearTo">> = {},
): Entities {
  const rulesLeague = detectLeague(question);
  const rulesPeriod = detectPeriod(question);
  const yearFrom = overrides.yearFrom !== undefined ? overrides.yearFrom : rulesPeriod.yearFrom;
  const yearTo = overrides.yearTo !== undefined ? overrides.yearTo : rulesPeriod.yearTo;
  const league = eraLeague(overrides.league !== undefined ? overrides.league : rulesLeague.league, yearTo);
  const players: ResolvedPlayer[] = [];
  const unresolved: string[] = [];

  for (const m of mentions.players) {
    const p = resolvePlayer(db, m, { league, yearFrom, yearTo });

    if (p && !players.some((x) => x.player === p.player)) players.push(p);
    else if (!p) unresolved.push(m);
  }

  const outOfScope = OUT_OF_SCOPE.exec(question)?.[0] ?? null;

  return {
    players,
    teams: mentions.teams,
    champion: mentions.champion,
    unresolved,
    league,
    leagueShort: leagueShort(db, league),
    leagueMention: rulesLeague.mention,
    yearFrom,
    yearTo,
    split: SPLIT_CUES.find((s) => s.pattern.test(question))?.split ?? null,
    outOfScope,
  };
}

type Input = { db: DatabaseSync; question: string };

/** Level 1: regex + alias tables. Confident when every entity is found without doubt. */
const rulesDecider: Decider<Input, Entities> = {
  level: "rules",
  name: "regex + alias",
  run: ({ db, question }) => {
    const entities = buildEntities(db, question, detectMentions(db, question));
    const n = entities.players.length + entities.teams.length + (entities.champion ? 1 : 0);
    let confidence = entities.outOfScope ? 0.9 : n === 0 ? (entities.league ? 0.8 : 0.2) : n <= 2 ? 0.9 : 0.6;

    if (entities.players.some((p) => p.ambiguity?.uncertain)) confidence -= 0.1;

    if (entities.unresolved.length) confidence -= 0.1;

    return {
      result: entities,
      confidence,
      level: "rules",
      reason: entities.outOfScope
        ? `hors périmètre : « ${entities.outOfScope} »`
        : n === 0
          ? "aucun joueur, équipe ou champion connu dans la question"
          : `${n} entité(s) reconnue(s) par les tables d'alias`,
    };
  },
};


const LlmEntities = z.object({
  players: z
    .array(z.string())
    .describe("Player names exactly as written in the question (handles, real names, Hangul)."),
  teams: z.array(z.string()).describe("Team names exactly as written (T1, Gen.G, G2...)."),
  champion: z.string().nullable().describe("League of Legends champion named in the question, if any."),
  league: z
    .enum(LEAGUE_NAMES)
    .nullable()
    .describe("Competition the question is about. Worlds / Mondiaux = World Championship. LCK = LoL Champions Korea."),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
});

/** Level 3: the LLM extracts mentions; they are still resolved against the alias tables. */
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
        "Do not translate or correct player or team names; copy them as written.",
      prompt: question,
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: AbortSignal.timeout(LLM_CALL.timeoutMs),
    });

    const teams = output.teams.map((t) => resolveTeam(db, t)).filter((t): t is ResolvedTeam => t != null);

    const entities = buildEntities(
      db,
      question,
      { players: output.players, teams, champion: output.champion ? resolveChampion(db, output.champion) : null },
      { league: output.league, yearFrom: output.yearFrom, yearTo: output.yearTo },
    );

    const n = entities.players.length + entities.teams.length + (entities.champion ? 1 : 0);

    return {
      result: entities,
      confidence: n ? 0.85 : 0.5,
      level: "llm",
      reason: `${llm.id} : ${output.players.length + output.teams.length} mention(s) extraite(s)`,
    };
  },
};

export function understandQuestion(db: DatabaseSync, question: string) {
  return decide({ db, question }, [rulesDecider, llmDecider], { threshold: 0.8 });
}
