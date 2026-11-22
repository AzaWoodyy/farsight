import { msg } from "./messages";
import { LEAGUES, leagueMembers, ROSTER_EXCLUDED } from "../domain/leagues";
import { generateText, Output } from "ai";
import { z } from "zod";
import { type Db, readSchema, selectAll, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema, VIEWS, MAX_ROWS } from "./guard";
import { getLlm, LLM_CALL, llmSignal } from "./llm";
import type { Correction, Problem } from "./recovery";
import {
  aiTools,
  type BoundTool,
  bindTool,
  type ChampionAverageSort,
  type ChampionExtraSort,
  type ChampionFocus,
  type ChampionSort,
  type ChampionTotalSort,
  COMPARISON_END_STATS,
  type ComparisonMetric,
  type GamePhase,
  type MapSide,
  normalizeToolCall,
  type PlayerCriterion,
  type RecordMetric,
  type TeamCriterion,
  type ToolCall,
  withLeague,
} from "./tools";
import { detectMetric, DRAGON_ELEMENT, isDragonCue, isSnapshot, type MetricCue, type Minute, MINUTE, MINUTES } from "./metrics";
import { ROLE_CUES as ROLES, roleOf, TEAM_ROLE_CUES, teamRoleOf } from "./roles";
import type { Entities, QueryPlan, ToolName } from "./types";
import { CHAMPION_POOL, LOL_DOMAIN, maskUnderstood, resolveTeam, SPLIT_CUES } from "./understand";

const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

const VERSUS = word("vs\\.?|versus|contre|face [àa]|against|head[- ]to[- ]head|h2h|confrontations?|affrontements?");

export const OPPOSE = word(
  "compar(?:er|ez|e|es|aisons?|ing|ed|ison|isons)|vs\\.?|versus|contre|against|face[- ][àa][- ]face|or|ou|" +
    "who(?:'s| is) (?:the )?better|qui est (?:le |la )?meilleure?|meilleure?s?|better|best|mieux|diff[ée]rences?|differences?|" +
    "head[- ]?(?:to|2)[- ]?head|h2h|confrontations?|affrontements?|duels?|rencontres?|l'un contre l'autre|against each other|" +
    "(?:matchs?|games?|parties|s[ée]ries?) (?:entre|between)",
);

const STANDINGS = word(
  "palmar[eè]s|vainqueurs?|gagnants?|winners?|qui a gagn[ée]|qui a soulev[ée] (?:la coupe|le troph[ée]e)|who won|who lifted the (?:cup|trophy)|classements?|standings|podium|sacr[ée]s?|finale",
);

const UNSUPPORTED = word(
  "kills?|kda|morts?|deaths?|assists?|pentakills?|quadrakills?|gold|golds|cs|farm|d[ée]g[âa]ts|damage|vision|wards?|" +
    "dragons?|drakes?|barons?|heralds?|nashor|towers?|tourelles?|dur[ée]e|duration|plus longue?s?|plus courte?s?|" +
    "moyenne|average|first blood|premier sang|patch|items?|objets?|runes?|keystone|sorts?|build|" +
    "le plus de|most|quel joueur|quels joueurs|which players?|quelle [ée]quipe|which team|top \\d+",
);

const DATA_CONCEPTS = [
  { concept: "spells", pattern: word("sorts? d'invocateurs?|summoner spells?"), view: "v_game_players", column: "spell1" },
  { concept: "mvp", pattern: word("mvps?|pogs?|player of the (?:game|match)|joueurs? du match"), view: "v_game_players", column: "mvp" },
] as const;

export function missingConcepts(question: string, schema: Record<string, string[]>): string[] {
  return DATA_CONCEPTS.flatMap((c) => (c.pattern.test(question) && !(schema[c.view] ?? []).includes(c.column) ? [msg().route.concepts[c.concept]] : []));
}

type Awaitable<T> = T | Promise<T>;

export type Coverage = { games: number; ingame: number };

export type CoverageLookup = {
  league: (league: string | null, yearFrom: number | null, yearTo: number | null) => Awaitable<Coverage>;
  player: (player: string, league: string | null, yearFrom: number | null, yearTo: number | null) => Awaitable<Coverage>;
  team: (members: string[], league: string | null, yearFrom: number | null, yearTo: number | null) => Awaitable<Coverage>;
  playerTeam?: (player: string, league: string | null, yearFrom: number | null, yearTo: number | null, split: string | null) => Awaitable<PlayerTeam | null>;
};

export type PlayerTeam = { team: string; year: number; others: string[] };

const PlayerTeamRow = z.object({ team: z.string(), year: z.number() });

const CoverageRow = z.object({ games: z.number().nullable(), ingame: z.number().nullable() });

const period = (col: string, yearFrom: number | null, yearTo: number | null, params: (string | number)[]) => {
  let sql = "";

  if (yearFrom != null) {
    sql += ` AND ${col} >= ?`;
    params.push(yearFrom);
  }

  if (yearTo != null) {
    sql += ` AND ${col} <= ?`;
    params.push(yearTo);
  }

  return sql;
};

export function coverageLookup(db: Db): CoverageLookup {
  const read = async (sql: string, params: (string | number)[]): Promise<Coverage> => {
    const row = await selectOne(db, CoverageRow, sql, params);

    return { games: row?.games ?? 0, ingame: row?.ingame ?? 0 };
  };

  return {
    league: (league, yearFrom, yearTo) => {
      const params: (string | number)[] = [];
      const members = league ? leagueMembers(league, yearFrom, yearTo) : [];
      const where = league ? (params.push(...members), `league IN (${members.map(() => "?").join(",")})`) : "1";

      return read(`SELECT SUM(games) AS games, SUM(ingame_games) AS ingame FROM v_ingame_coverage WHERE ${where}${period("year", yearFrom, yearTo, params)}`, params);
    },
    player: (player, league, yearFrom, yearTo) => {
      const params: (string | number)[] = [player];
      const members = league ? leagueMembers(league, yearFrom, yearTo) : [];
      const where = league ? (params.push(...members), ` AND p.league IN (${members.map(() => "?").join(",")})`) : "";

      return read(
        `SELECT COUNT(*) AS games, SUM(g.has_ingame) AS ingame FROM v_game_players p JOIN v_games g ON g.game_id = p.game_id
         WHERE p.player = ?${where}${period("p.year", yearFrom, yearTo, params)}`,
        params,
      );
    },
    team: (names, league, yearFrom, yearTo) => {
      const marks = names.map(() => "?").join(",");
      const params: (string | number)[] = [...names, ...names];
      const members = league ? leagueMembers(league, yearFrom, yearTo) : [];
      const where = league ? (params.push(...members), ` AND g.league IN (${members.map(() => "?").join(",")})`) : "";

      return read(
        `SELECT COUNT(*) AS games, SUM(g.has_ingame) AS ingame FROM v_games g
         WHERE (g.blue_team IN (${marks}) OR g.red_team IN (${marks}))${where}${period("g.year", yearFrom, yearTo, params)}`,
        params,
      );
    },
    playerTeam: async (player, league, yearFrom, yearTo, split) => {
      const params: (string | number)[] = [player];
      const members = league ? leagueMembers(league, yearFrom, yearTo) : [...ROSTER_EXCLUDED];
      const inLeague = (params.push(...members), ` AND p.league ${league ? "IN" : "NOT IN"} (${members.map(() => "?").join(",")})`);
      const inPeriod = period("p.year", yearFrom, yearTo, params);
      const inSplit = split ? (params.push(split), " AND p.tournament_page IN (SELECT s.tournament_page FROM v_tournaments s WHERE s.split = ?)") : "";

      const rows = await selectAll(
        db,
        PlayerTeamRow,
        `SELECT p.team, MAX(p.year) AS year FROM v_game_players p
         WHERE p.player = ? AND p.stage IN ('main_event', 'play_in', 'season', 'playoffs')${inLeague}${inPeriod}${inSplit}
         GROUP BY p.team ORDER BY MAX(p.played_at) DESC, p.team`,
        params,
      );

      if (!rows.length) return null;

      const franchise = (await resolveTeam(db, rows[0].team))?.members ?? [];

      return { team: rows[0].team, year: rows[0].year, others: rows.slice(1).map((r) => r.team).filter((t) => !franchise.includes(t)) };
    },
  };
}

const RANKING = word(
  "le plus|la plus|les plus|le moins|most|highest|lowest|greatest|meilleure?s?|best|top ?\\d+|classements?|rankings?|leaderboards?|record|quels? joueurs?|quelles? [ée]quipes?|which (?:players?|teams?)|qui (?:a|fait|prend|prennent)",
);

const TEAM_WORDS = word("[ée]quipes?|teams?");

export const ROSTER = word(
  "ro[ao]?sters?|line[- ]?ups?|effectifs?|compositions?|compos?|[ée]quipes? types?|cinq (?:de d[ée]part|majeur)|starting (?:five|lineup)|titulaires?|rempla[çc]ants?|" +
    "qui (?:jouait|jouaient|joue|jouent|a jou[ée]|ont jou[ée]|[ée]tait|[ée]taient)(?: (?:chez|pour|dans|à|a|avec|en))?|who (?:played|plays|was|were)(?: (?:for|on|in|at))?|" +
    "(?:quels?|les) joueurs (?:de|d'|du|chez|pour)|players (?:of|on|for)|membres?|members?",
);

const NOT_ROSTER = word(
  "le plus|la plus|les plus|most|meilleure?s?|best|pires?|worst|top ?\\d+|kda|kills?|gold|golds|cs|d[ée]g[âa]ts|damage|vision|winrate|win rate|stats?|statistiques?",
);

const PLAYER_TEAM = word(
  "[ée]quipe|team|co[ée]quipiers?|team ?mates?|partenaires?|ro[ao]?sters?|line[- ]?ups?|effectifs?|" +
    "qui (?:jouait|jouaient|joue|jouent|a jou[ée]|ont jou[ée]) avec|who (?:played|plays) with",
);

const WHICH_TEAM = /quelle [ée]quipe|which team/giu;

const PLAYS_FOR = word(
  "(?:dans|pour|chez|in|for|on) (?:quelle [ée]quipe|which team)|(?:quelle [ée]quipe|which team) (?:est|[ée]tait|is|was)|" +
    "play(?:s|ed|ing)? (?:for|on|with)|jou(?:e|ait|[ée]) (?:pour|chez|dans|avec)",
);

const TEAM_RESULTS = word(
  "r[ée]sultats?|results?|parcours|historique|history|bilan|records?|perfs?|performances?|palmar[eè]s|titres?|titles?|troph[ée]es?|classements?|class[ée]e?s?|rankings?|rank|ranks|ranked|standings|places?|" +
    "placements?|podiums?|finish|finished|termin[ée]e?s?|fini|carri[èe]re|career|victoires?|wins?|won|gagn[ée]e?s?|d[ée]faites?|losses|lost|perdu|" +
    "battue?s?|bat|beat|beats|beaten|vaincue?s?|defeated|[ée]limin[ée]e?s?|eliminated|affront[ée]e?s?|faced|combien|how many|how did|how well|comment",
);

export const POOL = word(
  `${CHAMPION_POOL}|pools?|` +
    "quels? champions?|quelles? champions?|which champions?|what champions?|" +
    "champions? (?:jou[ée]e?s?|played|pick[ée]e?s?|picked|utilis[ée]e?s?|used)|champions? (?:les? |la )?(?:plus|most) (?:jou[ée]e?s|played|pick[ée]e?s|picked)|" +
    "(?:most|least) (?:played|picked) champions?|(?:par|by|per) champions?|ses champions|his champions|her champions|their champions|" +
    "persos?|signature picks?",
);

export const CHAMPION_RANKING = word(
  "champions? (?:les? |la )?(?:plus|moins)|(?:most|least) (?:played|picked|banned|contested|popular|present) champions?|" +
    "(?:meilleurs?|best|top ?\\d*|strongest|plus forts?|pires?|worst) champions?|champions? (?:avec|with|[àa]u?|ayant) (?:la |le |the )?(?:plus|most|meilleure?|best|highest|pire|worst)|" +
    "classement des champions|champions? ranking|ranking of champions|m[ée]ta|tier ?list|priorit(?:[ée]s?|y)(?: picks?)?|picks? prioritaires?|" +
    "quels? champions?|quelles? champions?|which champions?|what champions?|" +
    "(?:les? )?plus (?:jou[ée]s|bann(?:i|is|ies)|pick[ée]s|choisis|contest[ée]s)|(?:most|least) (?:played|picked|banned|contested)",
);

const NOT_CHAMPION_RANKING = word("champions? (?:du monde|d'europe|de cor[ée]e|de chine|en titre)|world champions?|reigning champions?");

export const CHAMPION_SORT_CUES: [ChampionSort, RegExp][] = [
  ["presence", word("pr[ée]sences?|presences?|pr[ée]sents?|present|contest[ée]s?|contested|prioritaires?|priorit[ée]s?|priority|m[ée]ta|tier ?list|picks? (?:et|and|ou|or|\\+|&) bans?|picks?/bans?|pick ?(?:&|et|and) ?ban")],
  ["bans", word("bann(?:i|is|ie|ies|ed|s)?|bans?|ban ?rates?")],
  ["kda", word("kda")],
  ["winrate", word("win ?rates?|taux de victoire|gagnants?|gagnent|victoires?|wins?|winning")],
  ["picks", word("jou[ée]e?s?|played|pick[ée]e?s?|picks?|picked|choisis|populaires?|popular|pick ?rates?|souvent|often")],
  ["winrate", word("forts?|strongest|strong|meilleurs?|best|pires?|worst")],
];

const CHAMPION_UNRANKED = word(
  "kills?|morts?|deaths?|assists?|golds?|d['’]or|cs|farm|d[ée]g[âa]ts|damage|vision|dragons?|drakes?|barons?|tourelles?|towers?|dur[ée]e|duration",
);

const CHAMPION_OTHER_FIGURES = word("dragons?|drakes?|barons?|tourelles?|towers?|dur[ée]e|duration");

const CHAMPION_DRAGON_KILLS = word("champions? (?:avec|ayant|a|ont) le plus de dragons?|champions? (?:with|has|have|killed|kills) the most (?:dragons|drakes|dragon kills)");

export const championSortOf = (question: string): ChampionSort => CHAMPION_SORT_CUES.find(([, re]) => re.test(question))?.[0] ?? "presence";

export const CHAMPION_AVERAGE_CUES: [ChampionAverageSort, RegExp][] = [
  ["kills", word("kills?")],
  ["deaths", word("morts?|deaths?")],
  ["assists", word("assists?")],
  ["gold", word("golds?|d['’]or")],
  ["cs", word("cs|farm")],
  ["damage", word("d[ée]g[âa]ts|damages?")],
  ["vision", word("vision")],
];

const PER_GAME = word("par (?:partie|game|match)|per (?:game|match)|/ ?(?:partie|game|match)|en moyenne|moyen(?:ne)?s?|on average|averages?");

const LOWEST = word("(?<!au )moins|(?<!at )least|fewest|lowest|pires?|worst");

const WORST = word("pires?|worst");

export function championAverageSortOf(question: string): ChampionAverageSort | null {
  const asked = CHAMPION_AVERAGE_CUES.filter(([, re]) => re.test(question));

  return asked.length === 1 && PER_GAME.test(question) && !LOWEST.test(question) ? asked[0][0] : null;
}

const TOTAL = word("au total|en tout|in total|totale?s?|cumul[ée]e?s?|nombre (?:de|d')|number of|combien|how many");

const CHAMPION_INGAME_TOTAL: Partial<Record<NonNullable<MetricCue["player"]>, ChampionTotalSort>> = {
  penta_kills: "penta_kills",
  quadra_kills: "quadra_kills",
  triple_kills: "triple_kills",
  double_kills: "double_kills",
  solo_kills: "solo_kills",
  first_bloods: "first_blood",
};

export function championTotalSortOf(question: string, cue: MetricCue | null): ChampionTotalSort | null {
  if (LOWEST.test(question) || PER_GAME.test(question) || PER_MINUTE.test(question)) return null;

  if (cue) {
    const sort = cue.player ? CHAMPION_INGAME_TOTAL[cue.player] : undefined;

    return sort && (sort !== "first_blood" || TOTAL.test(question)) ? sort : null;
  }

  const asked = CHAMPION_AVERAGE_CUES.filter(([, re]) => re.test(question));

  return asked.length === 1 ? asked[0][0] : null;
}

const PER_MINUTE = word("par min(?:ute)?|per min(?:ute)?|/ ?min(?:ute)?|dpm|gpm|cspm");

const MOST_PLAYERS = word("(?:le )?plus de joueurs|joueurs diff[ée]rents|most (?:different )?players|different players");

const CHAMPION_INGAME_SORT: Partial<Record<NonNullable<MetricCue["player"]>, ChampionExtraSort>> = {
  gold_diff: "gold_diff_15",
  cs_diff: "cs_diff_15",
  xp_diff: "xp_diff_15",
  solo_kills: "solo_kills",
  first_bloods: "first_blood",
};

export function championExtraSortOf(question: string, cue: MetricCue | null): ChampionExtraSort | null {
  if (LOWEST.test(question)) return null;

  if (cue) {
    const sort = cue.player ? CHAMPION_INGAME_SORT[cue.player] : undefined;

    return sort && (cue.askedMinute == null || cue.askedMinute === 15 || !isSnapshot(cue)) ? sort : null;
  }

  if (MOST_PLAYERS.test(question)) return "players";

  if (!PER_MINUTE.test(question)) return null;

  if (word("dpm|d[ée]g[âa]ts|damages?|dmg").test(question)) return "dpm";

  if (word("gpm|golds?|d['’]or|or").test(question)) return "gpm";

  return word("cspm|cs|farm").test(question) ? "cspm" : null;
}

export const SIDE_CUES: [MapSide, RegExp][] = [
  ["blue", word("c[ôo]t[ée] bleu|blue ?side|side bleu|en bleu|(?:du|au|le) bleu")],
  ["red", word("c[ôo]t[ée] rouge|red ?side|side rouge|en rouge|(?:du|au|le) rouge")],
];

export function sideOf(question: string): MapSide | null {
  const asked = SIDE_CUES.filter(([, re]) => re.test(question));

  return asked.length === 1 ? asked[0][0] : null;
}

const PLAYER_WORDS = word("joueurs?|joueuses?|players?|pros?|laners?|laneurs?");

const COMPARE = word("compar\\p{L}*|versus|vs\\.?|face[- ][àa][- ]face|head[- ]to[- ]head|duels?|matchups?");

const PROFILE_INGAME = new Set(["gold_diff@15", "cs_diff@15"]);

const MINIMUM = /(au moins|minimum(?: de)?|min\.?|at least|plus de|more than|over)\s*(\d{1,3})\s*(parties|games|matchs|matches|picks)/iu;

const STRICT = /^(?:plus de|more than|over)$/i;

export function minimumOf(question: string, unit: "games" | "picks"): number | null {
  const m = MINIMUM.exec(question);

  if (!m || (unit === "picks") !== /picks/i.test(m[3])) return null;
  const n = Number(m[2]) + (STRICT.test(m[1]) ? 1 : 0);

  return n >= 1 && n <= 200 ? n : null;
}

export const PLAYER_CRITERION_CUES: [PlayerCriterion, RegExp][] = [
  ["kda", word("kda")],
  ["kp", word("kp|kill participation|participation aux kills|participation")],
  ["dmg_share", word("parts? (?:des?|aux|de ses|de leurs) d[ée]g[âa]ts|(?:damage|dmg) share|share of (?:the )?(?:team(?:'s)? )?damage|dmg ?%|d[ée]g[âa]ts ?%|% (?:des? )?d[ée]g[âa]ts|d[ée]g[âa]ts de (?:son|leur|l') ?[ée]quipe")],
  ["gold_share", word("parts? (?:de l'|des? |d')(?:or|golds?)|gold share|share of (?:the )?(?:team(?:'s)? )?gold|gold ?%|% (?:de l'|des? |d')(?:or|golds?)|(?:or|golds?) de (?:son|leur|l') ?[ée]quipe")],
  ["dpm", word("d[ée]g[âa]ts|damages?|dpm|dmg")],
  ["cspm", word("cs ?(?:/|par|per) ?min(?:ute)?|cspm|cs|farm(?:ers?|eurs?|ing)?")],
  ["gpm", word("gpm|gold|golds|or (?:par|per) minute|d'or")],
  ["vspm", word("vision|vspm|score de vision")],
  ["winrate", word("win ?rates?|taux de victoire|victoires?|wins?|gagn\\p{L}*|winning")],
  ["games", word("(?:le plus de|most|plus de) (?:parties|games|matchs)|(?:le plus|most) jou[ée]|exp[ée]riment[ée]s?|experienced|v[ée]t[ée]rans?|played the most")],
  ["kills", word("kills?|tueurs?|killers?")],
  ["assists", word("assists?")],
];

const withoutTeamShare = (question: string) =>
  PLAYER_CRITERION_CUES.filter(([c]) => c === "dmg_share" || c === "gold_share").reduce((q, [, re]) => q.replace(new RegExp(re.source, "giu"), " "), question).replace(/(?:de|d')\s*(?:son|leur|l')\s*[ée]quipe/giu, " ");

export const playerCriterionOf = (question: string): PlayerCriterion => PLAYER_CRITERION_CUES.find(([, re]) => re.test(question))?.[0] ?? "kda";

function championRankingRoute(question: string, e: Entities, sort: ChampionSort = championSortOf(question), total = false): Route {
  const role = roleOf(question);
  const side = sideOf(question);
  const minPicks = minimumOf(question, "picks") ?? minimumOf(question, "games");

  return {
    kind: "tool",
    call: { tool: "champion_ranking", input: { league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, sort, total, role, side, minPicks, split: e.split } },
    confidence: 0.9,
    reason: msg().route.championRanking(sort, Boolean(total), role ?? null, side ?? null),
    notes: e.league ? [] : [msg().route.noLeagueWorldsRanking],
  };
}

function playerLeaderboardRoute(question: string, e: Entities): Route {
  const criterion = playerCriterionOf(question);
  const role = roleOf(question);
  const side = sideOf(question);

  return {
    kind: "tool",
    call: { tool: "player_leaderboard", input: { role, league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, criterion, minGames: minimumOf(question, "games"), side, split: e.split } },
    confidence: 0.85,
    reason: msg().route.playerRanking(role ?? null, criterion, side ?? null),
    notes: e.league ? [] : [msg().route.noLeagueWorldsRanking],
  };
}

const ROLE_CUES = ROLES.map((r) => ({ role: r.role, pattern: word(r.words) }));

function scopeOf(e: Entities): string {
  return msg().route.leagueScope(e.leagueShort);
}

async function ingameAbsent(e: Entities, mention: string, coverage: CoverageLookup): Promise<Route | null> {
  if (!e.league || (await coverage.league(e.league, e.yearFrom, e.yearTo)).ingame > 0) return null;

  return {
    kind: "missing",
    concepts: [msg().route.ingameFor(msg().route.ingameStats(mention), scopeOf(e))],
    reason: msg().route.noRiotGames(e.leagueShort ?? e.league, e.yearFrom),
    coverage: true,
  };
}

async function routeIngame(question: string, e: Entities, cue: MetricCue, coverage: CoverageLookup): Promise<Route | null> {
  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const league = e.league;
  const m = msg().route;
  const what = m.ingameStats(cue.mention);

  if (cue.askedMinute != null && cue.minute == null && isSnapshot(cue))
    return {
      kind: "missing",
      concepts: [m.minuteOnly(cue.mention, cue.askedMinute, MINUTES)],
      reason: m.minuteAbsent(cue.askedMinute),
    };

  const absent = await ingameAbsent(e, cue.mention, coverage);

  if (absent) return absent;

  const ranksTeams = e.teams.length === 0 && RANKING.test(question) && TEAM_WORDS.test(question);

  if (isDragonCue(cue) && !e.players.length && !e.champion && e.teams.length <= 1 && !ranksTeams) {
    const own = e.teams[0];

    if (own) {
      const asked = await coverage.team(own.members, league, e.yearFrom, e.yearTo);

      if (asked.ingame === 0 && (asked.games > 0 || (await coverage.team(own.members, null, null, null)).ingame === 0))
        return {
          kind: "missing",
          concepts: [m.ingameOf(what, own.team, league ? `${e.leagueShort}` : null)],
          reason: m.noRiotGamesOf(own.team),
          coverage: true,
        };
    }

    return {
      kind: "tool",
      call: { tool: "dragon_stats", input: { team: own?.team ?? null, league, ...period } },
      confidence: 0.85,
      reason: m.dragons(cue.mention),
      notes: league || own ? [] : [m.noLeagueDragons],
    };
  }

  if (e.players.length === 1 && e.teams.length === 0 && !e.champion) {
    const p = e.players[0].player;

    if (!cue.player) return { kind: "sql", reason: m.teamMetricForPlayer(cue.mention) };

    if ((await coverage.player(p, league, e.yearFrom, e.yearTo)).ingame === 0)
      return {
        kind: "missing",
        concepts: [m.ingameOf(what, p, league ? `${e.leagueShort}` : null)],
        reason: m.noRiotGamesOf(p),
        coverage: true,
      };

    return {
      kind: "tool",
      call: { tool: "player_ingame_stats", input: { player: p, league, ...period, metric: cue.player, minute: cue.minute } },
      confidence: 0.9,
      reason: m.playerIngame(cue.mention),
      notes: [],
    };
  }

  if (e.teams.length === 1 && e.players.length === 0 && !e.champion) {
    if (!cue.team) return { kind: "sql", reason: m.playerMetricForTeam(cue.mention) };

    const { team, members } = e.teams[0];
    const asked = await coverage.team(members, league, e.yearFrom, e.yearTo);

    if (asked.ingame === 0 && (asked.games > 0 || (await coverage.team(members, null, null, null)).ingame === 0))
      return {
        kind: "missing",
        concepts: [m.ingameOf(what, team, league ? `${e.leagueShort}` : null)],
        reason: m.noRiotGamesOf(team),
        coverage: true,
      };

    return {
      kind: "tool",
      call: { tool: "team_ingame_stats", input: { team, league, ...period, metric: cue.team, minute: cue.minute } },
      confidence: 0.85,
      reason: m.teamIngame(cue.mention),
      notes: [],
    };
  }

  if (e.players.length + e.teams.length === 0 && !e.champion && (RANKING.test(question) || (roleOf(question) && !TEAM_WORDS.test(question)))) {
    const asksTeams = TEAM_WORDS.test(question);

    if (isDragonCue(cue) && DRAGON_ELEMENT.test(question)) return { kind: "sql", reason: m.dragonElementRanking(cue.mention) };

    if ((asksTeams && cue.team == null) || (!asksTeams && cue.player == null && cue.team == null)) return { kind: "sql", reason: m.rankingUntyped(cue.mention) };
    const team = asksTeams || cue.player == null;
    const metric = team ? cue.team : cue.player;

    if (!metric) return null;
    const role = team ? null : (ROLE_CUES.find((r) => r.pattern.test(question))?.role ?? null);

    return {
      kind: "tool",
      call: { tool: "ingame_leaderboard", input: { subject: team ? "team" : "player", metric, minute: cue.minute, league, ...period, role, minGames: null, side: sideOf(question) } },
      confidence: 0.85,
      reason: m.ingameRanking(cue.mention),
      notes: league ? [] : [m.noLeagueIngameRanking],
    };
  }

  return { kind: "sql", reason: m.ingameUntyped(cue.mention) };
}

const TIMELINE = word(
  "timelines?|chronologie|d[ée]roul[ée](?:ment)?|minute par minute|minute by minute|courbes? d'or|courbes? de l'or|courbes? de gold|" +
    "graphiques? d'or|gold (?:graph|curve|chart)s?|[ée]volution de l'or|[ée]cart d'or (?:par minute|minute par minute|au fil)|" +
    "comment s'est (?:pass[ée]e?|d[ée]roul[ée]e?)|how did (?:the )?(?:game|match)|r[ée]sum[ée] de la (?:game|partie)",
);

const GAME_NUMBER = [
  /(?<![\p{L}\p{N}])(?:game|partie|manche|map)\s*(?:n[°o]\s*)?([1-5])(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])([1-5])\s*(?:e|ème|eme|er|re|nd|rd|th|st)?\s+(?:game|partie|manche|map)(?![\p{L}\p{N}])/iu,
];

const ORDINALS: [RegExp, number][] = [
  [word("premi[èe]re (?:game|partie|manche)|first game"), 1],
  [word("deuxi[èe]me (?:game|partie|manche)|seconde (?:game|partie|manche)|second game"), 2],
  [word("troisi[èe]me (?:game|partie|manche)|third game"), 3],
  [word("quatri[èe]me (?:game|partie|manche)|fourth game"), 4],
  [word("cinqui[èe]me (?:game|partie|manche)|fifth game|derni[èe]re (?:game|partie|manche) d'un bo5"), 5],
];

const PHASES: { phase: GamePhase; pattern: RegExp }[] = [
  { phase: "third_place", pattern: word("petite finale|(?:match pour la )?(?:3e|troisi[èe]me) place|third[- ]place") },
  { phase: "semifinal", pattern: word("demi[- ]?finales?|demi[- ]?finals?|demies?|demis?|semi[- ]?finales?|semi[- ]?finals?|semis?") },
  { phase: "quarterfinal", pattern: word("quarts?(?: de finale)?|quarter[- ]?finals?|quarters?") },
  { phase: "final", pattern: word("finales?|finals?|grand[- ]finals?") },
  { phase: "play_in", pattern: word("play[- ]?ins?") },
  { phase: "groups", pattern: word("phase de groupes?|groupes?|group stage|groups|swiss|ronde suisse") },
];

export function gameNumberOf(question: string): number | null {
  for (const re of GAME_NUMBER) {
    const m = re.exec(question);

    if (m) return Number(m[1]);
  }

  return ORDINALS.find(([re]) => re.test(question))?.[1] ?? null;
}

export const phaseOf = (question: string): GamePhase | null => PHASES.find((p) => p.pattern.test(question))?.phase ?? null;

function routeTimeline(question: string, e: Entities): Route | null {
  const game = gameNumberOf(question);
  const cue = TIMELINE.test(question);

  if (!cue && game == null) return null;

  if (e.players.length || e.champion) return null;

  if (e.teams.length === 0 && !(e.league && e.yearFrom != null)) return null;

  const year = e.yearFrom != null && e.yearFrom === e.yearTo ? e.yearFrom : (e.yearTo ?? e.yearFrom);

  return {
    kind: "tool",
    call: {
      tool: "game_timeline",
      input: { teamA: e.teams[0]?.team ?? null, teamB: e.teams[1]?.team ?? null, league: e.league, year, phase: phaseOf(question), game },
    },
    confidence: 0.9,
    reason: cue ? msg().route.gameTimeline : msg().route.gameByNumber,
    notes: e.teams.length > 2 ? [msg().route.onlyTwoTeamsKept(e.teams[0].team, e.teams[1].team)] : [],
  };
}

const STANDINGS_ONLY = word("palmar[eè]s|classements?|standings|podiums?|rankings?|tableau final|final standings|placements?");

const SERIES_WORDS = word(
  "bo ?[135]?|best[- ]of ?[135]?|s[ée]ries?|scores?|r[ée]sultats?|results?|qui a gagn[ée]|who won|vainqueurs?|gagnants?|winners?|gagn[ée]e?s?|won|" +
    "remport[ée]e?s?|perdu|lost|d[ée]tails?|picks?|bans?|drafts?|champions?|games?|parties|matchs?|grande|grand|petite",
);

const BEST_OF = word("bo ?[135]?|best[- ]of(?: ?[135])?");

function routeSeries(question: string, e: Entities): Route | null {
  const phase = phaseOf(question);
  const bestOf = !phase && e.teams.length >= 2 && (e.yearFrom != null || e.yearTo != null) ? BEST_OF.exec(question)?.[0] : null;

  if ((!phase && !bestOf) || e.players.length || e.champion) return null;

  if (e.teams.length === 0 && !e.league) return null;

  if (STANDINGS_ONLY.test(question) || POOL.test(question) || ROSTER.test(question) || detectMetric(question) || UNSUPPORTED.test(maskUnderstood(question, e).rest)) return null;

  const notes = e.teams.length > 2 ? [msg().route.onlyTwoTeamsKept(e.teams[0].team, e.teams[1].team)] : [];

  return {
    kind: "tool",
    call: { tool: "series", input: { teamA: e.teams[0]?.team ?? null, teamB: e.teams[1]?.team ?? null, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, phase, split: e.split } },
    confidence: 0.9,
    reason: phase
      ? msg().route.phaseSeries(PHASES.find((p) => p.phase === phase)!.pattern.exec(question)![0])
      : msg().route.twoTeamsSeries(`${bestOf}`),
    notes,
  };
}

export type Route =
  | { kind: "tool"; call: ToolCall; confidence: number; reason: string; notes: string[]; unread?: string[]; forced?: boolean }
  | { kind: "missing"; concepts: string[]; reason: string; coverage?: boolean }
  | { kind: "sql"; reason: string; open?: boolean; unread?: string[] }
  | { kind: "out_of_scope"; reason: string };

const WORLDS = "World Championship";

const COMPARISON_END_CUES = CHAMPION_AVERAGE_CUES.flatMap(([stat, re]) => {
  const end = COMPARISON_END_STATS.find((s) => s === stat);

  return end ? [[end, re] as const] : [];
});

type ComparedMetric = { metric: ComparisonMetric | null; minute: Minute | null; mention: string };

function comparedMetric(question: string, notes: string[]): ComparedMetric {
  const cue = detectMetric(question);

  if (cue && cue.askedMinute != null && cue.minute == null && isSnapshot(cue)) {
    notes.push(msg().route.snapshotMinutes(cue.mention, cue.askedMinute));

    return { metric: null, minute: null, mention: cue.mention };
  }

  if (cue?.player) return { metric: cue.player, minute: isSnapshot(cue) ? cue.minute : null, mention: cue.mention };

  if (cue) {
    notes.push(msg().route.teamStatNotCompared(cue.mention));

    return { metric: null, minute: null, mention: cue.mention };
  }

  const ends = COMPARISON_END_CUES.filter(([, re]) => re.test(question));

  return ends.length === 1 ? { metric: ends[0][0], minute: null, mention: ends[0][1].exec(question)![0] } : { metric: null, minute: null, mention: "" };
}

function comparisonRoute(question: string, e: Entities): Route {
  const [a, b] = e.players;
  const notes = e.players.length > 2 ? [msg().route.onlyTwoPlayers(a.player, b.player)] : [];
  const cue = OPPOSE.exec(question)?.[0];
  const { metric, minute, mention } = comparedMetric(question, notes);

  return {
    kind: "tool",
    call: { tool: "player_comparison", input: { playerA: a.player, playerB: b.player, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, metric, minute } },
    confidence: cue ? 0.95 : 0.9,
    reason: msg().route.twoPlayers(cue ?? null, metric ? `${mention}` : null),
    notes,
    forced: cue != null,
  };
}

function teamsRoute(question: string, e: Entities): Route {
  const [a, b] = e.teams;
  const cue = OPPOSE.exec(question)?.[0];

  return {
    kind: "tool",
    call: { tool: "head_to_head", input: { kind: "team", sideA: a.team, sideB: b.team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: 0.9,
    reason: msg().route.twoTeams(cue ?? null),
    notes: e.teams.length > 2 ? [msg().route.onlyTwoTeamsOpposed(a.team, b.team)] : [],
    forced: cue != null,
  };
}

function rosterRoute(question: string, e: Entities): Route {
  const cue = ROSTER.exec(question)?.[0];
  const role = teamRoleOf(maskUnderstood(question, e).rest);

  return {
    kind: "tool",
    call: { tool: "team_roster", input: { team: e.teams[0].team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split, role } },
    confidence: 0.9,
    reason: msg().route.roster(cue ?? null, role ?? null),
    notes: [],
    forced: true,
  };
}

function playerTeamRoute(e: Entities, rest: string, found: PlayerTeam): Route {
  const player = e.players[0].player;
  const cue = PLAYER_TEAM.exec(rest)![0];
  const asked = e.yearFrom != null || e.yearTo != null;
  const notes = [asked ? msg().route.playerTeamAsked(player, found.team) : msg().route.playerTeamLatest(player, found.team, found.year)];

  if (asked && found.others.length) notes.push(msg().route.playerTeamOthers(player, found.others.join(", ")));

  return {
    kind: "tool",
    call: {
      tool: "team_roster",
      input: { team: found.team, league: e.league, yearFrom: asked ? e.yearFrom : found.year, yearTo: asked ? e.yearTo : found.year, split: e.split, role: teamRoleOf(rest) },
    },
    confidence: 0.9,
    reason: msg().route.playerTeam(cue, found.team),
    notes,
    forced: true,
  };
}

function poolRoute(question: string, e: Entities): Route {
  const team = e.players.length === 0;
  const name = team ? e.teams[0].team : e.players[0].player;
  const notes: string[] = [];

  if (!team && e.teams.length) notes.push(msg().route.teamIgnoredPool(e.teams[0].mention, name));

  if (!e.league) notes.push(msg().route.noLeagueAll);

  const role = team ? roleOf(question) : null;

  if (role) notes.push(msg().route.roleNotFiltered);

  return {
    kind: "tool",
    call: { tool: "champion_pool", input: { subject: team ? "team" : "player", name, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split } },
    confidence: 0.9,
    reason: msg().route.pool(Boolean(team), POOL.exec(question)![0]),
    notes,
    forced: true,
  };
}

function playerRunesRoute(question: string, e: Entities): Route {
  const player = e.players[0].player;
  const notes: string[] = [];

  if (e.teams.length) notes.push(msg().route.teamIgnoredRunes(e.teams[0].mention, player));

  if (!e.league) notes.push(msg().route.noLeagueAll);

  return {
    kind: "tool",
    call: {
      tool: "player_runes",
      input: { player, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split, champion: e.champion?.champion ?? null, role: roleOf(question) },
    },
    confidence: 0.9,
    reason: msg().route.playerRunes(RUNES.exec(question)![0]),
    notes,
    forced: true,
  };
}

export const TEAM_CRITERION_CUES: [TeamCriterion, RegExp][] = [
  ["game_length", word("dur[ée]es?|durations?|longues?|courtes?|rapides?|lentes?|rapidement|vite|longest|shortest|fastest|slowest|long|short|fast|slow|game ?time|temps de jeu")],
  ["champions", word("champions? (?:diff[ée]rents?|uniques?|distincts?)|(?:different|unique|distinct) champions?|plus de champions|most champions|champion pools?|pools? de champions?|diversit[ée]")],
  ["void_grubs", word("grubs?|larves?|void ?grubs?")],
  ["heralds", word("h[ée]rauts?|heralds?")],
  ["dragons", word("dragons?|drakes?")],
  ["barons", word("barons?|nashors?")],
  ["towers", word("tou?rs|tourelles?|towers?|turrets?")],
  ["kda", word("kda")],
  ["deaths", word("morts?|deaths?|meurent|die")],
  ["kills", word("kills?|sanglantes?|bloodiest|tuent")],
  ["games", word("(?:le plus de|most) (?:parties|games|matchs)|(?:le plus|most) jou[ée]|played the most")],
  ["winrate", word("win ?rates?|taux de victoire|victoires?|wins?|gagn\\p{L}*|winning")],
];

const ASCENDING = word("courtes?|rapides?|rapidement|vite|shortest|fastest|short|fast|(?<!au )moins|(?<!at )least|fewest|lowest");

export const teamCriterionOf = (question: string): TeamCriterion | null => TEAM_CRITERION_CUES.find(([, re]) => re.test(question))?.[0] ?? null;

function teamLeaderboardRoute(question: string, e: Entities, criterion: TeamCriterion): Route {
  const side = sideOf(question);
  const order = ASCENDING.test(question) ? "asc" : "desc";

  return {
    kind: "tool",
    call: { tool: "team_leaderboard", input: { league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, criterion, order, side, minGames: minimumOf(question, "games") } },
    confidence: 0.85,
    reason: msg().route.teamRanking(criterion, order === "asc", side ?? null),
    notes: e.league ? [] : [msg().route.noLeagueWorldsRanking],
  };
}

export const MATCHUP = word(
  "match[- ]?ups?|counters?|contres?|contre (?:qui|quels? champions?|quoi)|face [àa] (?:qui|quels? champions?|quoi)|against (?:who|whom|which champions?|what champions?|what)|" +
    "adversaires? directs?|lane opponents?|vis[- ][àa][- ]vis|b[êe]tes? noires?|pires? adversaires?|meilleurs? adversaires?",
);

function matchupRoute(question: string, e: Entities): Route {
  const role = roleOf(question);
  const opponent = e.opponentChampion?.champion ?? null;
  const cue = MATCHUP.exec(question)?.[0] ?? VERSUS.exec(question)?.[0];

  return {
    kind: "tool",
    call: { tool: "champion_matchup", input: { champion: e.champion!.champion, opponent, role, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: 0.9,
    reason: msg().route.matchup(Boolean(opponent), `${cue}`),
    notes: e.league ? [] : [msg().route.noLeagueAll],
    forced: true,
  };
}

const SINGLE_GAME = word(
  "(?:en|sur|dans|lors d') ?(?:une|1) (?:seule |m[êe]me )?(?:partie|game|manche|map)|in (?:a|one|1) (?:single )?(?:game|match|map)|single[- ]game|" +
    "records?|meilleures? (?:parties?|games?|perfs?|performances?)|best (?:games?|performances?)|pires? (?:parties?|games?)",
);

export function recordMetricOf(question: string, cue: MetricCue | null): RecordMetric | null {
  if (cue) {
    const sort = cue.player ? CHAMPION_INGAME_SORT[cue.player] : undefined;

    return (sort === "gold_diff_15" || sort === "cs_diff_15") && (cue.askedMinute == null || cue.askedMinute === 15) ? sort : sort === "solo_kills" ? sort : null;
  }

  const asked = CHAMPION_AVERAGE_CUES.filter(([, re]) => re.test(question));

  return asked.length === 1 ? asked[0][0] : null;
}

function recordsRoute(e: Entities, metric: RecordMetric, role: ReturnType<typeof roleOf>): Route {
  const player = e.players[0]?.player ?? null;

  return {
    kind: "tool",
    call: { tool: "game_records", input: { metric, player, role: player ? null : role, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: 0.9,
    reason: msg().route.singleGameRecord(metric, player ?? null),
    notes: e.league ? [] : [msg().route.noLeagueAll],
    forced: true,
  };
}

export const RECENT = word(
  "formes?(?: r[ée]cente| actuelle| du moment)?|en forme|" +
    "(?:\\d{1,2} )?derni[èe]re?s? (?:\\d{1,2} )?(?:parties?|games?|matchs?|matches|rencontres?|manches?)|(?:parties?|games?|matchs?) r[ée]cente?s?|" +
    "last (?:\\d{1,2} )?(?:games?|matches|match)|recent (?:games?|matches|form|results?)|r[ée]cemment|recently|lately|en ce moment|right now|these days|ces derniers temps|ces temps-ci",
);

export function recentCountOf(question: string): number | null {
  const m = /(\d{1,2})\s+derni|derni\p{L}+\s+(\d{1,2})|last\s+(\d{1,2})/iu.exec(question);
  const n = Number(m?.slice(1).find(Boolean));

  return Number.isInteger(n) && n > 0 ? Math.min(20, Math.max(3, n)) : null;
}

function recentRoute(question: string, e: Entities): Route {
  const player = e.players[0].player;

  return {
    kind: "tool",
    call: { tool: "player_recent_games", input: { player, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, count: recentCountOf(question) } },
    confidence: 0.9,
    reason: msg().route.recentGames(RECENT.exec(question)![0]),
    notes: e.teams.length ? [msg().route.teamIgnoredRecent(e.teams[0].mention, player)] : [],
    forced: true,
  };
}

const RUNES = word("runes?|keystones?|pages? de runes?|rune ?pages?");

const CHAMPION_FOCUS_CUES: [ChampionFocus, RegExp][] = [
  ["items", word("items?|objets?|builds?|stuffs?|achats?")],
  ["runes", RUNES],
  ["spells", word("sorts?(?: d'invocateurs?)?|summoner spells?|summoners?|spells?")],
];

function championFocus(question: string): ChampionFocus | null {
  const named = CHAMPION_FOCUS_CUES.flatMap(([focus, re]) => {
    const at = question.search(re);

    return at < 0 ? [] : [{ focus, at }];
  }).sort((a, b) => a.at - b.at);

  return named[0]?.focus ?? null;
}

function championRoute(e: Entities, question: string): Route {
  return {
    kind: "tool",
    call: { tool: "champion_event_stats", input: { champion: e.champion!.champion, league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, focus: championFocus(question) } },
    confidence: 0.9,
    reason: msg().route.championAlone,
    notes: e.league ? [] : [msg().route.noLeagueWorldsSearch],
  };
}

async function routeByRules(question: string, e: Entities, schema: Record<string, string[]>, coverage: CoverageLookup): Promise<Route> {
  if (e.outOfScope)
    return { kind: "out_of_scope", reason: msg().route.notInScope(e.outOfScope) };
  const nEntities = e.players.length + e.teams.length + (e.champion ? 1 : 0);

  if (nEntities === 0 && !e.league && !LOL_DOMAIN.test(question) && !STANDINGS.test(question))
    return { kind: "out_of_scope", reason: msg().route.noEsport };

  const timeline = routeTimeline(question, e);

  if (timeline) return timeline;

  const missing = missingConcepts(question, schema);

  if (missing.length) return { kind: "missing", concepts: missing, reason: msg().route.missing(missing.join(", ")) };

  const series = routeSeries(question, e);

  if (series) return series;

  if (e.champion && !e.players.length && !e.teams.length && (MATCHUP.test(question) || (e.opponentChampion && VERSUS.test(question)))) return matchupRoute(question, e);

  const cue = detectMetric(question);
  const asksRecord = !e.champion && !e.teams.length && e.players.length <= 1 && SINGLE_GAME.test(question) && !LOWEST.test(question);
  const record = asksRecord ? recordMetricOf(question, cue) : null;

  if (asksRecord && PER_MINUTE.test(question)) return { kind: "sql", reason: msg().route.perMinuteRecord };

  if (record) return (cue && (await ingameAbsent(e, cue.mention, coverage))) ?? recordsRoute(e, record, roleOf(question));

  if (e.players.length >= 2 && OPPOSE.test(question)) return comparisonRoute(question, e);

  if (e.teams.length >= 2 && !e.players.length && OPPOSE.test(question)) return teamsRoute(question, e);

  if (e.players.length === 1 && !cue && RUNES.test(question)) return playerRunesRoute(question, e);

  if (!e.champion && !cue && (e.players.length === 1 || (e.players.length === 0 && e.teams.length === 1)) && POOL.test(question)) return poolRoute(question, e);

  if (e.players.length === 1 && !e.champion && !cue && RECENT.test(question)) return recentRoute(question, e);

  const rest = maskUnderstood(question, e).rest;

  const asksPlayerTeam =
    e.players.length === 1 && !e.teams.length && !e.champion && !cue && !NOT_ROSTER.test(rest) && !VERSUS.test(question) &&
    PLAYER_TEAM.test(rest) && !TEAM_RESULTS.test(rest) && !UNSUPPORTED.test(PLAYS_FOR.test(rest) ? rest.replace(WHICH_TEAM, " ") : rest);

  const playerTeam = asksPlayerTeam ? await coverage.playerTeam?.(e.players[0].player, e.league, e.yearFrom, e.yearTo, e.split) : null;
  const ofPlayerTeam = playerTeam ? playerTeamRoute(e, rest, playerTeam) : null;

  if (ofPlayerTeam?.kind === "tool" && unreadWords(question, e, ofPlayerTeam.call).words.length === 0) return ofPlayerTeam;

  const oneTeam = e.teams.length === 1 && !e.players.length && !e.champion && !NOT_ROSTER.test(rest) && !cue;

  if (oneTeam && (ROSTER.test(question) || (teamRoleOf(rest) && !RANKING.test(rest) && !COMPARE.test(question) && !HISTORY_WORDS.test(question) && !UNSUPPORTED.test(rest))))
    return rosterRoute(question, e);

  const noEntity = e.players.length + e.teams.length === 0 && !e.champion;

  if (e.champion && !e.players.length && !e.teams.length && (!cue || PROFILE_INGAME.has(`${cue.player}@${cue.askedMinute ?? 15}`))) return championRoute(e, question);

  if (noEntity && CHAMPION_DRAGON_KILLS.test(question) && !NOT_CHAMPION_RANKING.test(question)) {
    if (TEAM_WORDS.test(question)) return { kind: "sql", reason: msg().route.championFigureUnsorted("dragons") };
    const concept = msg().route.championDragonKills;

    return { kind: "missing", concepts: [concept], reason: msg().route.missing(concept) };
  }

  const teamCriterion = noEntity && !cue && TEAM_WORDS.test(question) && RANKING.test(question) && !PLAYER_WORDS.test(question) ? teamCriterionOf(question) : null;

  if (teamCriterion) return teamLeaderboardRoute(question, e, teamCriterion);

  if (noEntity && CHAMPION_RANKING.test(question) && !NOT_CHAMPION_RANKING.test(question)) {
    const figure = cue?.mention ?? CHAMPION_UNRANKED.exec(question)?.[0];
    const average = cue ? null : championAverageSortOf(question);
    const extra = championExtraSortOf(question, cue);
    const total = championTotalSortOf(question, cue);

    if (total && !CHAMPION_OTHER_FIGURES.test(question)) return (cue && (await ingameAbsent(e, cue.mention, coverage))) ?? championRankingRoute(question, e, total, true);

    if (extra && !CHAMPION_OTHER_FIGURES.test(question)) return (cue && (await ingameAbsent(e, cue.mention, coverage))) ?? championRankingRoute(question, e, extra);

    if (average && !CHAMPION_OTHER_FIGURES.test(question)) return championRankingRoute(question, e, average);

    if (figure) return { kind: "sql", reason: msg().route.championFigureUnsorted(figure) };

    if (LOWEST.test(question)) return { kind: "sql", reason: msg().route.championLowest };

    return championRankingRoute(question, e);
  }

  const role = roleOf(question);
  const ranksPlayers = role != null || PLAYER_WORDS.test(question);
  const forPlayers = !e.teams.length && !e.champion && (noEntity || (e.players.length === 1 && role != null));

  if (noEntity && ranksPlayers && WORST.test(question))
    return (cue && (await ingameAbsent(e, cue.mention, coverage))) ?? { kind: "sql", reason: msg().route.playerLowest };

  if (
    forPlayers && !cue && (RANKING.test(question) || (ranksPlayers && COMPARE.test(question))) && !TEAM_WORDS.test(withoutTeamShare(question)) &&
    (ranksPlayers || !STANDINGS.test(question)) && (ranksPlayers || PLAYER_CRITERION_CUES.some(([, re]) => re.test(question)))
  )
    return playerLeaderboardRoute(question, e);

  const ingame = cue ? await routeIngame(question, e, cue, coverage) : null;

  if (ingame) return ingame;

  if (UNSUPPORTED.test(question))
    return { kind: "sql", reason: msg().route.unsupported(UNSUPPORTED.exec(question)![0]) };

  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const notes: string[] = [];

  const defaultLeague = () => {
    if (e.league) return e.league;
    notes.push(msg().route.noLeagueWorldsSearch);

    return WORLDS;
  };

  const versus = VERSUS.test(question);

  if (e.players.length >= 2) return comparisonRoute(question, e);

  if (e.teams.length >= 2) return teamsRoute(question, e);

  if (e.players.length === 1 && e.teams.length === 1 && versus)
    return { kind: "sql", reason: msg().route.playerVersusTeam };

  if (e.champion && (e.players.length || e.teams.length))
    return { kind: "sql", reason: msg().route.championOfOne };

  if (e.players.length === 1) {
    if (e.teams.length) notes.push(msg().route.teamIgnoredHistory(e.teams[0].mention, e.players[0].player));

    return {
      kind: "tool",
      call: { tool: "player_event_history", input: { player: e.players[0].player, league: defaultLeague(), ...period } },
      confidence: versus ? 0.7 : 0.95,
      reason: versus ? msg().route.onePlayerVersus : msg().route.playerHistory,
      notes,
    };
  }

  if (e.teams.length === 1)
    return {
      kind: "tool",
      call: { tool: "team_history", input: { team: e.teams[0].team, league: e.league, ...period } },
      confidence: versus ? 0.7 : 0.9,
      reason: versus ? msg().route.oneTeamVersus : msg().route.teamAlone,
      notes,
    };

  if (e.league || STANDINGS.test(question)) {
    const league = defaultLeague();
    const oneYear = e.yearFrom != null && e.yearFrom === e.yearTo;
    const oneEdition = league === "KeSPA Cup" || LEAGUES.some((l) => l.name === league && l.international);

    return {
      kind: "tool",
      call: { tool: "tournament_standings", input: { league, ...period, split: e.split, full: oneYear && (oneEdition || e.split != null) } },
      confidence: STANDINGS.test(question) || oneYear ? 0.9 : 0.75,
      reason: msg().route.leagueAlone,
      notes,
    };
  }

  return { kind: "sql", reason: msg().route.noMatchingTool, open: true };
}

const FUNCTION_WORDS = new Set(
  (
    "a au aux de des du le la les un une et ou en dans sur pour par avec ce cet cette ces ne pas qu que qui quoi quel quelle quels quelles " +
    "est sont ete etait ont avait avaient il elle ils elles on se sa son ses leur leurs tous toutes tout toute chaque comment combien fois " +
    "quand the of at in on all by for with from to and an is are was were be been has have had do does did done what which who whom how " +
    "many much when where every each it its their his her this that these those me moi nous je tu donne donner montre montrer dis show " +
    "give tell please stp svp depuis since apres after avant before until jusqu jusque entre between fait faire font prend prennent pris " +
    "eu avoir etre get got take takes took about chez lors pendant during annee annees saison saisons year years season seasons " +
    "lol league legends"
  ).split(/\s+/),
);

const HISTORY_WORDS = word(
  "r[ée]sultats?|results?|parcours|historique|history|bilan|records?|perfs?|performances?|palmar[eè]s|stats?|statistiques?|carri[èe]re|career|" +
    "runs?|titres?|titles?|troph[ée]es?|gagn[ée]e?s?|won|wins?|victoires?|d[ée]faites?|losses|classements?|places?|[ée]ditions?|" +
    "champions? jou[ée]s?|jou[ée]e?s?|played",
);

const INGAME_WORDS = word(
  "stats?|statistiques?|moyen(?:ne)?s?|average|par (?:partie|game|match)|per game|in-?game|joueurs?|players?|total|nombre|min(?:ute)?s?|profil|pos[ée]e?s?|placed",
);

const GAME_WORDS = word("matchs?|games?|parties?|manches?|maps?|duels?|s[ée]ries?|rencontres?|face ?[àa] ?face");

const TOOL_WORDS: Record<ToolName, RegExp[]> = {
  player_event_history: [HISTORY_WORDS],
  team_history: [HISTORY_WORDS],
  team_roster: [
    ROSTER,
    ...TEAM_ROLE_CUES.map((r) => word(r.words)),
    ...SPLIT_CUES.map((c) => c.pattern),
    word("jou[ée]e?s?|jouait|jouaient|played|play(?:s|ed|ing)? (?:for|on|with)|joueurs?|players?|[ée]quipes?|teams?|co[ée]quipiers?|team ?mates?|partenaires?|chez|liste|list|actuel(?:le)?s?|current|now|maintenant|aujourd'hui|today|c'est"),
  ],
  head_to_head: [OPPOSE, VERSUS, HISTORY_WORDS, GAME_WORDS],
  player_comparison: [OPPOSE, VERSUS, HISTORY_WORDS, INGAME_WORDS, GAME_WORDS, ...COMPARISON_END_CUES.map(([, re]) => re), ...ROLE_CUES.map((r) => r.pattern), word("m[êe]me (?:lane|poste|r[ôo]le)|same (?:lane|role)|lanes?|laners?|postes?|r[ôo]les?")],
  champion_event_stats: [
    word(
      "stats?|statistiques?|(?:pick|ban|win) ?rates?|picks?|bans?|bannie?s?|taux de (?:victoire|pick|ban|pr[ée]sence|s[ée]lection)|pr[ée]sence|presence|" +
        "priorit[ée]|jou[ée]e?s?|played|champion|r[ée]sultats?|results?|bilan|victoires?|d[ée]faites?|wins?|losses|forte?s?|strong|bons?|good|m[ée]ta|" +
        "kda|moyen(?:ne)?s?|averages?|or|gold|golds|cs|farm|d[ée]g[âa]ts|damages?|vision|kills?|morts?|deaths?|assists?|[ée]carts?|diff|" +
        "joueurs?|players?|meilleurs?|best|qui (?:le )?joue(?:nt)?|who plays?|mains?|onetricks?|r[ôo]les?|postes?|lanes?|sur|on|avec|with|" +
        "items?|objets?|builds?|stuffs?|achats?|ach[eè]te(?:nt)?|pris|prend|construits?|built|" +
        "runes?|keystones?|pages? de runes|sorts?(?: d'invocateurs?)?|summoner spells?|summoners?|spells?",
    ),
    ...ROLE_CUES.map((r) => r.pattern),
  ],
  champion_ranking: [
    CHAMPION_RANKING,
    ...CHAMPION_SORT_CUES.map(([, re]) => re),
    ...CHAMPION_AVERAGE_CUES.map(([, re]) => re),
    PER_GAME,
    PER_MINUTE,
    MOST_PLAYERS,
    TOTAL,
    MINUTE,
    ...SIDE_CUES.map(([, re]) => re),
    ...SPLIT_CUES.map((c) => c.pattern),
    ...ROLE_CUES.map((r) => r.pattern),
    word(
      "champions?|champs?|classement|ranking|top|liste|list|stats?|statistiques?|en|in|au|at|lanes?|postes?|r[ôo]les?|joueurs?|players?|diff[ée]rents?|different|souvent|often|" +
        "parties|games|matchs|matches|au moins|at least|minimum|plus de|more than|over",
    ),
  ],
  champion_pool: [
    POOL,
    ...SPLIT_CUES.map((c) => c.pattern),
    word(
      "champions?|champs?|jou[ée]e?s?|joue(?:nt)?|jouait|played|plays?|picks?|pick[ée]s?|stats?|statistiques?|win ?rates?|kda|bilan|r[ée]sultats?|" +
        "victoires?|d[ée]faites?|liste|list|diversit[ée]|vari[ée]t[ée]|uniques?|diff[ée]rents?|souvent|often|carri[èe]re|career|en|in|au|at",
    ),
  ],
  player_runes: [
    RUNES,
    ...SPLIT_CUES.map((c) => c.pattern),
    ...ROLE_CUES.map((r) => r.pattern),
    word(
      "pages?|arbres?|trees?|fragments?|shards?|primaires?|primary|secondaires?|secondary|stats?|statistiques?|sur|on|avec|with|jou[ée]e?s?|played|" +
        "pris|prend|prises?|takes?|took|utilis[ée]e?s?|used|uses?|quels?|quelles?|which|what|en|in|au|aux|at|win ?rates?|victoires?|wins?|" +
        "(?:les? |la )?plus (?:fr[ée]quente?s?|jou[ée]e?s?|utilis[ée]e?s?)|most (?:frequent|common|used|played)|souvent|often|pr[ée]f[ée]r[ée]e?s?|favou?rites?|carri[èe]re|career",
    ),
  ],
  player_leaderboard: [
    ...ROLE_CUES.map((r) => r.pattern),
    RANKING,
    COMPARE,
    PLAYER_WORDS,
    ...PLAYER_CRITERION_CUES.map(([, re]) => re),
    ...SIDE_CUES.map(([, re]) => re),
    ...SPLIT_CUES.map((c) => c.pattern),
    word(
      "du monde|in the world|de tous les temps|of all time|all[- ]time|ever|selon|crit[èe]res?|en termes de|in terms of|stats?|statistiques?|" +
        "jou[ée]e?s?|played|parties|games|matchs|par minute|per minute|au moins|at least|minimum|plus de|more than|over|avec|with|" +
        "postes?|r[ôo]les?|lanes?|classement|ranking|liste|list|gros(?:se)?s?|grande?s?|biggest|largest|(?:de|d') ?(?:son|leur|l') ?[ée]quipe|of (?:his|their|the) team",
    ),
  ],
  tournament_standings: [
    STANDINGS,
    ...SPLIT_CUES.map((s) => s.pattern),
    word(
      "r[ée]sultats?|results?|[ée]quipes?|teams?|champions? (?:du monde|d'europe|de cor[ée]e|de chine)|world champions?|titres?|titles?|gagn[ée]e?s?|won|" +
        "wins?|remport[ée]e?s?|finalistes?|[ée]ditions?|complet|full|historique|history|bilan",
    ),
  ],
  player_ingame_stats: [MINUTE, INGAME_WORDS],
  team_ingame_stats: [MINUTE, INGAME_WORDS, TEAM_WORDS],
  dragon_stats: [
    INGAME_WORDS,
    TEAM_WORDS,
    DRAGON_ELEMENT,
    word(
      "dragons?|drakes?|[âa]mes?|souls?|types?|[ée]l[ée]ments?|[ée]l[ée]mentaires?|pris|prises?|prend|prennent|taken|takes?|combien|how many|quels?|quelles?|which|" +
        "taux de victoire|win ?rates?|victoires?|wins?|gagn[ée]e?s?|won|avec|with|r[ée]partition|distribution|plus|most|souvent|often",
    ),
  ],
  ingame_leaderboard: [MINUTE, RANKING, INGAME_WORDS, TEAM_WORDS, ...SIDE_CUES.map(([, re]) => re), word("souvent|often")],
  team_leaderboard: [
    RANKING,
    TEAM_WORDS,
    ...TEAM_CRITERION_CUES.map(([, re]) => re),
    ASCENDING,
    PER_GAME,
    GAME_WORDS,
    ...SIDE_CUES.map(([, re]) => re),
    word("classement|ranking|liste|list|stats?|statistiques?|au moins|at least|minimum|plus de|more than|over|avec|with|jou[ée]e?s?|played|pris|prend|prennent|taken|takes?"),
  ],
  champion_matchup: [
    MATCHUP,
    VERSUS,
    OPPOSE,
    GAME_WORDS,
    ...ROLE_CUES.map((r) => r.pattern),
    word(
      "champions?|champs?|stats?|statistiques?|win ?rates?|taux de victoire|victoires?|d[ée]faites?|wins?|losses|gagne(?:nt)?|perd(?:ent)?|bat(?:tent)?|beats?|loses?|" +
        "le plus|most|souvent|often|bilan|r[ée]sultats?|results?|lanes?|postes?|r[ôo]les?|en|in|au|at|fort|strong|bon|good",
    ),
  ],
  game_records: [
    SINGLE_GAME,
    RANKING,
    PLAYER_WORDS,
    ...CHAMPION_AVERAGE_CUES.map(([, re]) => re),
    ...ROLE_CUES.map((r) => r.pattern),
    MINUTE,
    word("historique|history|all[- ]time|de tous les temps|of all time|ever|absolu|nombre|number|total|performances?|perfs?|en termes de|in terms of"),
  ],
  player_recent_games: [
    RECENT,
    HISTORY_WORDS,
    GAME_WORDS,
    word("comment|how|joue|plays?|playing|va|doing|niveau|level|actuel(?:le)?s?|current|liste|list|montre|show"),
  ],
  series: [...PHASES.map((p) => p.pattern), SERIES_WORDS, VERSUS, OPPOSE, GAME_WORDS, ...SPLIT_CUES.map((c) => c.pattern)],
  game_timeline: [TIMELINE, ...GAME_NUMBER, ...ORDINALS.map(([pattern]) => pattern), ...PHASES.map((p) => p.pattern), VERSUS, GAME_WORDS],
};

const fold = (text: string) => text.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function unreadWords(question: string, e: Entities, call: ToolCall | null) {
  const understood = maskUnderstood(question, e);
  let { rest, read } = understood;

  const take = (pattern: RegExp) => {
    rest = rest.replace(new RegExp(pattern.source, "giu"), (m) => {
      read++;

      return " ".repeat(m.length);
    });
  };

  if (call) {
    const ingame =
      ["player_ingame_stats", "team_ingame_stats", "dragon_stats", "ingame_leaderboard", "champion_ranking", "game_records"].includes(call.tool) ||
      (call.tool === "player_comparison" && call.input.metric != null);

    const cue = ingame ? detectMetric(question) : null;

    if (cue) take(word(cue.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    if (call.tool === "ingame_leaderboard" && call.input.role) for (const r of ROLE_CUES) take(r.pattern);

    for (const pattern of TOOL_WORDS[call.tool]) take(pattern);
  }

  const words = rest.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !/^\d+$/.test(w) && !FUNCTION_WORDS.has(fold(w)));

  return { words, share: words.length ? words.length / (words.length + read) : 0 };
}

export const UNREAD_THRESHOLD = 0.25;

const UNSURE = 0.5;

export async function routeQuestion(question: string, e: Entities, schema: Record<string, string[]>, coverage: CoverageLookup): Promise<Route> {
  const route = await routeByRules(question, e, schema, coverage);

  if (route.kind === "sql" && route.open) {
    const { words } = unreadWords(question, e, null);

    return words.length ? { ...route, unread: words } : route;
  }

  if (route.kind !== "tool") return route;
  const { words, share } = unreadWords(question, e, route.call);

  if (share < UNREAD_THRESHOLD) return route;

  if (route.forced) return { ...route, unread: words, reason: msg().route.unreadIgnored(route.reason, words.join(", ")) };

  return {
    ...route,
    confidence: Math.min(route.confidence, UNSURE),
    unread: words,
    reason: msg().route.unreadShare(route.reason, Math.round(100 * share), words.join(", ")),
  };
}

export function toolPlan(tool: BoundTool, attempt: number, relaxed: string[] = []): QueryPlan {
  return { intent: tool.call.tool, tool, sql: tool.sql, params: tool.params, attempt, relaxed };
}


export async function schemaPrompt(db: Db): Promise<string> {
  return Object.entries(allowedSchema(await readSchema(db), VIEWS))
    .map(([t, cols]) => `${t}(${cols.join(", ")})`)
    .join("\n");
}

const sqlRules = (language: string) =>
  "PostgreSQL dialect. One read-only SELECT statement, no trailing semicolon, no server function (pg_*, set_config...). " +
  "Text matches exactly: use ILIKE for a case-insensitive match. Flags (win, has_ingame, first_*) are 0/1 integers: compare them with = 1 and SUM them. " +
  "Every column selected beside an aggregate is in the GROUP BY. Order a column that can be NULL with NULLS LAST. " +
  "In-game stats come from Riot game data and only exist for some games: v_game_player_stats (one row per player and game: " +
  "gold/xp/cs at 10, 15 and 20 minutes and their difference with the lane opponent, kills_10/deaths_10/assists_10 before 10:00, solo_kills, " +
  "first_blood_kill/assist/victim, double to penta kills, wards, control_wards, plates) and v_game_team_stats (one row per team and game: first_* objectives as 0/1, " +
  "team gold and gold difference at 10/15/20, kills_10/15/20, plates, elder_dragons, dragon_soul = 1 when the team got the dragon soul and NULL when " +
  "the game has no timeline or predates the soul (2020), soul = its element). v_game_dragons has one row per dragon kill of a game with a Riot timeline: " +
  "team, opponent, win, seq (order in the game), team_seq (order among the team's dragons), dragon ('infernal', 'ocean', 'mountain', 'cloud', 'hextech', " +
  "'chemtech', 'elder'; NULL before 2016), time_s. v_ingame_coverage gives games and ingame_games per league and year: " +
  "the LPL (Tencent LoL Pro League) has none. If the question needs in-game stats for a scope whose ingame_games is 0, set `missing`. " +
  "End-of-game objective counts (dragons, barons, towers, heralds, void grubs, inhibitors) are in v_games for every league. " +
  "v_series_results lists the series Leaguepedia only has on its match schedule, without any game: team1, team2, winner, " +
  "team1_score, team2_score, forfeited_by (the team that forfeited, NULL when played). A count of series or a series record adds them " +
  "to the series of v_games (one tab's match_n of one tournament_page); they have no game statistic. " +
  "Summoner spells are v_game_players.spell1 and spell2 (every game; the pair is stored in alphabetical order, so 'Flash' + 'Teleport' is " +
  "spell1 = 'Flash' AND spell2 = 'Teleport'). Runes: v_game_players.keystone (from 2018) and v_player_runes, one row per rune of a page " +
  "(kind 'keystone', 'primary', 'secondary' or 'shard'; tree; whole pages from 2020, the keystone alone before), joined on game_id and player. " +
  "Use only these views and columns (no other table). " +
  "A ranking by an average, a rate or a ratio (per game, per minute, win rate, KDA) needs a minimum sample: add HAVING COUNT(*) >= 5 " +
  "(or the minimum the question sets), select that count as a column, and return the top 10 rather than one row, even when the question asks for a single name. " +
  "Player names are Leaguepedia page names (v_game_players.player); league values are Leaguepedia League names (e.g. 'World Championship'). " +
  "A role is one of 'Top', 'Jungle', 'Mid', 'Bot', 'Support' (an ADC is 'Bot'). " +
  "A split (Winter, Spring, Summer...) is v_tournaments.split, read through tournament_page: " +
  "tournament_page IN (SELECT tournament_page FROM v_tournaments WHERE split = 'Spring'). " +
  `Exclude stage = 'qualifier' unless asked; stage = 'event' rows only hold standings. Keep the result under ${MAX_ROWS} rows. ` +
  "A stage of the bracket (final, semifinal, quarterfinal) is v_games.tab ('Finals', 'Semifinals', 'Quarterfinals'), never a tournament name: " +
  "a tournament named 'Regional Finals' is a regional qualifier, not the final of the international event. " +
  "If the answer needs data that no listed column holds (for example MVP awards), " +
  "do not approximate it with other columns and do not return a constant: set sql to an empty string and name the missing data, " +
  `in ${language}, in \`missing\`. Otherwise \`missing\` is empty. \`explanation\` is one short sentence.`;

const SqlOutput = z.object({ sql: z.string(), explanation: z.string(), missing: z.array(z.string()) });

const ALWAYS_FALSE = /\b(?:0\s*=\s*1|1\s*=\s*0)\b|\bwhere\s+(?:false|0)\b/i;

function generatedGaps(reply: { sql: string; missing: string[] }): string[] {
  if (reply.missing.length) return reply.missing;

  return !reply.sql || ALWAYS_FALSE.test(reply.sql) ? [msg().route.readNothing] : [];
}

async function askSql(db: Db, prompt: string, functionId: "generate-sql" | "repair-sql") {
  const llm = getLlm();

  if (!llm) return null;

  const { output } = await generateText({
    model: llm.model,
    output: Output.object({ schema: SqlOutput }),
    instructions: `${sqlRules(msg().route.promptLanguage)}\nSchema:\n${await schemaPrompt(db)}`,
    prompt,
    telemetry: { functionId },
    maxOutputTokens: LLM_CALL.maxOutputTokens,
    maxRetries: LLM_CALL.maxRetries,
    abortSignal: llmSignal(LLM_CALL.timeoutMs),
  });

  return { ...output, sql: output.sql.replace(/^```\w*\n?|```$/g, "").trim(), model: llm.id };
}

const entitySummary = (e: Entities) =>
  JSON.stringify({
    players: e.players.map((p) => p.player),
    teams: e.teams.map((t) => t.members),
    champion: e.champion?.champion ?? null,
    league: e.league,
    yearFrom: e.yearFrom,
    yearTo: e.yearTo,
    split: e.split,
  });

type BuildInput = { db: Db; question: string; entities: Entities; route: Route };

export type BuildResult = { plan: QueryPlan; notes: string[] } | { plan: null; missing: string[]; notes: string[] };

const rulesRouter: Decider<BuildInput, BuildResult> = {
  level: "rules",
  name: "outil typé",
  run: async ({ db, route }) => {
    if (route.kind !== "tool") return null;

    return {
      result: { plan: toolPlan(await bindTool(db, route.call), 1), notes: route.notes },
      confidence: route.confidence,
      level: "rules",
      reason: route.reason,
    };
  },
};

const UNREAD_RULES =
  " The rule-based router matched the names but could not read the words listed below, so its pick is in doubt: check it against those words. " +
  "A tool only filters on the arguments of its schema and only returns what its description says. " +
  "If a listed word is a misspelt name or a nickname of a player or a team, call the fitting tool with the correct name. " +
  "If the listed words ask for a filter or a result that no tool has (who plays a role or a roster, " +
  "a ranking of champions or players, personal details...), call no tool: " +
  "a SQL query is then generated, which is the expected outcome and not a failure. Never answer a different question with a tool.";

export type GroundedCall = { call: ToolCall | null; dropped: string | null };

export async function groundLeague(db: Db, call: ToolCall, e: Entities, route: Route, coverage: CoverageLookup): Promise<GroundedCall> {
  const league = "league" in call.input ? call.input.league : null;
  const kept: GroundedCall = { call, dropped: null };

  if (!league || e.league || e.players.length + e.teams.length === 0) return kept;

  const games = async (inLeague: string | null) => {
    const counted = await Promise.all([
      ...e.players.map((p) => coverage.player(p.player, inLeague, e.yearFrom, e.yearTo)),
      ...e.teams.map((t) => coverage.team(t.members, inLeague, e.yearFrom, e.yearTo)),
    ]);

    return counted.reduce((n, c) => n + c.games, 0);
  };

  if ((await games(league)) > 0 || (await games(null)) === 0) return kept;

  const rules = route.kind === "tool" && route.call.tool === call.tool && "league" in route.call.input ? route.call.input.league : null;

  if (rules === league) return kept;
  const grounded = await withLeague(db, call, rules);

  return { call: grounded, dropped: league };
}

const llmRouter: Decider<BuildInput, BuildResult> = {
  level: "llm",
  name: "choix d'outil",
  run: async ({ db, question, entities, route }) => {
    const llm = getLlm();

    if (!llm || (route.kind === "sql" && !route.open)) return null;

    const unread = route.kind === "tool" || route.kind === "sql" ? (route.unread ?? []) : [];
    const rulesPick = route.kind === "tool" ? ` They picked ${route.call.tool} ${JSON.stringify(route.call.input)}.` : "";

    const { toolCalls } = await generateText({
      model: llm.model,
      tools: aiTools,
      toolChoice: "auto",
      instructions:
        "Pick the one tool that answers the League of Legends esports question exactly, with its arguments. " +
        "If no tool answers it exactly (other metrics such as end-of-game kills, durations, objective counts, or open rankings), call no tool. " +
        "Only filter on a competition, a period or a split that the question states: otherwise keep the resolved ones, null when there is none." +
        (unread.length ? UNREAD_RULES : ""),
      prompt:
        `Question: ${question}\nResolved entities: ${entitySummary(entities)}` +
        (unread.length ? `\nWords the rules could not read: ${unread.join(", ")}.${rulesPick}` : ""),
      telemetry: { functionId: "pick-tool" },
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: llmSignal(LLM_CALL.timeoutMs),
    });

    const typed = toolCalls.find((c) => !c.dynamic);

    if (!typed || typed.dynamic) return null;
    const picked = await normalizeToolCall(db, typed);

    if (!picked) return null;
    const { call, dropped } = await groundLeague(db, picked, entities, route, coverageLookup(db));

    if (!call) return null;
    const said = msg().route.modelSays(llm.id, `${picked.tool}(${JSON.stringify(picked.input)})`);

    return {
      result: { plan: toolPlan(await bindTool(db, call), 1), notes: route.kind === "tool" && route.call.tool === call.tool ? route.notes : [] },
      confidence: 0.85,
      level: "llm",
      reason: dropped ? `${said} ; ${msg().route.leagueDropped(dropped)}` : said,
    };
  },
};

const textToSqlDecider: Decider<BuildInput, BuildResult> = {
  level: "llm",
  name: "text-to-SQL",
  run: async ({ db, question, entities }) => {
    const reply = await askSql(db, `Question: ${question}\nResolved entities: ${entitySummary(entities)}`, "generate-sql");

    if (!reply) return null;
    const gaps = generatedGaps(reply);

    if (gaps.length) return { result: { plan: null, missing: gaps, notes: [] }, confidence: 0.8, level: "llm", reason: msg().route.modelSays(reply.model, msg().route.dataAbsent) };

    return {
      result: { plan: { intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: 1, relaxed: [] }, notes: [] },
      confidence: 0.6,
      level: "llm",
      reason: msg().route.modelSays(reply.model, reply.explanation),
    };
  },
};

export function buildQuery(input: BuildInput) {
  return decide(input, [rulesRouter, llmRouter, textToSqlDecider], { threshold: 0.8 });
}

export type CorrectInput = {
  db: Db;
  question: string;
  entities: Entities;
  plan: QueryPlan;
  problem: Problem;
  by: Correction;
};

type Fix = { plan: QueryPlan; note?: string };

const rulesCorrector: Decider<CorrectInput, Fix> = {
  level: "rules",
  name: "corrections déterministes",
  run: async ({ entities, plan, by }) => {
    if (by !== "relax" || !plan.tool) return null;
    const next = plan.tool.relaxations(entities).find((r) => !plan.relaxed.includes(r.key));

    if (!next) return null;

    return {
      result: { plan: toolPlan(await next.next(), plan.attempt + 1, [...plan.relaxed, next.key]), note: next.note },
      confidence: 0.85,
      level: "rules",
      reason: next.reason,
    };
  },
};

const llmCorrector: Decider<CorrectInput, Fix> = {
  level: "llm",
  name: "réparation SQL",
  run: async ({ db, question, plan, problem, by }) => {
    if (by !== "repair") return null;

    const reply = await askSql(
      db,
      `Question: ${question}\nThis query ${problem.kind === "empty" ? "returned no rows" : "was rejected"}:\n${plan.sql}\n` +
        `Parameters: ${JSON.stringify(plan.params)}\nProblem: ${problem.message}\n` +
        "Return a corrected query. Inline the parameter values as literals.",
      "repair-sql",
    );

    if (!reply || generatedGaps(reply).length) return null;

    return {
      result: { plan: { ...plan, intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: plan.attempt + 1 } },
      confidence: 0.6,
      level: "llm",
      reason: msg().route.modelSays(reply.model, reply.explanation),
    };
  },
};

export function correctQuery(input: CorrectInput) {
  return decide(input, [rulesCorrector, llmCorrector], { threshold: 0.75 });
}
