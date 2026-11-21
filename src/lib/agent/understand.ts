import { displayTeam } from "../domain/teams";
import { detectLeague, eraLeague, LEAGUES, leagueMembers } from "../domain/leagues";
import { generateText, Output } from "ai";
import { z } from "zod";
import { normalizeAlias } from "../aliases";
import { cachedRead, type Db, selectAll, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { getLlm, LLM_CALL, llmSignal } from "./llm";
import { msg } from "./messages";
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
  /\b(lla|tcl|lco|lcl|opl|lms|lst|lck cl? ?vietnam|valorant|vct|dota ?2?|counter[- ]strike|cs ?go|cs2|overwatch|fortnite|teamfight tactics|tft|wild rift|rocket league|fifa)\b/i;

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
    `parties|games?|matchs?|splits?|playoffs|picks?|bans?|bot|kills?|pentakills?|kda|assists?|d[ée]g[âa]ts|${ROLE_WORDS})(?![\\p{L}\\p{N}])`,
  "iu",
);

/**
 * Stat and game terms. Their words are never entity aliases: in "solo kills"
 * the word "solo" is part of the term, not the player Solo. A handle used on
 * its own ("Solo aux Worlds") is still resolved.
 */
const TERM_PHRASES =
  /(?<![\p{L}\p{N}])(?:(?:solo|double|triple|quadra|penta|multi) ?kills?|first ?(?:blood|tower|dragon|baron|pick)|premier sang|kill participation|vision score|score de vision|solo ?q(?:ueue)?|(?:top|mid|bot|side) ?lanes?|(?:blue|red) side|c[ôo]t[ée] (?:bleu|rouge)|parts? (?:des? |aux |de l['’]|d['’])(?:d[ée]g[âa]ts|or|golds?)|(?:damage|dmg|gold) share|(?:(?:pires?|worst) )?match[- ]?ups?|formes? r[ée]centes?|last \d* ?(?:games?|matches)|en ce moment|ces derniers temps|derni[èe]re?s? (?:\d+ )?(?:parties?|games?|matchs?)|(?:gold|cs|xp) ?diff(?:erence)?s?|early game|late game|dragon souls?|[âa]mes? (?:du|de|des) (?:dragons?|drakes?)|premiers? (?:dragons?|drakes?)|types? de (?:dragons?|drakes?)|[ée]l[ée]ments? (?:du|de|des) (?:dragons?|drakes?)|(?:dragons?|drakes?) (?:ancestra(?:l|ux)|[ée]l[ée]mentaires?|infernal|infernaux|des oc[ée]ans|des montagnes|des nuages|hextech|chemtech)|(?:elder|infernal|ocean|mountain|cloud|hextech|chemtech) (?:dragons?|drakes?)|baron steals?|first ?(?:herald|inhib(?:itor)?)s?|turret plates?|control wards?|\d+ ?min(?:utes?)?|top ?\d+|premi(?:er|[eè]re)s? (?:dragon|drake|baron|nashor|h[ée]raut|tourelle|tour|sang)s?)(?![\p{L}\p{N}])/giu;

const phrase = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");

/** Role words are never entity aliases either: "adc" and "mid" are also player handles. */
const ROLE_PHRASES = phrase(ROLE_WORDS);

/**
 * A superlative right before what it ranks is never a handle either: "pires
 * champions" is not the player Pires; "Worst aux Worlds" still is the player.
 */
const SUPERLATIVE_PHRASES = phrase(
  "(?:pires?|worst)(?= (?:champions?|joueurs?|joueuses?|players?|[ée]quipes?|teams?|picks?|bans?|games?|parties?|matchs?|matches|" +
    "s[ée]ries?|winrates?|kda|tops?|junglers?|mids?|adcs?|bots?|supports?|toplaners?|midlaners?|botlaners?)(?![\\p{L}\\p{N}]))",
);

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
  return [SUPERLATIVE_PHRASES, TERM_PHRASES, ROLE_PHRASES, ...RELATIVE_YEARS.map((r) => r.pattern)].reduce(blank, question);
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

const ALIAS_HIT = `p.id, p.page AS player, p.ign, p.real_name, p.native_name,
       (SELECT COUNT(*) FROM game_players g WHERE g.player_id = p.id) AS games`;

/**
 * The players behind each mention, in one query for every mention of a question: each alias, or the page of a
 * nickname for a mention no alias matches. Most played first.
 */
async function lookupAliases(db: Db, mentions: string[]): Promise<Map<string, AliasHit[]>> {
  const found = new Map<string, AliasHit[]>(mentions.map((m) => [m, []]));
  const aliases = [...new Set(mentions.map(normalizeAlias))];
  const nicknames = [...new Set(aliases.flatMap((a) => NICKNAMES.get(a) ?? []))];

  if (!aliases.length) return found;
  const params: Record<string, string> = {};
  const marks = (prefix: string, values: string[]) => values.map((v, i) => ((params[`${prefix}${i}`] = v), `:${prefix}${i}`)).join(", ");

  const rows = await selectAll(
    db,
    AliasHit.extend({ alias: z.string().nullable(), page: z.string() }),
    `SELECT a.alias, p.page, a.raw, ${ALIAS_HIT}
     FROM player_aliases a JOIN players p ON p.id = a.player_id
     WHERE a.alias IN (${marks("a", aliases)})
     ${nicknames.length ? `UNION ALL SELECT NULL AS alias, p.page, p.page AS raw, ${ALIAS_HIT} FROM players p WHERE p.page IN (${marks("n", nicknames)})` : ""}
     ORDER BY games DESC, id`,
    params,
  );

  const byAlias = Map.groupBy(rows.filter((r) => r.alias != null), (r) => r.alias!);
  const byPage = new Map(rows.filter((r) => r.alias == null).map((r) => [r.page, r]));
  const hit = ({ alias: _alias, page: _page, ...h }: (typeof rows)[number]): AliasHit => h;

  for (const mention of mentions) {
    const alias = normalizeAlias(mention);
    const hits = (byAlias.get(alias) ?? []).map(hit);
    const nickname = NICKNAMES.get(alias);
    const page = nickname ? byPage.get(nickname) : undefined;

    // A nickname names its player only when no alias of the database matches.
    found.set(mention, hits.length || !page ? hits : [{ ...hit(page), raw: mention }]);
  }

  return found;
}

/** Up to three words, then a parenthesis: how a Leaguepedia page tells homonyms apart ("Knight (Zhuo Ding)"). */
const PAGE_MENTION = /(?<![\p{L}\p{N}])((?:[\p{L}\p{N}][\p{L}\p{N}.\-&]* ){1,3})\(([^()]{2,60})\)/gu;

/**
 * The players a question writes by their page, as the answers name a homonym or a teammate: that page exactly, never a
 * homonym. The longest page wins ("Hide on bush (…)" before "bush (…)"); where each one starts in the question.
 */
async function pageMentions(db: Db, question: string): Promise<{ page: string; index: number; hit: AliasHit }[]> {
  const spans = [...question.matchAll(PAGE_MENTION)].flatMap((m) => {
    const words = m[1].trim().split(" ");

    return words.map((_, k) => {
      const page = `${words.slice(k).join(" ")} (${m[2]})`;

      return { page, index: m.index + m[0].length - page.length };
    });
  });

  if (!spans.length) return [];
  const params = Object.fromEntries(spans.map((s, i) => [`p${i}`, s.page]));

  const rows = await selectAll(
    db,
    AliasHit,
    `SELECT p.page AS raw, ${ALIAS_HIT} FROM players p WHERE p.page IN (${spans.map((_, i) => `:p${i}`).join(", ")})`,
    params,
  );

  const byPage = new Map(rows.map((r) => [r.player, r]));
  const out: { page: string; index: number; hit: AliasHit }[] = [];

  // Spans of one parenthesis come longest first: keep the first page found for each parenthesis.
  for (const s of spans) {
    const hit = byPage.get(s.page);
    const end = s.index + s.page.length;

    if (hit && !out.some((o) => o.index + o.page.length === end)) out.push({ page: s.page, index: s.index, hit });
  }

  return out;
}

type Context = { league: string | null; yearFrom: number | null; yearTo: number | null };

async function contextGames(db: Db, playerId: number, ctx: Context): Promise<number> {
  const members = ctx.league ? leagueMembers(ctx.league, ctx.yearFrom, ctx.yearTo) : [];

  const row = await selectOne(
    db,
    CountRow,
    `SELECT COUNT(*) AS n FROM game_players gp
     JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
     JOIN leagues l ON l.id = t.league_id
     WHERE gp.player_id = :id AND t.stage <> 'qualifier'
       ${members.length ? `AND l.name IN (${members.map((_, i) => `:m${i}`).join(", ")})` : ""}
       AND (CAST(:yearFrom AS integer) IS NULL OR t.year >= :yearFrom)
       AND (CAST(:yearTo AS integer) IS NULL OR t.year <= :yearTo)`,
    { id: playerId, yearFrom: ctx.yearFrom, yearTo: ctx.yearTo, ...Object.fromEntries(members.map((m, i) => [`m${i}`, m])) },
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
export async function resolvePlayer(
  db: Db,
  mention: string,
  ctx: Context = { league: null, yearFrom: null, yearTo: null },
  known?: AliasHit[],
): Promise<ResolvedPlayer | null> {
  const hits = known ?? (await lookupAliases(db, [mention])).get(mention)!;

  if (hits.length === 0) return null;
  const byPlayer = [...new Map(hits.map((h) => [h.player, h])).values()];
  const hasContext = ctx.league != null || ctx.yearFrom != null || ctx.yearTo != null;

  const candidates: (PlayerCandidate & { hit: AliasHit })[] = await Promise.all(byPlayer.map(async (h) => ({
    player: h.player,
    games: h.games,
    contextGames: byPlayer.length > 1 && hasContext ? await contextGames(db, h.id, ctx) : h.games,
    exactCase: h.player === mention || h.ign === mention || (h.raw === mention && h.raw !== h.raw.toLowerCase()),
    hit: h,
  })));

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
      reason = msg().understand.exactCase(mention);
    } else {
      candidates.sort(rank);
      const [top, second] = candidates;

      if (hasContext && top.contextGames > 0 && second.contextGames === 0) {
        chosenBy = "context";
        reason = msg().understand.onlyInContext(top.contextGames);
      } else if (hasContext && top.contextGames > 0) {
        chosenBy = "context";
        uncertain = top.contextGames < CLEAR_MARGIN * second.contextGames;
        reason = msg().understand.moreInContext(top.contextGames, second.contextGames);
      } else {
        candidates.sort((a, b) => b.games - a.games);
        const [most, next] = candidates;
        chosenBy = "games";
        uncertain = most.games < CLEAR_MARGIN * next.games;
        reason = msg().understand.moreOverall(most.games, next.games);
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
    team: "Dplus Kia",
    members: ["DAMWON Gaming", "DWG KIA", "Dplus Kia"],
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

/**
 * How an alias names its team, weakest first: an abbreviation or a form derived from it (`alias`), the team's own name
 * (`name`), a curated shorthand (`curated`). On the same alias the stronger kind wins, then the team with more games.
 */
const ALIAS_RANK = { alias: 0, name: 1, curated: 2 } as const;

type AliasKind = keyof typeof ALIAS_RANK;

/**
 * `caps`: an abbreviation that is also an everyday word ("MAD", "FLY"), read as the team only when written in capitals.
 * `others`: the teams with fewer games that share the abbreviation (NIP: Ninjas in Pyjamas beside Ninjas in Pyjamas.CN);
 * the competition and period of the question pick among them (`inScope`).
 */
type TeamEntry = ResolvedTeam & { games: number; curated: boolean; rank: number; caps: boolean; others: ResolvedTeam[] };

type TeamIndex = Map<string, TeamEntry>;

/** `teamWidth`: the most tokens a team alias takes (`tokenize`), the longest span detectMentions reads as a team. */
type Indexes = { teams: TeamIndex; champions: Map<string, string>; teamWidth: number };

/** The words of a question as detectMentions reads them, and of a team alias to know how many it takes. */
function tokenize(text: string): string[] {
  return text
    .replace(/[’']/g, " ")
    .split(/[^\p{L}\p{N}.\-&]+/u)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);
}


/** Three-letter words and chat shorthands ("per", "svp", "pts"), English and French, too short for the common word list: an abbreviation among them is read in capitals only. */
const SHORT_WORDS = new Set(
  `ace afk all and ans any are art ask ate bad ban bar bed bet big bis bit bon bot box boy bus but buy can car cat
   col cop cow cry cup cut dan day des dia did die dig dmg dog dry due ear eat egg elo end era est eux exp eye fac
   fan far fat few fit fix fly for fox ftw fun fur gap gas gen get ggs god got gun guy had has hat her hey hid him
   his hit hot how ice ici ill img inf its jet jeu jgl job joy kda key kid lab law lay led leg les let lev lie lip
   lol los lot low lui lvl mad man map max may mec men mes met mid mil min mix moi mom mvp net new nip non nor nos
   not now nul odd off oil old omg one ont oui our out own par pas pay per pet peu pig pop pot pro pts pty put que
   qui ran raw rec red ren rid row rud run sad sam sat saw say sea see ses set sha she shy sin sit six sky sly son
   spy std sto stp sum sun sup sur svp tap tax tea ten tes the tie tip toi too top toy tps try two une use ver via
   vie vip vos war was way who why win won yes yet you`.split(/\s+/),
);

/** A league's short name ("PCS") names the league, never the team that shares it (Project Conquerors). */
const LEAGUE_SHORTS = new Set(LEAGUES.map((l) => normalizeAlias(l.short)));

/**
 * A team's Leaguepedia abbreviation as an alias ("KCB"): null when it is too short to mean the team (two letters without a
 * digit: "AT", "GO"), a role or grammar word, or a league's short name; `caps` when it is also an everyday word.
 */
function abbreviation(short: string): { caps: boolean } | null {
  const norm = normalizeAlias(short);

  if (norm.length < 2 || (norm.length === 2 && !/\d/.test(norm)) || STOPWORDS.has(norm) || ROLE_NAMES.has(norm) || LEAGUE_SHORTS.has(norm)) return null;

  return { caps: COMMON_WORDS.has(norm) || SHORT_WORDS.has(norm) };
}

/** "Karmine Corp Blue Stars" -> "Karmine Corp Blue Star": the plural last word of a name of several words, written in the singular. */
function singular(name: string): string | null {
  const m = /^(.+\s\p{L}{3,}[^s\s])s$/iu.exec(name.trim());

  return m ? m[1] : null;
}

/** Team and champion aliases, read once per database handle and kept for CACHE_MS. */
const getIndexes = cachedRead(readIndexes);

async function readIndexes(db: Db): Promise<Indexes> {
  // Teams with games, then those known only from series without a scoreboard (series_results), with 0 games.
  const all = await selectAll(
    db,
    z.object({ name: z.string(), short: z.string().nullable(), games: z.number() }),
    `SELECT t.name, t.short, SUM(x.game) AS games FROM (
       SELECT blue_team_id AS team_id, 1 AS game FROM games
       UNION ALL SELECT red_team_id, 1 FROM games WHERE red_team_id != blue_team_id
       UNION ALL SELECT team1_id, 0 FROM series_results
       UNION ALL SELECT team2_id, 0 FROM series_results
     ) x JOIN teams t ON t.id = x.team_id GROUP BY t.id ORDER BY games DESC, t.name`,
  );

  const rows = all.filter((r) => r.games > 0);

  const gamesOf = new Map(rows.map((r) => [r.name, r.games]));
  const teams: TeamIndex = new Map();
  let teamWidth = 0;

  const add = (alias: string, team: ResolvedTeam, kind: AliasKind, caps = false) => {
    const key = normalizeAlias(alias);

    if (key.length < 2 || STOPWORDS.has(key)) return;
    const games = team.members.reduce((n, m) => n + (gamesOf.get(m) ?? 0), 0);
    const rank = ALIAS_RANK[kind];
    const prev = teams.get(key);
    // Two teams under one abbreviation: the one with more games is read without a scope, the other is kept for one.
    const shared = kind === "alias" && prev?.rank === rank && prev.team !== team.team;

    if (!prev || rank > prev.rank || (rank === prev.rank && games > prev.games)) {
      const others = shared ? [{ mention: "", team: prev.team, members: prev.members }, ...prev.others].filter((o) => o.team !== team.team) : [];

      teams.set(key, { ...team, games, curated: kind === "curated", rank, caps, others });
      teamWidth = Math.max(teamWidth, tokenize(alias).length);
    } else if (shared && !prev.others.some((o) => o.team === team.team)) prev.others.push(team);
  };

  const single = (name: string) => ({ mention: "", team: name, members: [name] });

  for (const { name } of rows) {
    add(name, single(name), "name");

    const short = displayTeam(name)
      .replace(/^Team\s+/i, "")
      .replace(/\s+(Esports|e-Sports|Gaming|Esport)$/i, "");

    // "Top Esports" is not "top": a bare role word names the role (TES and Top Esports still name the team).
    if (normalizeAlias(short).length >= 3 && !ROLE_NAMES.has(normalizeAlias(short))) add(short, single(name), "name");
  }

  for (const [alias, name] of Object.entries(TEAM_SHORTHANDS))
    if (gamesOf.has(name)) add(alias, single(name), "curated");

  const franchiseOf = new Map<string, ResolvedTeam>();

  for (const f of FRANCHISES) {
    const team = { mention: "", team: f.team, members: f.members.filter((m) => gamesOf.has(m)) };

    for (const member of team.members) franchiseOf.set(member, team);

    for (const a of [...f.aliases, ...f.members]) add(a, team, "curated");
  }

  // Abbreviations, then the names a team of the same organization is called by its parent's abbreviation:
  // "Karmine Corp Blue Stars" is also "KCBS", "KC Blue Stars", "KCB Stars", and "Blue Star" in the singular.
  const abbreviations = new Map<string, string[]>();

  // A member of a curated franchise keeps the franchise's names: "KRX" (Kiwoom DRX) counts every DRX game, like "DRX".
  for (const { name, short } of rows) {
    const abbr = short ? abbreviation(short) : null;

    if (short && abbr) {
      add(short, franchiseOf.get(name) ?? single(name), "alias", abbr.caps);
      abbreviations.set(name, [short]);
    }
  }

  for (const [alias, name] of Object.entries(TEAM_SHORTHANDS)) abbreviations.set(name, [...(abbreviations.get(name) ?? []), alias]);

  for (const { name } of rows) {
    const words = displayTeam(name).split(/\s+/);
    const forms = [name];

    for (let i = 1; i < words.length; i++) {
      const suffix = words.slice(i).join(" ");

      for (const a of abbreviations.get(words.slice(0, i).join(" ")) ?? []) forms.push(`${a} ${suffix}`);
    }

    for (const form of forms) {
      if (form !== name) add(form, single(name), "alias");
      const one = singular(form);

      if (one) add(one, single(name), "alias");
    }
  }

  // A team known only from the schedule is named by its full name alone, never one that a question reads by accident:
  // an everyday word, or a team with games followed by a grammar word ("T1 a gagné" is "t1a" once normalized, the name
  // of a T1 academy team that has no scoreboard). "Afreeca Freecs Academy B" stays a name, and so does a Hangul name of
  // two syllables ("떡상"), which the two-letter rule of abbreviations is not about.
  const played = new Set(rows.map((r) => normalizeAlias(r.name)));

  for (const { name } of all.filter((r) => r.games === 0)) {
    const key = normalizeAlias(name);
    const word = /^\p{Script=Hangul}{2,}$/u.test(key) ? { caps: false } : abbreviation(name);
    const glued = [1, 2, 3].some((n) => played.has(key.slice(0, -n)) && STOPWORDS.has(key.slice(-n)));

    if (word && !word.caps && !glued) add(name, single(name), "name");
  }

  const champions = new Map<string, string>();

  for (const { name } of await selectAll(db, z.object({ name: z.string() }), "SELECT name FROM champions"))
    if (!name.includes("&amp;")) champions.set(normalizeAlias(name), name);

  for (const [alias, name] of Object.entries(CHAMPION_SHORTHANDS))
    if ([...champions.values()].includes(name)) champions.set(normalizeAlias(alias), name);

  return { teams, champions, teamWidth };
}

export async function resolveTeam(db: Db, mention: string): Promise<ResolvedTeam | null> {
  return (await lookupTeam(db, mention))?.team ?? null;
}

/** The team a mention names without a scope, and the other teams of the same abbreviation (`TeamEntry.others`). */
async function lookupTeam(db: Db, mention: string): Promise<{ team: ResolvedTeam; others: ResolvedTeam[] } | null> {
  const { teams } = await getIndexes(db);
  const hit = teams.get(normalizeAlias(mention)) ?? teamByEnd(teams, mention);

  return hit ? { team: { mention, team: hit.team, members: hit.members }, others: hit.others } : null;
}

/**
 * Among the teams of one abbreviation, the only one that played in the competition and period of the question (either
 * side of a game, qualifiers excluded): NIP in EU LCS 2017 is Ninjas in Pyjamas, not Ninjas in Pyjamas.CN. Without a
 * scope, or when several teams or none played in it, the team with more games stays.
 */
async function inScope(db: Db, team: ResolvedTeam, others: ResolvedTeam[], ctx: Context): Promise<ResolvedTeam> {
  if (!others.length || (ctx.league == null && ctx.yearFrom == null && ctx.yearTo == null)) return team;
  const candidates = [team, ...others];
  const names = [...new Set(candidates.flatMap((c) => c.members))];
  const members = ctx.league ? leagueMembers(ctx.league, ctx.yearFrom, ctx.yearTo) : [];

  const rows = await selectAll(
    db,
    z.object({ name: z.string() }),
    `SELECT DISTINCT tm.name FROM games g
     JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
     JOIN teams tm ON tm.id IN (g.blue_team_id, g.red_team_id)
     WHERE tm.name IN (${names.map((_, i) => `:n${i}`).join(", ")}) AND t.stage <> 'qualifier'
       ${members.length ? `AND l.name IN (${members.map((_, i) => `:m${i}`).join(", ")})` : ""}
       AND (CAST(:yearFrom AS integer) IS NULL OR t.year >= :yearFrom)
       AND (CAST(:yearTo AS integer) IS NULL OR t.year <= :yearTo)`,
    {
      yearFrom: ctx.yearFrom,
      yearTo: ctx.yearTo,
      ...Object.fromEntries(names.map((n, i) => [`n${i}`, n])),
      ...Object.fromEntries(members.map((m, i) => [`m${i}`, m])),
    },
  );

  const played = new Set(rows.map((r) => r.name));
  const found = candidates.filter((c) => c.members.some((m) => played.has(m)));

  return found.length === 1 ? { ...found[0], mention: team.mention } : team;
}

/**
 * The end of one team's name, in two words or more ("Blue Stars" for Karmine Corp Blue Stars), when no other team's
 * name ends the same way. Only for a mention the model already read as a team: the rules never guess from a name's end.
 * A team known only from the schedule (no game) is read by its full name alone.
 */
function teamByEnd(teams: TeamIndex, mention: string): TeamEntry | null {
  const words = mention.trim().split(/\s+/);

  if (words.length < 2) return null;
  const end = ` ${words.join(" ").toLowerCase()}`;
  const found = new Map<string, TeamEntry>();

  for (const entry of teams.values())
    if (entry.rank === ALIAS_RANK.name && entry.members.length === 1 && entry.games > 0 && ` ${entry.team.toLowerCase()}`.endsWith(end) && entry.team.length > end.length)
      found.set(entry.team, entry);

  return found.size === 1 ? [...found.values()][0] : null;
}

/** Franchises with several names that have games in the database, under their current name. */
export async function renamedTeams(db: Db): Promise<{ team: string; members: string[] }[]> {
  const teams = await Promise.all(FRANCHISES.map((f) => resolveTeam(db, f.team)));

  return teams.flatMap((t) => (t && t.members.length > 1 ? [{ team: t.team, members: t.members }] : []));
}

export async function resolveChampion(db: Db, mention: string): Promise<ResolvedChampion | null> {
  const name = (await getIndexes(db)).champions.get(normalizeAlias(mention));

  return name ? { mention, champion: name } : null;
}

/** At most one edit apart (insertion, deletion, substitution or two swapped neighbours): "oriana" and "Orianna". */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return a === b;

  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));

    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }

  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;

  while (i < short.length && short[i] === long[i]) i++;

  return short.slice(i) === long.slice(i + 1);
}

/**
 * A champion misspelled by one letter ("oriana", "lucain"), when exactly one champion is that close.
 * `opponent` reads the champion set against one already named: four letters and an everyday word are enough there ("lock").
 */
function resolveChampionTypo(champions: Map<string, string>, mention: string, opponent = false): ResolvedChampion | null {
  const norm = normalizeAlias(mention);
  const min = opponent ? OPPONENT_TYPO_MIN : CHAMPION_TYPO_MIN;

  if (norm.length < min || (opponent && !/^[a-z]+$/.test(norm)) || STOPWORDS.has(norm) || (opponent ? NOT_OPPONENTS : COMMON_WORDS).has(norm)) return null;
  const names = new Set<string>();

  for (const [alias, name] of champions) if (alias.length >= min && oneEditApart(norm, alias)) names.add(name);

  return names.size === 1 ? { mention, champion: [...names][0] } : null;
}

/** Shorter words are too often another word one letter away ("Zoe", "Sion"). */
const CHAMPION_TYPO_MIN = 5;

/** Next to a champion and a matchup word, a four-letter word one letter away is the opponent ("oriana vs lock"). */
const OPPONENT_TYPO_MIN = 4;

/** Grammar words one letter away from a champion, that follow one in a sentence ("Azir when", "Azir sont"). */
const NOT_OPPONENTS = new Set(
  "agir annee aren done driven else given gone hard juin name none real rely rien seen sent sept sert sets sinon sons sont soon tell then thin well when zero".split(" "),
);

/** Also the name of a team (Winners, 2015-2021): read as that team only when the question names no competition. */
const WINNERS = /^winners?$/;

/** A matchup word: the opponent may then follow the champion directly ("match up oriana lock"). */
const MATCHUP_CUE = /(?<![\p{L}\p{N}])match[- ]?ups?(?![\p{L}\p{N}])/iu;

/** The connector between two champions, as a token ("oriana vs lock"). */
const VERSUS_TOKENS = new Set(["vs", "versus", "contre", "against"]);

// Mentions ----------------------------------------------------------------------

/** The token a player page stands for in the question while mentions are read (`pageMentions`). */
const PAGE_PREFIX = "farsightpage";
const PAGE_TOKEN = new RegExp(`^${PAGE_PREFIX}\\d+$`);
const pageToken = (i: number) => `${PAGE_PREFIX}${i}`;

/** A handle that is an everyday word, or three Latin characters or fewer. */
function isCommonHandle(mention: string): boolean {
  const alias = normalizeAlias(mention);

  return /^[a-z0-9]{1,3}$/.test(alias) || COMMON_WORDS.has(alias);
}

/** `hits`: the players behind each mention, when the rules already looked them up. */
type Mentions = {
  players: string[];
  teams: ResolvedTeam[];
  champion: ResolvedChampion | null;
  opponentChampion?: ResolvedChampion | null;
  hits?: Map<string, AliasHit[]>;
  /** The other teams of an abbreviation, by the mention that names it: the scope of the question picks among them. */
  otherTeams?: Map<string, ResolvedTeam[]>;
};

/**
 * Every span of up to four tokens detectMentions may look up as a player alias, so their aliases are read in one query:
 * the same filters as the detection, before it knows which tokens a longer name takes.
 */
function aliasCandidates(tokens: string[]): string[] {
  const out = new Set<string>();

  for (let size = 4; size >= 1; size--)
    for (let i = 0; i + size <= tokens.length; i++) {
      const words = tokens.slice(i, i + size);

      if (words.every((w) => STOPWORDS.has(w.toLowerCase())) || (size === 1 && STOPWORDS.has(words[0].toLowerCase())) || /^\d+$/.test(words.join(""))) continue;
      const mention = words.join(" ");

      if (normalizeAlias(mention).length >= (/[\p{Script=Hangul}\p{Script=Han}]/u.test(mention) ? 2 : 3)) out.add(mention);
    }

  return [...out];
}

/**
 * Rule-based detection: longest n-gram that matches a known champion, team or
 * player alias, outside stat and game terms. On the same words a champion wins over a player ("Ahri"), and
 * a team wins over a player when it is a known shorthand or has more games.
 */
async function detectMentions(db: Db, question: string): Promise<Mentions> {
  const { league, mention: leagueMention } = detectLeague(question);

  // A league written by its full name ("Liga Española de League of Legends") is no player or team: its words are set aside.
  const asked = leagueMention?.includes(" ") ? question.replace(leagueMention, " ".repeat(leagueMention.length)) : question;

  // A player written by their page is that player: the page becomes one placeholder token, read before anything else.
  const pages = await pageMentions(db, asked);
  let marked = asked;

  for (const [i, p] of [...pages.entries()].toSorted(([, a], [, b]) => b.index - a.index))
    marked = `${marked.slice(0, p.index)}${pageToken(i)}${marked.slice(p.index + p.page.length)}`;

  const tokens = tokenize(maskTerms(marked));

  const { teams, champions, teamWidth } = await getIndexes(db);
  const hits = await lookupAliases(db, aliasCandidates(tokens.filter((t) => !PAGE_TOKEN.test(t))));
  const found: Mentions = { players: [], teams: [], champion: null, hits, otherTeams: new Map() };
  const used = new Set<number>();
  // Where each mention starts, in tokens: the order of the question.
  const at = new Map<string, number>();

  tokens.forEach((t, i) => {
    const page = PAGE_TOKEN.test(t) ? pages[Number(t.slice(PAGE_PREFIX.length))] : undefined;

    if (!page) return;
    found.players.push(page.page);
    hits.set(page.page, [page.hit]);
    at.set(page.page, i);
    used.add(i);
  });
  const byPage = new Set(pages.map((p) => p.page));
  // The tokens of the first champion: its opponent is written next to it ("oriana lock").
  const championAt = new Set<number>();

  // Four words ("Royal Never Give Up"), or the longest team name ("Jin Air Green Wings Stealths"): a longer span is only
  // a team, read from the index already in memory (players are looked up up to four words, champions are shorter).
  for (let size = Math.min(tokens.length, Math.max(4, teamWidth)); size >= 1; size--) {
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

      const championName = norm.length >= 3 || mention === "Vi" ? champions.get(norm) : undefined;
      const champion = championName ? { mention, champion: championName } : null;

      if (champion && !found.champion) {
        found.champion = champion;
        at.set(mention, i);
        span.forEach((k) => used.add(k));
        span.forEach((k) => championAt.add(k));
        continue;
      }

      // A second champion: the one the first is set against ("Azir contre Orianna").
      if (champion && !found.opponentChampion && champion.champion !== found.champion?.champion) {
        found.opponentChampion = champion;
        at.set(mention, i);
        span.forEach((k) => used.add(k));
        continue;
      }

      // "MSI winners", "winners of the LCK": the winners of the competition named, not the team Winners.
      if (WINNERS.test(norm) && league) continue;

      const hit = teams.get(norm);
      // "mad" in a sentence is the word; "MAD" is the team.
      const team = hit?.caps && mention !== mention.toUpperCase() ? undefined : hit;
      const players = norm.length >= (isHangulOrHan ? 2 : 3) ? hits.get(mention) ?? [] : [];

      // An abbreviation that is also a player's handle names the player, unless written in capitals ("Wiz", "WIZ").
      const abbreviationOfPlayer = team?.rank === ALIAS_RANK.alias && players.length > 0 && mention !== mention.toUpperCase();

      if (team && !abbreviationOfPlayer && (team.curated || !players.length || team.games >= players[0].games)) {
        // An abbreviation two teams share stays a mention of its own: the scope may name the other team (buildEntities).
        if (team.others.length || !found.teams.some((t) => t.team === team.team && !found.otherTeams?.has(t.mention))) {
          found.teams.push({ mention, team: team.team, members: team.members });

          if (team.others.length) found.otherTeams?.set(mention, team.others);

          at.set(mention, i);
        }

        span.forEach((k) => used.add(k));
        continue;
      }

      if (players.length) {
        found.players.push(mention);

        if (!at.has(mention)) at.set(mention, i);
        span.forEach((k) => used.add(k));
      }
    }
  }

  // A word left over that is one letter away from a champion ("oriana"): not a player, a team or an everyday word.
  for (let i = 0; i < tokens.length && !(found.champion && found.opponentChampion); i++) {
    if (used.has(i) || /\d/.test(tokens[i])) continue;
    const champion = resolveChampionTypo(champions, tokens[i]);

    if (!champion || champion.champion === found.champion?.champion) continue;

    if (found.champion) found.opponentChampion = champion;
    else {
      found.champion = champion;
      championAt.add(i);
    }

    at.set(tokens[i], i);
    used.add(i);
  }

  // The opponent of a champion, misspelled and short or an everyday word ("oriana vs lock"): only in a question about
  // champions alone, right after or before "vs", or next to the champion after "match up", so that "lock" or "then"
  // in a normal question stays a word ("Azir lock in vs G2").
  if (found.champion && !found.opponentChampion && !found.players.length && !found.teams.length) {
    const matchup = MATCHUP_CUE.test(question);

    const next = (i: number, d: number) => {
      const k = i + d;

      return (matchup && championAt.has(k)) || VERSUS_TOKENS.has(tokens[k]?.toLowerCase());
    };

    for (let i = 0; i < tokens.length && !found.opponentChampion; i++) {
      if (used.has(i) || !(next(i, -1) || next(i, 1))) continue;
      const champion = resolveChampionTypo(champions, tokens[i], true);

      if (!champion || champion.champion === found.champion.champion) continue;
      found.opponentChampion = champion;
      at.set(tokens[i], i);
      used.add(i);
    }
  }

  // A handle that is also an everyday word ("Paris", "Life") or very short
  // ("Bin") names a player in a question about esport, or when the question
  // says nothing else ("résultats de Knight"): not in "la météo à Paris".
  if (found.players.some((m) => !byPage.has(m) && isCommonHandle(m))) {
    const esport =
      found.teams.length > 0 ||
      found.champion != null ||
      found.players.some((m) => !isCommonHandle(m)) ||
      detectLeague(question).league != null ||
      [TERM_PHRASES, ROLE_PHRASES, STAT_WORDS].some((p) => blank(question, p) !== question) ||
      detectMetric(question) != null ||
      LOL_DOMAIN.test(question);

    const alone = tokens.every((t, i) => used.has(i) || STOPWORDS.has(t.toLowerCase()) || /^\d+$/.test(t) || BARE_POOL.test(t));

    if (!esport && !alone) found.players = found.players.filter((m) => byPage.has(m) || !isCommonHandle(m));
  }

  // Next to a team, "top", "sup" or "jg" name its player at that role ("top fpx 2019"), not the handle Top or Sup.
  if (found.teams.length) found.players = found.players.filter((m) => byPage.has(m) || !SHORT_ROLE_MENTION.test(m));

  // Keep the order of the question (it decides sides in a head-to-head).
  const pos = (m: string) => at.get(m) ?? Number.MAX_SAFE_INTEGER;
  found.players.sort((a, b) => pos(a) - pos(b));
  found.teams.sort((a, b) => pos(a.mention) - pos(b.mention));

  // Longer names are read first ("Lee Sin" before "Azir"): the champion the question names first stays the subject.
  if (found.champion && found.opponentChampion && pos(found.opponentChampion.mention) < pos(found.champion.mention))
    [found.champion, found.opponentChampion] = [found.opponentChampion, found.champion];

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


async function leagueShort(db: Db, league: string | null): Promise<string | null> {
  if (!league) return null;

  return (await selectOne(db, z.object({ short_name: z.string() }), "SELECT short_name FROM leagues WHERE name = ?", [league]))?.short_name ?? null;
}

async function buildEntities(
  db: Db,
  question: string,
  now: Date,
  mentions: Mentions,
  overrides: Partial<Pick<Entities, "league" | "yearFrom" | "yearTo">> = {},
): Promise<Entities> {
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
    const p = await resolvePlayer(db, m, { league, yearFrom, yearTo }, mentions.hits?.get(m));

    if (p && !players.some((x) => x.player === p.player)) players.push(p);
    else if (!p) unresolved.push(m);
  }

  const teams: ResolvedTeam[] = [];

  for (const t of mentions.teams) {
    const team = await inScope(db, t, mentions.otherTeams?.get(t.mention) ?? [], { league, yearFrom, yearTo });

    if (!teams.some((x) => x.team === team.team)) teams.push(team);
  }

  const outOfScope = OUT_OF_SCOPE.exec(question)?.[0] ?? null;

  return {
    players,
    teams,
    champion: mentions.champion,
    opponentChampion: mentions.opponentChampion ?? null,
    unresolved,
    league,
    leagueShort: await leagueShort(db, league),
    leagueMention: rulesLeague.mention,
    yearFrom,
    yearTo,
    split: SPLIT_CUES.find((s) => s.pattern.test(question))?.split ?? null,
    outOfScope,
  };
}

type Input = { db: Db; question: string; now: Date };

/** Level 1: regex + alias tables. Confident when every entity is found without doubt. */
const rulesDecider: Decider<Input, Entities> = {
  level: "rules",
  name: "regex + alias",
  run: async ({ db, question, now }) => {
    const entities = await buildEntities(db, question, now, await detectMentions(db, question));
    const n = entities.players.length + entities.teams.length + (entities.champion ? 1 : 0);
    let confidence = entities.outOfScope ? 0.9 : n === 0 ? (entities.league ? 0.8 : 0.2) : n <= 2 ? 0.9 : 0.6;

    if (entities.players.some((p) => p.ambiguity?.uncertain)) confidence -= 0.1;

    if (entities.unresolved.length) confidence -= 0.1;

    return {
      result: entities,
      confidence,
      level: "rules",
      reason: entities.outOfScope
        ? msg().understand.outOfScope(entities.outOfScope)
        : n === 0
          ? msg().understand.nothingKnown
          : msg().understand.recognized(n),
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

    const found = (await Promise.all(output.teams.map((t) => lookupTeam(db, t)))).filter((t) => t != null);
    const teams = found.map((t) => t.team);
    const otherTeams = new Map(found.map((t) => [t.team.mention, t.others]));

    const entities = await buildEntities(
      db,
      question,
      now,
      // The LLM may still copy a term's word as a name ("solo" in "solo kills").
      { players: output.players.filter((p) => !onlyInTerms(question, p)), teams, otherTeams, champion: output.champion ? await resolveChampion(db, output.champion) : null },
      { league: output.league, yearFrom: output.yearFrom, yearTo: output.yearTo },
    );

    const n = entities.players.length + entities.teams.length + (entities.champion ? 1 : 0);

    return {
      result: entities,
      confidence: n ? 0.85 : 0.5,
      level: "llm",
      reason: msg().understand.extracted(llm.id, output.players.length + output.teams.length),
    };
  },
};

/** `now` dates the relative seasons of the question ("l'an dernier"); tests pass a fixed date. */
export function understandQuestion(db: Db, question: string, now: Date = new Date()) {
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

  const mentions = [...e.players.map((p) => p.mention), ...e.teams.map((t) => t.mention), e.champion?.mention, e.opponentChampion?.mention, e.leagueMention];

  // Mentions are rebuilt from tokens: "Kai Sa" was written "Kai'Sa". Whole words only: "TL" is not the one in "botlaner".
  for (const m of mentions)
    if (m) take(new RegExp(`(?<![\\p{L}\\p{N}])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s'’]+")}(?![\\p{L}\\p{N}])`, "iu"));

  if (e.yearFrom != null || e.yearTo != null) for (const p of [YEAR, ...RELATIVE_YEARS.map((r) => r.pattern)]) take(p);

  return { rest, read };
}
