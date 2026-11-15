import { detectLeague, eraLeague, leagueMembers } from "../domain/leagues";
import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { normalizeAlias } from "../aliases";
import { selectAll, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { getLlm, LLM_CALL, llmSignal } from "./llm";
import { COMMON_WORDS } from "./common-words";
import { detectMetric } from "./metrics";
import { ROLE_WORDS, SHORT_ROLE_MENTION } from "./roles";
import {
  type Ambiguity,
  type Entities,
  LEAGUE_NAMES,
  type PlayerCandidate,
  type ResolvedChampion,
  type ResolvedPlayer,
  type ResolvedTeam,
  type Split,
} from "./types";


/**
 * Competitions and games outside the fixed scope. Named explicitly so the
 * agent says "not covered" instead of answering about something else.
 */
const OUT_OF_SCOPE =
  /\b(ljl|pcs|vcs|cblol|lla|tcl|lco|lcl|opl|lms|lst|lck cl? ?vietnam|valorant|vct|dota ?2?|counter[- ]strike|cs ?go|cs2|overwatch|fortnite|teamfight tactics|tft|wild rift|rocket league|fifa)\b/i;

export const SPLIT_CUES: { split: Split; pattern: RegExp }[] = [
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
    "confrontation confrontations spring summer winter printemps hiver playoffs split finale finales " +
    "game games"
  ).split(/\s+/),
);

/** "champ", "champion(s)" and their near typos ("chamion", "champoin"); read only inside a pool phrase. */
const CHAMP = "champ(?:ion|oin|ino|ian|io|on|in)?s?|champ?ions?|chapions?|chmap(?:ion)?s?|cahmp(?:ion)?s?";

/** "pool" and its near typos ("pol", "poool"); read only next to a champion word. */
const POOL_WORD = "pools?|pol|poll|poo+ls?|pooll";

/**
 * A champion pool asked in either order, with "champ" or a near typo: "champion pool", "champ pool",
 * "champs pool", "championpool", "pool champ", "pool champion", "pool de champions", "pool of champions".
 */
export const CHAMPION_POOL = `(?:${CHAMP})[- ]?(?:${POOL_WORD})|(?:${POOL_WORD})[- ](?:(?:de|d'|des|of) ?)?(?:${CHAMP})`;

/** "pool" alone: with a handle and nothing else ("pool Bin") it still asks for a champion pool. */
const BARE_POOL = /^pools?$/i;

/** Words that make a question about LoL esports even without a known entity. */
export const LOL_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${CHAMPION_POOL}|lol|league of legends|esports?|e-sports?|joueurs?|players?|[ée]quipes?|teams?|champions?|tournois?|tournaments?|` +
    `parties|games?|matchs?|splits?|playoffs|picks?|bans?|bot|kills?|pentakills?|${ROLE_WORDS})(?![\\p{L}\\p{N}])`,
  "iu",
);

/**
 * Stat and game terms. Their words are never entity aliases: in "solo kills"
 * the word "solo" is part of the term, not the player Solo. A handle used on
 * its own ("Solo aux Worlds") is still resolved.
 */
const TERM_PHRASES =
  /(?<![\p{L}\p{N}])(?:(?:solo|double|triple|quadra|penta|multi) ?kills?|first ?(?:blood|tower|dragon|baron|pick)|premier sang|kill participation|vision score|score de vision|solo ?q(?:ueue)?|(?:top|mid|bot|side) ?lanes?|(?:blue|red) side|c[ôo]t[ée] (?:bleu|rouge)|gold diff|(?:gold|cs|xp) ?diff|early game|late game|dragon soul|baron steals?|first ?(?:herald|inhib(?:itor)?)s?|turret plates?|control wards?|\d+ ?min(?:utes?)?|top ?\d+|premi(?:er|[eè]re)s? (?:dragon|drake|baron|nashor|h[ée]raut|tourelle|tour|sang)s?)(?![\p{L}\p{N}])/giu;

const phrase = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");

/** Role words are never entity aliases either: "adc" and "mid" are also player handles. */
const ROLE_PHRASES = phrase(ROLE_WORDS);

/**
 * Seasons named relative to today ("l'an dernier", "this season"), as an
 * offset in years. A LoL season is a calendar year.
 */
const RELATIVE_YEARS = [
  {
    offset: -1,
    pattern: phrase("l['’ ]?an (?:dernier|pass[ée])|(?:l['’ ]?ann[ée]e|(?:la )?saison) (?:derni[èe]re|pass[ée]e|pr[ée]c[ée]dente)|(?:last|previous) (?:year|season)"),
  },
  {
    offset: 0,
    pattern: phrase("cette (?:ann[ée]e|saison)|(?:l['’ ]?ann[ée]e|(?:la )?saison) (?:en cours|actuelle)|(?:this|current) (?:year|season)"),
  },
];

const YEAR = /\b((?:19|20)\d{2})\b/g;

const blank = (text: string, pattern: RegExp) => text.replace(pattern, (m) => " ".repeat(m.length));

/** Statistics of a game: with a handle that is an everyday word ("KDA de Life"), they make the question about esport. */
const STAT_WORDS = phrase(
  "kda|kills?|deaths?|assists?|cs|farm|golds?|d[ée]g[âa]ts|damage|wards?|dragons?|drakes?|barons?|heralds?|nashor|" +
    "tourelles?|towers?|pentakills?|quadrakills?|win ?rate|keystone|runes?",
);

/** The question with its stat, game, role and relative-season terms blanked out, for alias lookups ("last" is also a handle). */
function maskTerms(question: string): string {
  return [TERM_PHRASES, ROLE_PHRASES, ...RELATIVE_YEARS.map((r) => r.pattern)].reduce(blank, question);
}

/** True when a mention only occurs inside a stat or game term of the question. */
function onlyInTerms(question: string, mention: string): boolean {
  const m = mention.toLowerCase();

  return question.toLowerCase().includes(m) && !maskTerms(question).toLowerCase().includes(m);
}

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

/**
 * Nicknames that designate one player without doubt, by normalized alias and
 * Leaguepedia page. Only read when no alias of the database matches.
 */
const NICKNAMES = new Map([
  ["goat", "Faker"],
  ["thegoat", "Faker"],
  ["unkillabledemonking", "Faker"],
  ["demonking", "Faker"],
  ["hideonbush", "Faker"],
  ["claps", "Caps"],
]);

function lookupAlias(db: DatabaseSync, mention: string): AliasHit[] {
  const alias = normalizeAlias(mention);

  const hits = selectAll(
    db,
    AliasHit,
    `SELECT p.id, p.page AS player, a.raw, p.ign, p.real_name, p.native_name,
            (SELECT COUNT(*) FROM game_players g WHERE g.player_id = p.id) AS games
     FROM player_aliases a JOIN players p ON p.id = a.player_id
     WHERE a.alias = ?
     ORDER BY games DESC`,
    [alias],
  );

  const nickname = NICKNAMES.get(alias);

  if (hits.length || !nickname) return hits;

  return selectAll(
    db,
    AliasHit,
    `SELECT p.id, p.page AS player, ? AS raw, p.ign, p.real_name, p.native_name,
            (SELECT COUNT(*) FROM game_players g WHERE g.player_id = p.id) AS games
     FROM players p WHERE p.page = ?`,
    [mention, nickname],
  );
}

type Context = { league: string | null; yearFrom: number | null; yearTo: number | null };

function contextGames(db: DatabaseSync, playerId: number, ctx: Context): number {
  const members = ctx.league ? leagueMembers(ctx.league, ctx.yearFrom, ctx.yearTo) : [];

  const row = selectOne(
    db,
    CountRow,
    `SELECT COUNT(*) AS n FROM game_players gp
     JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
     JOIN leagues l ON l.id = t.league_id
     WHERE gp.player_id = :id AND t.stage <> 'qualifier'
       AND (:league IS NULL OR l.name IN (SELECT value FROM json_each(:members)))
       AND (:yearFrom IS NULL OR t.year >= :yearFrom)
       AND (:yearTo IS NULL OR t.year <= :yearTo)`,
    { id: playerId, members: JSON.stringify(members), league: ctx.league, yearFrom: ctx.yearFrom, yearTo: ctx.yearTo },
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
  { team: "Gen.G", members: ["Gen.G", "Samsung Galaxy"], aliases: ["gen.g", "geng", "gen g", "gen", "ssg", "samsung galaxy"] },
  {
    team: "Movistar KOI",
    members: ["MAD Lions", "MAD Lions KOI", "Movistar KOI"],
    aliases: ["mkoi", "koi", "mdk", "mad", "mad lions", "madlions", "mad lions koi", "movistar koi"],
  },
  { team: "GIANTX", members: ["Excel Esports", "GIANTX"], aliases: ["gx", "giantx", "excel", "xl", "excel esports"] },
  {
    team: "DRX",
    members: ["Longzhu Gaming", "Kingzone DragonX", "DragonX", "DRX", "Kiwoom DRX"],
    aliases: ["drx", "kingzone", "kz", "kingzone dragonx", "dragonx", "longzhu", "kiwoom drx"],
  },
  {
    team: "DN SOOPers",
    members: ["Afreeca Freecs", "Kwangdong Freecs", "DN Freecs", "DN SOOPers"],
    aliases: ["dns", "dn soopers", "soopers", "dnf", "dn freecs", "kdf", "kwangdong", "kwangdong freecs", "afreeca", "afreeca freecs", "afs"],
  },
  {
    team: "HANJIN BRION",
    members: ["Fredit BRION", "BRION", "OKSavingsBank BRION", "HANJIN BRION"],
    aliases: ["bro", "brion", "fredit brion", "oksavingsbank brion", "hanjin brion"],
  },
  // MVP Ozone became Samsung Galaxy Ozone, renamed Samsung Galaxy White in 2014; its sister team was Samsung Galaxy Blue.
  {
    team: "Samsung White",
    members: ["MVP Ozone", "Samsung Ozone", "Samsung White"],
    aliases: ["ssw", "samsung white", "samsung galaxy white", "ssg white", "samsung ozone", "samsung galaxy ozone", "sso", "mvp ozone"],
  },
  { team: "Samsung Blue", members: ["MVP Blue", "Samsung Blue"], aliases: ["ssb", "samsung blue", "samsung galaxy blue", "ssg blue", "mvp blue"] },
  { team: "Nongshim RedForce", members: ["Team Dynamics", "Nongshim RedForce"], aliases: ["ns", "nongshim", "redforce", "team dynamics"] },
];

const TEAM_SHORTHANDS = {
  hle: "Hanwha Life Esports",
  hanwha: "Hanwha Life Esports",
  kt: "KT Rolster",
  g2: "G2 Esports",
  fnc: "Fnatic",
  sk: "SK Gaming",
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
  "nunu et willump": "Nunu & Willump",
  "nunu and willump": "Nunu & Willump",
  willump: "Nunu & Willump",
  jarvan: "Jarvan IV",
  cho: "Cho'Gath",
  kog: "Kog'Maw",
  kha: "Kha'Zix",
  vel: "Vel'Koz",
  rek: "Rek'Sai",
  aurelion: "Aurelion Sol",
  naut: "Nautilus",
  kass: "Kassadin",
  morde: "Mordekaiser",
  tahm: "Tahm Kench",
  heca: "Hecarim",
  blitz: "Blitzcrank",
  yi: "Master Yi",
  ez: "Ezreal",
  gp: "Gangplank",
  tk: "Tahm Kench",
  lb: "LeBlanc",
  mundo: "Dr. Mundo",
  kaisa: "Kai'Sa",
  renata: "Renata Glasc",
  xin: "Xin Zhao",
};

const ROLE_NAMES = new Set(["top", "jungle", "mid", "bot", "support", "adc"]);

type TeamIndex = Map<string, ResolvedTeam & { games: number; curated: boolean }>;

type Indexes = { teams: TeamIndex; champions: Map<string, string> };

const indexes = new WeakMap<DatabaseSync, Indexes>();

function getIndexes(db: DatabaseSync): Indexes {
  const cached = indexes.get(db);

  if (cached) return cached;

  const rows = selectAll(
    db,
    z.object({ name: z.string(), games: z.number() }),
    `SELECT t.name, x.games FROM (
       SELECT team_id, COUNT(*) AS games FROM (
         SELECT blue_team_id AS team_id FROM games
         UNION ALL SELECT red_team_id FROM games WHERE red_team_id != blue_team_id
       ) GROUP BY team_id
     ) x JOIN teams t ON t.id = x.team_id ORDER BY x.games DESC, t.name`,
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

    // "Top Esports" is not "top": a bare role word names the role (TES and Top Esports still name the team).
    if (normalizeAlias(short).length >= 3 && !ROLE_NAMES.has(normalizeAlias(short))) add(short, team, false);
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

/** A handle that is an everyday word, or three Latin characters or fewer. */
function isCommonHandle(mention: string): boolean {
  const alias = normalizeAlias(mention);

  return /^[a-z0-9]{1,3}$/.test(alias) || COMMON_WORDS.has(alias);
}

type Mentions = { players: string[]; teams: ResolvedTeam[]; champion: ResolvedChampion | null };

/**
 * Rule-based detection: longest n-gram that matches a known champion, team or
 * player alias, outside stat and game terms. On the same words a champion wins over a player ("Ahri"), and
 * a team wins over a player when it is a known shorthand or has more games.
 */
function detectMentions(db: DatabaseSync, question: string): Mentions {
  const tokens = maskTerms(question)
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

  // A handle that is also an everyday word ("Paris", "Life") or very short
  // ("Bin") names a player in a question about esport, or when the question
  // says nothing else ("résultats de Knight"): not in "la météo à Paris".
  if (found.players.some(isCommonHandle)) {
    const esport =
      found.teams.length > 0 ||
      found.champion != null ||
      found.players.some((m) => !isCommonHandle(m)) ||
      detectLeague(question).league != null ||
      [TERM_PHRASES, ROLE_PHRASES, STAT_WORDS].some((p) => blank(question, p) !== question) ||
      detectMetric(question) != null ||
      LOL_DOMAIN.test(question);

    const alone = tokens.every((t, i) => used.has(i) || STOPWORDS.has(t.toLowerCase()) || /^\d+$/.test(t) || BARE_POOL.test(t));

    if (!esport && !alone) found.players = found.players.filter((m) => !isCommonHandle(m));
  }

  // Next to a team, "top", "sup" or "jg" name its player at that role ("top fpx 2019"), not the handle Top or Sup.
  if (found.teams.length) found.players = found.players.filter((m) => !SHORT_ROLE_MENTION.test(m));

  // Keep the order of the question (it decides sides in a head-to-head).
  const pos = (m: string) => question.indexOf(m);
  found.players.sort((a, b) => pos(a) - pos(b));
  found.teams.sort((a, b) => pos(a.mention) - pos(b.mention));

  return found;
}

// Competition and period ----------------------------------------------------------


/** "l'an dernier", "cette saison": the years they mean today, and whether one follows "depuis" / "since". */
function relativeYears(question: string, now: Date) {
  return RELATIVE_YEARS.flatMap((r) => {
    const m = new RegExp(r.pattern.source, "iu").exec(question);

    return m ? [{ year: now.getUTCFullYear() + r.offset, since: /(?:depuis|since)\s+$/i.test(question.slice(0, m.index)) }] : [];
  });
}

function detectPeriod(question: string, now: Date) {
  const relative = relativeYears(question, now);
  const years = [...[...question.matchAll(YEAR)].map((m) => Number(m[1])), ...relative.map((r) => r.year)];

  if (years.length === 0) return { yearFrom: null, yearTo: null };

  if (years.length === 1 && relative.length === 1) return { yearFrom: years[0], yearTo: relative[0].since ? null : years[0] };
  const year = "\\s+((?:19|20)\\d{2})\\b";
  // "depuis 2016" and "jusqu'en 2020" include the year named; "après 2016" and "avant 2020" do not.
  const since = new RegExp(`\\b(?:depuis|since|from)${year}`, "i").exec(question);
  const after = new RegExp(`\\b(?:apr[eè]s|after)${year}`, "i").exec(question);
  const until = new RegExp(`\\b(?:until|jusqu'?en)${year}`, "i").exec(question);
  const before = new RegExp(`\\b(?:avant|before)${year}`, "i").exec(question);

  if (years.length === 1) {
    if (since) return { yearFrom: Number(since[1]), yearTo: null };

    if (after) return { yearFrom: Number(after[1]) + 1, yearTo: null };

    if (until) return { yearFrom: null, yearTo: Number(until[1]) };

    if (before) return { yearFrom: null, yearTo: Number(before[1]) - 1 };
  }

  return { yearFrom: Math.min(...years), yearTo: Math.max(...years) };
}


function leagueShort(db: DatabaseSync, league: string | null): string | null {
  if (!league) return null;

  return selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league])?.short_name ?? null;
}

function buildEntities(
  db: DatabaseSync,
  question: string,
  now: Date,
  mentions: Mentions,
  overrides: Partial<Pick<Entities, "league" | "yearFrom" | "yearTo">> = {},
): Entities {
  const rulesLeague = detectLeague(question);
  const rulesPeriod = detectPeriod(question, now);
  // A period the rules read (written years, or a relative season resolved against `now`) is kept: the LLM does not know today's date.
  const dated = rulesPeriod.yearFrom != null || rulesPeriod.yearTo != null;
  const yearFrom = overrides.yearFrom !== undefined && !dated ? overrides.yearFrom : rulesPeriod.yearFrom;
  const yearTo = overrides.yearTo !== undefined && !dated ? overrides.yearTo : rulesPeriod.yearTo;
  const league = eraLeague(overrides.league !== undefined ? overrides.league : rulesLeague.league, yearFrom, yearTo);
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

type Input = { db: DatabaseSync; question: string; now: Date };

/** Level 1: regex + alias tables. Confident when every entity is found without doubt. */
const rulesDecider: Decider<Input, Entities> = {
  level: "rules",
  name: "regex + alias",
  run: ({ db, question, now }) => {
    const entities = buildEntities(db, question, now, detectMentions(db, question));
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
  run: async ({ db, question, now }) => {
    const llm = getLlm();

    if (!llm) return null;

    const { output } = await generateText({
      model: llm.model,
      output: Output.object({ schema: LlmEntities }),
      instructions:
        "Extract League of Legends esports entities from the user's question. " +
        "Do not translate or correct player or team names; copy them as written.",
      prompt: question,
      telemetry: { functionId: "extract-entities" },
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: llmSignal(LLM_CALL.timeoutMs),
    });

    const teams = output.teams.map((t) => resolveTeam(db, t)).filter((t): t is ResolvedTeam => t != null);

    const entities = buildEntities(
      db,
      question,
      now,
      // The LLM may still copy a term's word as a name ("solo" in "solo kills").
      { players: output.players.filter((p) => !onlyInTerms(question, p)), teams, champion: output.champion ? resolveChampion(db, output.champion) : null },
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

/** `now` dates the relative seasons of the question ("l'an dernier"); tests pass a fixed date. */
export function understandQuestion(db: DatabaseSync, question: string, now: Date = new Date()) {
  return decide({ db, question, now }, [rulesDecider, llmDecider], { threshold: 0.8 });
}

/**
 * What the understand step read in the question, blanked out: entity
 * mentions, the competition, years and relative seasons. `read` counts
 * them, one per mention.
 */
export function maskUnderstood(question: string, e: Entities) {
  let read = 0;
  let rest = question;

  const take = (pattern: RegExp) => {
    rest = rest.replace(pattern, (m) => {
      read++;

      return " ".repeat(m.length);
    });
  };

  const mentions = [...e.players.map((p) => p.mention), ...e.teams.map((t) => t.mention), e.champion?.mention, e.leagueMention];

  // Mentions are rebuilt from tokens: "Kai Sa" was written "Kai'Sa". Whole words only: "TL" is not the one in "botlaner".
  for (const m of mentions)
    if (m) take(new RegExp(`(?<![\\p{L}\\p{N}])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s'’]+")}(?![\\p{L}\\p{N}])`, "iu"));

  if (e.yearFrom != null || e.yearTo != null) for (const p of [YEAR, ...RELATIVE_YEARS.map((r) => r.pattern)]) take(p);

  return { rest, read };
}
