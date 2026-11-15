import { leagueMembers } from "../domain/leagues";
import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSchema, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema, VIEWS, MAX_ROWS } from "./guard";
import { getLlm, LLM_CALL, llmSignal } from "./llm";
import { aiTools, type BoundTool, bindTool, type ChampionSort, type GamePhase, normalizeToolCall, type PlayerCriterion, type ToolCall } from "./tools";
import { detectMetric, type MetricCue, MINUTE } from "./metrics";
import { ROLE_CUES as ROLES, roleOf, TEAM_ROLE_CUES, teamRoleOf } from "./roles";
import type { Entities, QueryPlan, ToolName } from "./types";
import { CHAMPION_POOL, LOL_DOMAIN, maskUnderstood, SPLIT_CUES } from "./understand";

// Rules router ----------------------------------------------------------------------

const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

const VERSUS = word("vs\\.?|versus|contre|face [àa]|against|head[- ]to[- ]head|h2h|confrontations?|affrontements?");

/**
 * Words that set two sides against each other, in French and English (case-insensitive). With two
 * players they all give the same answer, the comparison: their games against each other when there
 * are some, their statistics in the scope, and the list of those games.
 */
export const OPPOSE = word(
  "compar(?:er|ez|e|es|aisons?|ing|ed|ison|isons)|vs\\.?|versus|contre|against|face[- ][àa][- ]face|or|ou|" +
    "who(?:'s| is) (?:the )?better|qui est (?:le |la )?meilleure?|meilleure?s?|better|best|mieux|diff[ée]rences?|differences?|" +
    "head[- ]?(?:to|2)[- ]?head|h2h|confrontations?|affrontements?|duels?|rencontres?|l'un contre l'autre|against each other|" +
    "(?:matchs?|games?|parties|s[ée]ries?) (?:entre|between)",
);

const STANDINGS = word(
  "palmar[eè]s|vainqueurs?|gagnants?|winners?|qui a gagn[ée]|who won|classements?|standings|podium|sacr[ée]s?|finale",
);

/** Metrics and open rankings no typed tool computes: they go to text-to-SQL. */
const UNSUPPORTED = word(
  "kills?|kda|morts?|deaths?|assists?|pentakills?|quadrakills?|gold|golds|cs|farm|d[ée]g[âa]ts|damage|vision|wards?|" +
    "dragons?|drakes?|barons?|heralds?|nashor|towers?|tourelles?|dur[ée]e|duration|plus longue?s?|plus courte?s?|" +
    "moyenne|average|first blood|premier sang|patch|items?|objets?|runes?|keystone|sorts?|build|" +
    "le plus de|most|quel joueur|quels joueurs|which players?|quelle [ée]quipe|which team|top \\d+",
);

/**
 * Concepts people ask about that the database does not hold, each with the
 * view column that would hold it. A concept counts as missing while that
 * column is absent from the live schema, so a rebuild that adds it to the
 * views switches the detection off by itself.
 */
const DATA_CONCEPTS = [
  { label: "les sorts d'invocateur", pattern: word("sorts? d'invocateurs?|summoner spells?"), view: "v_game_players", column: "spell1" },
  { label: "les distinctions MVP et joueur du match", pattern: word("mvps?|pogs?|player of the (?:game|match)|joueurs? du match"), view: "v_game_players", column: "mvp" },
] as const;

/** The concepts of the question that no column of the schema holds. */
export function missingConcepts(question: string, schema: Record<string, string[]>): string[] {
  return DATA_CONCEPTS.flatMap((c) => (c.pattern.test(question) && !(schema[c.view] ?? []).includes(c.column) ? [c.label] : []));
}

/** Games of a scope and how many have in-game (Riot) data. */
export type Coverage = { games: number; ingame: number };

/** Coverage lookups for the router, read from v_ingame_coverage and v_games. */
export type CoverageLookup = {
  league: (league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage;
  player: (player: string, league: string | null, yearFrom: number | null, yearTo: number | null) => Coverage;
};

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

/** Coverage read from the database (league and period, or one player's games). */
export function coverageLookup(db: DatabaseSync): CoverageLookup {
  const read = (sql: string, params: (string | number)[]): Coverage => {
    const row = selectOne(db, CoverageRow, sql, params);

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
  };
}

const RANKING = word(
  "le plus|la plus|les plus|le moins|most|highest|lowest|greatest|meilleure?s?|best|top ?\\d+|classements?|rankings?|leaderboards?|record|quels? joueurs?|quelles? [ée]quipes?|which (?:players?|teams?)|qui (?:a|fait|prend|prennent)",
);

const TEAM_WORDS = word("[ée]quipes?|teams?");

/**
 * Words asking who played for a team: "roster", "line-up", "effectif", "composition", "qui jouait chez".
 * Not "composition d'équipe" in the draft sense: the draft is champions, and a champion goes elsewhere first.
 */
export const ROSTER = word(
  "ro[ao]?sters?|line[- ]?ups?|effectifs?|compositions?|compos?|[ée]quipes? types?|cinq (?:de d[ée]part|majeur)|starting (?:five|lineup)|titulaires?|rempla[çc]ants?|" +
    "qui (?:jouait|jouaient|joue|jouent|a jou[ée]|ont jou[ée]|[ée]tait|[ée]taient)(?: (?:chez|pour|dans|à|a|avec|en))?|who (?:played|plays|was|were)(?: (?:for|on|in|at))?|" +
    "(?:quels?|les) joueurs (?:de|d'|du|chez|pour)|players (?:of|on|for)|membres?|members?",
);

/** Who is "best" or "most" in a team, or an in-game figure: a ranking or a metric, not its roster. */
const NOT_ROSTER = word(
  "le plus|la plus|les plus|most|meilleure?s?|best|pires?|worst|top ?\\d+|kda|kills?|gold|golds|cs|d[ée]g[âa]ts|damage|vision|winrate|win rate|stats?|statistiques?",
);

/**
 * Words asking for the champions one player or one team plays: "champion pool", "pool de Caps", "quels champions joue Keria",
 * "champions joués par T1", "winrate de Faker par champion". Only with one player or one team named.
 */
export const POOL = word(
  `${CHAMPION_POOL}|pools?|` +
    "quels? champions?|quelles? champions?|which champions?|what champions?|" +
    "champions? (?:jou[ée]e?s?|played|pick[ée]e?s?|picked|utilis[ée]e?s?|used)|champions? (?:les? |la )?(?:plus|most) (?:jou[ée]e?s|played|pick[ée]e?s|picked)|" +
    "(?:most|least) (?:played|picked) champions?|(?:par|by|per) champions?|ses champions|his champions|her champions|their champions|" +
    "persos?|signature picks?",
);

// Champions and roles ranked ------------------------------------------------------------

/**
 * A ranking of champions: "champions les plus joués", "most banned champions", "meta", "quel champion a
 * le meilleur winrate". Not "champion du monde", which is a title.
 */
export const CHAMPION_RANKING = word(
  "champions? (?:les? |la )?(?:plus|moins)|(?:most|least) (?:played|picked|banned|contested|popular|present) champions?|" +
    "(?:meilleurs?|best|top ?\\d*|strongest|plus forts?) champions?|champions? (?:avec|with|[àa]u?|ayant) (?:la |le |the )?(?:plus|most|meilleure?|best|highest|pire|worst)|" +
    "classement des champions|champions? ranking|ranking of champions|m[ée]ta|tier ?list|priorit(?:[ée]s?|y)(?: picks?)?|picks? prioritaires?|" +
    "quels? champions?|quelles? champions?|which champions?|what champions?|" +
    "(?:les? )?plus (?:jou[ée]s|bann(?:i|is|ies)|pick[ée]s|choisis|contest[ée]s)|(?:most|least) (?:played|picked|banned|contested)",
);

const NOT_CHAMPION_RANKING = word("champions? (?:du monde|d'europe|de cor[ée]e|de chine|en titre)|world champions?|reigning champions?");

/** What a champion ranking is ordered by, most specific first; "meilleurs champions" means the win rate. */
export const CHAMPION_SORT_CUES: [ChampionSort, RegExp][] = [
  ["presence", word("pr[ée]sences?|presences?|pr[ée]sents?|present|contest[ée]s?|contested|prioritaires?|priorit[ée]s?|priority|m[ée]ta|tier ?list|picks? (?:et|and|ou|or|\\+|&) bans?|picks?/bans?|pick ?(?:&|et|and) ?ban")],
  ["bans", word("bann(?:i|is|ie|ies|ed|s)?|bans?|ban ?rates?")],
  ["kda", word("kda")],
  ["winrate", word("win ?rates?|taux de victoire|gagnants?|gagnent|victoires?|wins?|winning")],
  ["picks", word("jou[ée]e?s?|played|pick[ée]e?s?|picks?|picked|choisis|populaires?|popular|pick ?rates?|souvent|often")],
  ["winrate", word("forts?|strongest|strong|meilleurs?|best|pires?|worst")],
];

export const championSortOf = (question: string): ChampionSort => CHAMPION_SORT_CUES.find(([, re]) => re.test(question))?.[0] ?? "presence";

const PLAYER_WORDS = word("joueurs?|players?|pros?|laners?|laneurs?");

/** Words that compare the players of a role without naming them: "comparaison des mids", "top laners comparison". */
const COMPARE = word("compar\\p{L}*|versus|vs\\.?|face[- ][àa][- ]face|head[- ]to[- ]head|duels?|matchups?");

/** The in-game figures of a champion's profile: metric and minute. */
const PROFILE_INGAME = new Set(["gold_diff@15", "cs_diff@15"]);

/** "au moins 50 parties", "minimum 20 games", "more than 30 picks": a minimum the question sets itself. */
const MINIMUM = /(au moins|minimum(?: de)?|min\.?|at least|plus de|more than|over)\s*(\d{1,3})\s*(parties|games|matchs|matches|picks)/iu;

/** The tools' minimum is inclusive: "plus de 50 parties" is 51 or more. */
const STRICT = /^(?:plus de|more than|over)$/i;

export function minimumOf(question: string, unit: "games" | "picks"): number | null {
  const m = MINIMUM.exec(question);

  if (!m || (unit === "picks") !== /picks/i.test(m[3])) return null;
  const n = Number(m[2]) + (STRICT.test(m[1]) ? 1 : 0);

  return n >= 1 && n <= 200 ? n : null;
}

/** What "best" means for a player ranking, most specific first; KDA when the question does not say. */
export const PLAYER_CRITERION_CUES: [PlayerCriterion, RegExp][] = [
  ["kda", word("kda")],
  ["kp", word("kp|kill participation|participation aux kills|participation")],
  ["dpm", word("d[ée]g[âa]ts|damages?|dpm|dmg")],
  ["cspm", word("cs ?(?:/|par|per) ?min(?:ute)?|cspm|cs|farm(?:ers?|eurs?|ing)?")],
  ["gpm", word("gpm|gold|golds|or (?:par|per) minute|d'or")],
  ["vspm", word("vision|vspm|score de vision")],
  ["winrate", word("win ?rates?|taux de victoire|victoires?|wins?|gagn\\p{L}*|winning")],
  ["games", word("(?:le plus de|most|plus de) (?:parties|games|matchs)|(?:le plus|most) jou[ée]|exp[ée]riment[ée]s?|experienced|v[ée]t[ée]rans?|played the most")],
  ["kills", word("kills?|tueurs?|killers?")],
  ["assists", word("assists?")],
];

export const playerCriterionOf = (question: string): PlayerCriterion => PLAYER_CRITERION_CUES.find(([, re]) => re.test(question))?.[0] ?? "kda";

/** Champions ranked on picks, bans, presence, win rate or KDA, optionally in one role. */
function championRankingRoute(question: string, e: Entities): Route {
  const sort = championSortOf(question);
  const role = roleOf(question);

  return {
    kind: "tool",
    call: { tool: "champion_ranking", input: { league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, sort, role, minPicks: minimumOf(question, "picks") } },
    confidence: 0.9,
    reason: `classement de champions (tri : ${sort}${role ? `, rôle ${role}` : ""})`,
    notes: e.league ? [] : ["Aucune compétition précisée : classement sur les Worlds."],
  };
}

/** Players (of a role) ranked on an explicit end-of-game criterion. */
function playerLeaderboardRoute(question: string, e: Entities): Route {
  const criterion = playerCriterionOf(question);
  const role = roleOf(question);

  return {
    kind: "tool",
    call: { tool: "player_leaderboard", input: { role, league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo, criterion, minGames: minimumOf(question, "games") } },
    confidence: 0.85,
    reason: `classement de joueurs${role ? ` du rôle ${role}` : ""} (critère : ${criterion})`,
    // The level of the field decides who is "best": without a competition, the Worlds, as the other tools.
    notes: e.league ? [] : ["Aucune compétition précisée : classement sur les Worlds."],
  };
}

const ROLE_CUES = ROLES.map((r) => ({ role: r.role, pattern: word(r.words) }));

/** Leagues of the scope (short names), period words aside: "la LPL", "le MSI 2024". */
function scopeOf(e: Entities): string {
  const short = e.leagueShort;

  if (!short) return "cette compétition";

  if (short === "Worlds" || short.endsWith("Masters")) return `les ${short}`;

  return short === "MSI" ? "le MSI" : `la ${short}`;
}

/**
 * In-game questions (Riot data): the typed in-game tools, or "missing" when
 * the scope has no in-game data at all (the LPL, older seasons, some events).
 */
function routeIngame(question: string, e: Entities, cue: MetricCue, coverage: CoverageLookup): Route | null {
  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const league = e.league;
  const what = `les statistiques in-game (${cue.mention})`;

  if (league && coverage.league(league, e.yearFrom, e.yearTo).ingame === 0)
    return {
      kind: "missing",
      concepts: [`${what} pour ${scopeOf(e)}`],
      reason: `aucune partie de ${e.leagueShort ?? league} ${e.yearFrom ?? ""} avec données Riot sur Leaguepedia`.replace(/\s+/g, " "),
      coverage: true,
    };

  if (e.players.length === 1 && e.teams.length === 0 && !e.champion) {
    const p = e.players[0].player;

    if (!cue.player) return { kind: "sql", reason: `métrique d'équipe (« ${cue.mention} ») demandée pour un joueur` };

    if (coverage.player(p, league, e.yearFrom, e.yearTo).ingame === 0)
      return {
        kind: "missing",
        concepts: [`${what} de ${p}${league ? ` en ${e.leagueShort}` : ""}`],
        reason: `aucune partie de ${p} avec données Riot dans ce périmètre`,
        coverage: true,
      };

    return {
      kind: "tool",
      call: { tool: "player_ingame_stats", input: { player: p, league, ...period, metric: cue.player, minute: cue.minute } },
      confidence: 0.9,
      reason: `statistique in-game d'un joueur (« ${cue.mention} »)`,
      notes: [],
    };
  }

  if (e.teams.length === 1 && e.players.length === 0 && !e.champion) {
    if (!cue.team) return { kind: "sql", reason: `métrique individuelle (« ${cue.mention} ») demandée pour une équipe` };

    return {
      kind: "tool",
      call: { tool: "team_ingame_stats", input: { team: e.teams[0].team, league, ...period, minute: cue.minute } },
      confidence: 0.85,
      reason: `profil in-game d'une équipe (« ${cue.mention} »)`,
      notes: [],
    };
  }

  // "écart d'or à 15 min des junglers": a role names who is ranked, even without a ranking word.
  if (e.players.length + e.teams.length === 0 && !e.champion && (RANKING.test(question) || (roleOf(question) && !TEAM_WORDS.test(question)))) {
    const asksTeams = TEAM_WORDS.test(question);

    // A team ranking on a metric only players have (or the reverse): text-to-SQL.
    if ((asksTeams && cue.team == null) || (!asksTeams && cue.player == null && cue.team == null)) return { kind: "sql", reason: `classement sur « ${cue.mention} » sans outil typé` };
    const team = asksTeams || cue.player == null;
    const metric = team ? cue.team : cue.player;

    if (!metric) return null;
    const role = team ? null : (ROLE_CUES.find((r) => r.pattern.test(question))?.role ?? null);

    return {
      kind: "tool",
      call: { tool: "ingame_leaderboard", input: { subject: team ? "team" : "player", metric, minute: cue.minute, league, ...period, role, minGames: null } },
      confidence: 0.85,
      reason: `classement sur une statistique in-game (« ${cue.mention} »)`,
      notes: league ? [] : ["Aucune compétition précisée : classement sur toutes les compétitions avec données in-game."],
    };
  }

  return { kind: "sql", reason: `statistique in-game (« ${cue.mention} ») sans outil typé pour ces entités` };
}

// One game's timeline ------------------------------------------------------------------

/** Words asking for the story of one game rather than a statistic. */
const TIMELINE = word(
  "timelines?|chronologie|d[ée]roul[ée](?:ment)?|minute par minute|minute by minute|courbes? d'or|courbes? de l'or|courbes? de gold|" +
    "graphiques? d'or|gold (?:graph|curve|chart)s?|[ée]volution de l'or|[ée]cart d'or (?:par minute|minute par minute|au fil)|" +
    "comment s'est (?:pass[ée]e?|d[ée]roul[ée]e?)|how did (?:the )?(?:game|match)|r[ée]sum[ée] de la (?:game|partie)",
);

/** "game 3", "partie 2", "3e game", "troisième partie". Not "G3": G2 is a team. */
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

/** Most specific first: "demi-finale" also contains "finale". */
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

/** One game's timeline: a timeline cue, or a game number with a team or a competition. */
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
    reason: cue ? "déroulé d'une partie (timeline, courbe d'or)" : "partie désignée par son numéro dans une série",
    notes: e.teams.length > 2 ? [`Plus de deux équipes reconnues : seules ${e.teams[0].team} et ${e.teams[1].team} sont retenues.`] : [],
  };
}

// Series (best-of) of a phase ------------------------------------------------------------

/** Words asking for the standings of a competition, not its series: "classement des Worlds 2025" keeps the standings. */
const STANDINGS_ONLY = word("palmar[eè]s|classements?|standings|podiums?|rankings?|tableau final|final standings|placements?");

/** Words of a series: its score, its winner, its games and drafts. */
const SERIES_WORDS = word(
  "bo ?[135]|best[- ]of ?[135]?|s[ée]ries?|scores?|r[ée]sultats?|results?|qui a gagn[ée]|who won|vainqueurs?|gagnants?|winners?|gagn[ée]e?s?|won|" +
    "remport[ée]e?s?|perdu|lost|d[ée]tails?|picks?|bans?|drafts?|champions?|games?|parties|matchs?|grande|grand|petite",
);

/**
 * A stage of a competition ("finale des Worlds 2025", "Final worlds 2025", "demi-finales MSI 2024", "quarts LCK 2024") or a match
 * named by its stage ("T1 vs Gen.G finale LCK 2024"): its series as best-of units. Needs a competition or a team, no player or
 * champion; a game number or a timeline cue went to the game's timeline before. In-game metrics, pools, rosters and standings
 * words keep their own route.
 */
function routeSeries(question: string, e: Entities): Route | null {
  const phase = phaseOf(question);

  if (!phase || e.players.length || e.champion) return null;

  if (e.teams.length === 0 && !e.league) return null;

  if (STANDINGS_ONLY.test(question) || POOL.test(question) || ROSTER.test(question) || detectMetric(question) || UNSUPPORTED.test(maskUnderstood(question, e).rest)) return null;

  const notes = e.teams.length > 2 ? [`Plus de deux équipes reconnues : seules ${e.teams[0].team} et ${e.teams[1].team} sont retenues.`] : [];

  return {
    kind: "tool",
    call: { tool: "series", input: { teamA: e.teams[0]?.team ?? null, teamB: e.teams[1]?.team ?? null, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, phase, split: e.split } },
    confidence: 0.9,
    reason: `phase de compétition (« ${PHASES.find((p) => p.phase === phase)!.pattern.exec(question)![0]} ») → séries en BO`,
    notes,
  };
}

export type Route =
  /** `unread`: the words the rules did not understand, when they are enough to put the tool in doubt (confidence lowered to UNSURE). */
  /** `forced`: the cue is explicit enough that unread words do not put the tool in doubt (two players and an opposing word). */
  | { kind: "tool"; call: ToolCall; confidence: number; reason: string; notes: string[]; unread?: string[]; forced?: boolean }
  /** The question needs data the database does not hold: answered without a query. `coverage`: in-game data, absent for this scope only. */
  | { kind: "missing"; concepts: string[]; reason: string; coverage?: boolean }
  /** `open`: the rules found nothing to route on, so the LLM router may still pick a tool. `unread`: as above, for an open route. */
  | { kind: "sql"; reason: string; open?: boolean; unread?: string[] }
  | { kind: "out_of_scope"; reason: string };

const WORLDS = "World Championship";

/**
 * Two players: the comparison. Every way of setting them against each other ("compare", "vs", "h2h",
 * "confrontations"…) gets the same answer; such a word settles it, so the LLM router is not asked again.
 */
function comparisonRoute(question: string, e: Entities): Route {
  const [a, b] = e.players;
  const notes = e.players.length > 2 ? [`Plusieurs joueurs reconnus : seuls ${a.player} et ${b.player} sont comparés.`] : [];
  const cue = OPPOSE.exec(question)?.[0];

  return {
    kind: "tool",
    call: { tool: "player_comparison", input: { playerA: a.player, playerB: b.player, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: cue ? 0.95 : 0.9,
    reason: cue ? `deux joueurs opposés (« ${cue} ») → comparaison` : "deux joueurs → comparaison",
    notes,
    forced: cue != null,
  };
}

/** Two teams: their series against each other. An opposing word settles it, so the LLM router is not asked again. */
function teamsRoute(question: string, e: Entities): Route {
  const [a, b] = e.teams;
  const cue = OPPOSE.exec(question)?.[0];

  return {
    kind: "tool",
    call: { tool: "head_to_head", input: { kind: "team", sideA: a.team, sideB: b.team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: 0.9,
    reason: cue ? `deux équipes opposées (« ${cue} ») → confrontations` : "deux équipes → confrontations",
    notes: e.teams.length > 2 ? [`Plusieurs équipes reconnues : seules ${a.team} et ${b.team} sont opposées.`] : [],
    forced: cue != null,
  };
}

/** One team's roster over the period or competition asked (every competition when none is named). */
function rosterRoute(question: string, e: Entities): Route {
  const cue = ROSTER.exec(question)?.[0];
  const role = teamRoleOf(maskUnderstood(question, e).rest);

  return {
    kind: "tool",
    call: { tool: "team_roster", input: { team: e.teams[0].team, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split, role } },
    confidence: 0.9,
    reason: cue ? `une équipe et « ${cue} » → roster par poste` : `une équipe et un poste (${role}) → roster, poste demandé en premier`,
    notes: [],
    forced: true,
  };
}

/** One player's or one team's champion pool, in the competition and period asked (every competition when none is named). */
function poolRoute(question: string, e: Entities): Route {
  const team = e.players.length === 0;
  const name = team ? e.teams[0].team : e.players[0].player;
  const notes: string[] = [];

  if (!team && e.teams.length) notes.push(`Équipe « ${e.teams[0].mention} » ignorée : champion pool de ${name} toutes équipes confondues.`);

  if (!e.league) notes.push("Aucune compétition précisée : toutes compétitions confondues.");

  const role = team ? roleOf(question) : null;

  if (role) notes.push("Poste non filtré : pool de toute l'équipe, avec le joueur de chaque champion.");

  return {
    kind: "tool",
    call: { tool: "champion_pool", input: { subject: team ? "team" : "player", name, league: e.league, yearFrom: e.yearFrom, yearTo: e.yearTo, split: e.split } },
    confidence: 0.9,
    reason: `${team ? "une équipe" : "un joueur"} et « ${POOL.exec(question)![0]} » → champion pool`,
    notes,
    forced: true,
  };
}

/** A champion alone: its stats in the competition (the Worlds when the question names none). */
function championRoute(e: Entities): Route {
  return {
    kind: "tool",
    call: { tool: "champion_event_stats", input: { champion: e.champion!.champion, league: e.league ?? WORLDS, yearFrom: e.yearFrom, yearTo: e.yearTo } },
    confidence: 0.9,
    reason: "champion seul → stats du champion dans la compétition",
    notes: e.league ? [] : ["Aucune compétition précisée : recherche sur les Worlds."],
  };
}

/**
 * Deterministic intent routing on the resolved entities and a few cues.
 * Returns a typed tool + input, "sql" when no tool covers the question,
 * "missing" when the data is not in the database, or "out_of_scope".
 */
function routeByRules(question: string, e: Entities, schema: Record<string, string[]>, coverage: CoverageLookup): Route {
  if (e.outOfScope)
    return { kind: "out_of_scope", reason: `« ${e.outOfScope} » n'est pas dans le périmètre (Worlds, MSI, LCK, LPL, LEC, LCS, LFL…)` };
  const nEntities = e.players.length + e.teams.length + (e.champion ? 1 : 0);

  if (nEntities === 0 && !e.league && !LOL_DOMAIN.test(question) && !STANDINGS.test(question))
    return { kind: "out_of_scope", reason: "aucune entité ni notion esport League of Legends dans la question" };

  // Before the in-game metrics: "courbe d'or" or "dragons" in a timeline question are not a statistic.
  const timeline = routeTimeline(question, e);

  if (timeline) return timeline;

  const missing = missingConcepts(question, schema);

  if (missing.length) return { kind: "missing", concepts: missing, reason: `donnée absente de la base : ${missing.join(", ")}` };

  // A stage of a competition, or a match named by its stage, before the head-to-head and the standings:
  // "Final worlds 2025" is the Worlds final, not a tournament whose name holds "Finals".
  const series = routeSeries(question, e);

  if (series) return series;

  // Two players set against each other get the comparison, even with a metric ("Faker vs Chovy KDA").
  if (e.players.length >= 2 && OPPOSE.test(question)) return comparisonRoute(question, e);

  // Two teams set against each other ("h2h KC et MKOI", "G2 vs Fnatic"): their series, decided by the rules.
  if (e.teams.length >= 2 && !e.players.length && OPPOSE.test(question)) return teamsRoute(question, e);

  // One player or one team and a pool word ("champion pool de Faker", "quels champions joue Keria", "pool de T1 aux Worlds 2023"),
  // before the roster: "quels champions joue le mid de T1" asks for champions, not players.
  // Not with a champion named (a player on one champion), nor with an in-game metric the pool does not hold.
  if (!e.champion && !detectMetric(question) && (e.players.length === 1 || (e.players.length === 0 && e.teams.length === 1)) && POOL.test(question)) return poolRoute(question, e);

  // One team and a roster word ("Samsung White roster 2014", "qui jouait chez Fnatic en 2018"): its players by role.
  // One team and a role, nothing else ("adc de T1", "c'est qui le toplaner de T1 ?", "top fpx 2019", "jg de G2"): the roster, that role first.
  // Read without the entities and years: "top 2019" is the top of 2019, not a "top N" ranking, and "Top Esports" is a team.
  const rest = maskUnderstood(question, e).rest;
  const oneTeam = e.teams.length === 1 && !e.players.length && !e.champion && !NOT_ROSTER.test(rest) && !detectMetric(question);

  if (oneTeam && (ROSTER.test(question) || (teamRoleOf(rest) && !RANKING.test(rest) && !COMPARE.test(question) && !HISTORY_WORDS.test(question) && !UNSUPPORTED.test(rest))))
    return rosterRoute(question, e);

  const noEntity = e.players.length + e.teams.length === 0 && !e.champion;

  const cue = detectMetric(question);

  // A champion alone: its profile answers its averages too ("KDA d'Azir", "dégâts de Jinx"), and the gold
  // and CS differences at 15 min; another in-game metric ("gold diff at 10", "solo kills") is not in it.
  if (e.champion && !e.players.length && !e.teams.length && (!cue || PROFILE_INGAME.has(`${cue.player}@${cue.minute ?? 15}`))) return championRoute(e);

  if (noEntity && CHAMPION_RANKING.test(question) && !NOT_CHAMPION_RANKING.test(question)) return championRankingRoute(question, e);

  const role = roleOf(question);
  const ranksPlayers = role != null || PLAYER_WORDS.test(question);
  // At most one player named (two go to their comparison above), no team or champion; one only with a role ("Caps, meilleur mid ?").
  const forPlayers = !e.teams.length && !e.champion && (noEntity || (e.players.length === 1 && role != null));

  // Players ranked on an end-of-game criterion; in-game metrics (gold diff, solo kills...) keep their leaderboard.
  // A role with a comparison word ranks its players too ("comparaison des mids aux Worlds"). "classement" is also a
  // tournament's standings: only without a role or a player word.
  if (
    forPlayers && !cue && (RANKING.test(question) || (ranksPlayers && COMPARE.test(question))) && !TEAM_WORDS.test(question) &&
    (ranksPlayers || !STANDINGS.test(question)) && (ranksPlayers || PLAYER_CRITERION_CUES.some(([, re]) => re.test(question)))
  )
    return playerLeaderboardRoute(question, e);

  const ingame = cue ? routeIngame(question, e, cue, coverage) : null;

  if (ingame) return ingame;

  if (UNSUPPORTED.test(question))
    return { kind: "sql", reason: `métrique ou classement non couvert par les outils typés (« ${UNSUPPORTED.exec(question)![0]} »)` };

  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const notes: string[] = [];

  const defaultLeague = () => {
    if (e.league) return e.league;
    notes.push("Aucune compétition précisée : recherche sur les Worlds.");

    return WORLDS;
  };

  const versus = VERSUS.test(question);

  if (e.players.length >= 2) return comparisonRoute(question, e);

  if (e.teams.length >= 2) return teamsRoute(question, e);

  if (e.players.length === 1 && e.teams.length === 1 && versus)
    return { kind: "sql", reason: "confrontation joueur contre équipe : pas d'outil typé" };

  if (e.champion && (e.players.length || e.teams.length))
    return { kind: "sql", reason: "champion joué par un joueur ou une équipe précis : pas d'outil typé" };

  if (e.players.length === 1) {
    if (e.teams.length) notes.push(`Équipe « ${e.teams[0].mention} » ignorée : historique de ${e.players[0].player} toutes équipes confondues.`);

    return {
      kind: "tool",
      call: { tool: "player_event_history", input: { player: e.players[0].player, league: defaultLeague(), ...period } },
      confidence: versus ? 0.7 : 0.95,
      reason: versus ? "un seul joueur reconnu pour une confrontation" : "intention « historique joueur × compétition » → outil paramétré",
      notes,
    };
  }

  if (e.teams.length === 1)
    return {
      kind: "tool",
      call: { tool: "team_history", input: { team: e.teams[0].team, league: e.league, ...period } },
      confidence: versus ? 0.7 : 0.9,
      reason: versus ? "une seule équipe reconnue pour une confrontation" : "équipe seule → historique d'équipe",
      notes,
    };

  if (e.league || STANDINGS.test(question)) {
    const league = defaultLeague();
    const oneYear = e.yearFrom != null && e.yearFrom === e.yearTo;
    const international = league === WORLDS || league === "Mid-Season Invitational";

    return {
      kind: "tool",
      call: { tool: "tournament_standings", input: { league, ...period, split: e.split, full: oneYear && (international || e.split != null) } },
      confidence: STANDINGS.test(question) || oneYear ? 0.9 : 0.75,
      reason: "compétition sans joueur ni équipe → palmarès / classement",
      notes,
    };
  }

  return { kind: "sql", reason: "aucun outil typé ne correspond aux entités reconnues", open: true };
}

// What the rules did not understand ---------------------------------------------------

/** Grammar and filler words, accents stripped: they carry no intent. */
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

/**
 * The words each tool answers, beyond the entities: the cues that route to
 * it and the vocabulary of what it returns. A word outside them was not
 * understood ("toplaner" for a team history, "bannis" for standings).
 */
const TOOL_WORDS: Record<ToolName, RegExp[]> = {
  player_event_history: [HISTORY_WORDS],
  team_history: [HISTORY_WORDS],
  team_roster: [
    ROSTER,
    ...TEAM_ROLE_CUES.map((r) => word(r.words)),
    ...SPLIT_CUES.map((c) => c.pattern),
    word("jou[ée]e?s?|jouait|jouaient|played|joueurs?|players?|[ée]quipes?|teams?|chez|liste|list|actuel(?:le)?s?|current|now|maintenant|aujourd'hui|today|c'est"),
  ],
  head_to_head: [OPPOSE, VERSUS, HISTORY_WORDS, GAME_WORDS],
  player_comparison: [OPPOSE, VERSUS, HISTORY_WORDS, INGAME_WORDS, GAME_WORDS, ...ROLE_CUES.map((r) => r.pattern), word("m[êe]me (?:lane|poste|r[ôo]le)|same (?:lane|role)|lanes?|laners?|postes?|r[ôo]les?")],
  champion_event_stats: [
    word(
      "stats?|statistiques?|(?:pick|ban|win) ?rates?|picks?|bans?|bannie?s?|taux de (?:victoire|pick|ban|pr[ée]sence|s[ée]lection)|pr[ée]sence|presence|" +
        "priorit[ée]|jou[ée]e?s?|played|champion|r[ée]sultats?|results?|bilan|victoires?|d[ée]faites?|wins?|losses|forte?s?|strong|bons?|good|m[ée]ta|" +
        "kda|moyen(?:ne)?s?|averages?|or|gold|golds|cs|farm|d[ée]g[âa]ts|damages?|vision|kills?|morts?|deaths?|assists?|[ée]carts?|diff|" +
        "joueurs?|players?|meilleurs?|best|qui (?:le )?joue(?:nt)?|who plays?|mains?|onetricks?|r[ôo]les?|postes?|lanes?|sur|on|avec|with|" +
        "items?|objets?|builds?|stuffs?|achats?|ach[eè]te(?:nt)?|pris|prend|construits?|built",
    ),
    ...ROLE_CUES.map((r) => r.pattern),
  ],
  champion_ranking: [
    CHAMPION_RANKING,
    ...CHAMPION_SORT_CUES.map(([, re]) => re),
    ...ROLE_CUES.map((r) => r.pattern),
    word("champions?|champs?|classement|ranking|top|liste|list|stats?|statistiques?|en|in|au|at|lanes?|postes?|r[ôo]les?"),
  ],
  champion_pool: [
    POOL,
    ...SPLIT_CUES.map((c) => c.pattern),
    word(
      "champions?|champs?|jou[ée]e?s?|joue(?:nt)?|jouait|played|plays?|picks?|pick[ée]s?|stats?|statistiques?|win ?rates?|kda|bilan|r[ée]sultats?|" +
        "victoires?|d[ée]faites?|liste|list|diversit[ée]|vari[ée]t[ée]|uniques?|diff[ée]rents?|souvent|often|carri[èe]re|career|en|in|au|at",
    ),
  ],
  player_leaderboard: [
    // Roles first: "meilleur top" is a role, not "meilleur" then a stray "top".
    ...ROLE_CUES.map((r) => r.pattern),
    RANKING,
    COMPARE,
    PLAYER_WORDS,
    ...PLAYER_CRITERION_CUES.map(([, re]) => re),
    word(
      "du monde|in the world|de tous les temps|of all time|all[- ]time|ever|selon|crit[èe]res?|en termes de|in terms of|stats?|statistiques?|" +
        "jou[ée]e?s?|played|parties|games|matchs|par minute|per minute|au moins|at least|minimum|plus de|more than|over|avec|with|" +
        "postes?|r[ôo]les?|lanes?|classement|ranking|liste|list",
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
  ingame_leaderboard: [MINUTE, RANKING, INGAME_WORDS, TEAM_WORDS, word("souvent|often")],
  series: [...PHASES.map((p) => p.pattern), SERIES_WORDS, VERSUS, OPPOSE, GAME_WORDS, ...SPLIT_CUES.map((c) => c.pattern)],
  game_timeline: [TIMELINE, ...GAME_NUMBER, ...ORDINALS.map(([pattern]) => pattern), ...PHASES.map((p) => p.pattern), VERSUS, GAME_WORDS],
};

const fold = (text: string) => text.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * The meaningful words of the question that neither the understand step nor
 * the routed tool read, and their share of everything meaningful (read
 * mentions and cues count one each). `call` is null for an open route.
 */
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
    const ingame = call.tool === "player_ingame_stats" || call.tool === "team_ingame_stats" || call.tool === "ingame_leaderboard";
    const cue = ingame ? detectMetric(question) : null;

    if (cue) take(word(cue.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    if (call.tool === "ingame_leaderboard" && call.input.role) for (const r of ROLE_CUES) take(r.pattern);

    for (const pattern of TOOL_WORDS[call.tool]) take(pattern);
  }

  const words = rest.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !/^\d+$/.test(w) && !FUNCTION_WORDS.has(fold(w)));

  return { words, share: words.length ? words.length / (words.length + read) : 0 };
}

/**
 * Share of unread words from which a typed tool is no longer trusted: the
 * rules found an entity, not what is asked about it. One unread word out of
 * four meaningful ones is enough. On the eval questions the well-understood
 * ones stay at 0.20 or less ("spring" for a champion's stats) and the
 * misread ones start at 0.25 ("compare Caps et Perkz en LEC").
 */
export const UNREAD_THRESHOLD = 0.25;

/** Confidence of a tool in doubt: under the LLM router's threshold and under a generated query (0.6), so either can replace it. */
const UNSURE = 0.5;

/**
 * The rules' route, with a check of how much of the question they read. A
 * tool picked while too many words stay unread is put in doubt: the LLM
 * router then decides, with those words, between a tool and text-to-SQL.
 */
export function routeQuestion(question: string, e: Entities, schema: Record<string, string[]>, coverage: CoverageLookup): Route {
  const route = routeByRules(question, e, schema, coverage);

  if (route.kind === "sql" && route.open) {
    const { words } = unreadWords(question, e, null);

    return words.length ? { ...route, unread: words } : route;
  }

  if (route.kind !== "tool") return route;
  const { words, share } = unreadWords(question, e, route.call);

  if (share < UNREAD_THRESHOLD) return route;

  // Kept for the trace, without lowering the confidence: the rules' pick stands.
  if (route.forced) return { ...route, unread: words, reason: `${route.reason} ; mots non lus ignorés : ${words.join(", ")}` };

  return {
    ...route,
    confidence: Math.min(route.confidence, UNSURE),
    unread: words,
    reason: `${route.reason} ; mots non compris (${Math.round(100 * share)} %) : ${words.join(", ")}`,
  };
}

// Plans -------------------------------------------------------------------------------

export function toolPlan(tool: BoundTool, attempt: number, relaxed: string[] = []): QueryPlan {
  return { intent: tool.call.tool, tool, sql: tool.sql, params: tool.params, attempt, relaxed };
}


/** Schema summary given to the LLM: the v_* views only (generated SQL may read nothing else). */
export function schemaPrompt(db: DatabaseSync): string {
  return Object.entries(allowedSchema(readSchema(db), VIEWS))
    .map(([t, cols]) => `${t}(${cols.join(", ")})`)
    .join("\n");
}

const SQL_RULES =
  "SQLite dialect. One read-only SELECT statement, no trailing semicolon. " +
  "In-game stats come from Riot game data and only exist for some games: v_game_player_stats (one row per player and game: " +
  "gold/xp/cs at 10, 15 and 20 minutes and their difference with the lane opponent, kills_10/deaths_10/assists_10 before 10:00, solo_kills, " +
  "first_blood_kill/assist/victim, double to penta kills, wards, control_wards, plates) and v_game_team_stats (one row per team and game: first_* objectives as 0/1, " +
  "team gold and gold difference at 10/15/20, kills_10/15/20, plates). v_ingame_coverage gives games and ingame_games per league and year: " +
  "the LPL (Tencent LoL Pro League) has none. If the question needs in-game stats for a scope whose ingame_games is 0, set `missing`. " +
  "End-of-game objective counts (dragons, barons, towers, heralds, void grubs, inhibitors) are in v_games for every league. " +
  "Use only these views and columns (no other table). " +
  "Player names are Leaguepedia page names (v_game_players.player); league values are Leaguepedia League names (e.g. 'World Championship'). " +
  "A role is one of 'Top', 'Jungle', 'Mid', 'Bot', 'Support' (an ADC is 'Bot'). " +
  `Exclude stage = 'qualifier' unless asked; stage = 'event' rows only hold standings. Keep the result under ${MAX_ROWS} rows. ` +
  "A stage of the bracket (final, semifinal, quarterfinal) is v_games.tab ('Finals', 'Semifinals', 'Quarterfinals'), never a tournament name: " +
  "a tournament named 'Regional Finals' is a regional qualifier, not the final of the international event. " +
  "If the answer needs data that no listed column holds (for example MVP awards or summoner spells), " +
  "do not approximate it with other columns and do not return a constant: set sql to an empty string and name the missing data, " +
  "in French, in `missing`. Otherwise `missing` is empty. `explanation` is one short sentence.";

const SqlOutput = z.object({ sql: z.string(), explanation: z.string(), missing: z.array(z.string()) });

/** A predicate that is always false: the query states a figure without reading any data. */
const ALWAYS_FALSE = /\b(?:0\s*=\s*1|1\s*=\s*0)\b|\bwhere\s+(?:false|0)\b/i;

/** What a generated query would leave out: the data it says is missing, or a query that reads nothing real. */
function generatedGaps(reply: { sql: string; missing: string[] }): string[] {
  if (reply.missing.length) return reply.missing;

  return !reply.sql || ALWAYS_FALSE.test(reply.sql) ? ["la donnée demandée (la requête générée ne lisait aucune donnée réelle)"] : [];
}

/** `functionId` names the call in the trace: generating a query, or repairing one. */
async function askSql(db: DatabaseSync, prompt: string, functionId: "generate-sql" | "repair-sql") {
  const llm = getLlm();

  if (!llm) return null;

  const { output } = await generateText({
    model: llm.model,
    output: Output.object({ schema: SqlOutput }),
    instructions: `${SQL_RULES}\nSchema:\n${schemaPrompt(db)}`,
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
  });

// Build step ------------------------------------------------------------------------

type BuildInput = { db: DatabaseSync; question: string; entities: Entities; route: Route };

/** A query plan, or (text-to-SQL only) the data the database does not hold. */
export type BuildResult = { plan: QueryPlan; notes: string[] } | { plan: null; missing: string[]; notes: string[] };

const rulesRouter: Decider<BuildInput, BuildResult> = {
  level: "rules",
  name: "outil typé",
  run: ({ db, route }) => {
    if (route.kind !== "tool") return null;

    return {
      result: { plan: toolPlan(bindTool(db, route.call), 1), notes: route.notes },
      confidence: route.confidence,
      level: "rules",
      reason: route.reason,
    };
  },
};

/** Added to the router's instructions when the rules left words of the question unread. */
const UNREAD_RULES =
  " The rule-based router matched the names but could not read the words listed below, so its pick is in doubt: check it against those words. " +
  "A tool only filters on the arguments of its schema and only returns what its description says. " +
  "If a listed word is a misspelt name or a nickname of a player or a team, call the fitting tool with the correct name. " +
  "If the listed words ask for a filter or a result that no tool has (who plays a role or a roster, " +
  "a ranking of champions or players, personal details...), call no tool: " +
  "a SQL query is then generated, which is the expected outcome and not a failure. Never answer a different question with a tool.";

/** The LLM picks a typed tool (AI SDK tool calling); no tool call means text-to-SQL. */
const llmRouter: Decider<BuildInput, BuildResult> = {
  level: "llm",
  name: "choix d'outil",
  run: async ({ db, question, entities, route }) => {
    const llm = getLlm();

    if (!llm || (route.kind === "sql" && !route.open)) return null;

    const unread = route.kind === "tool" || route.kind === "sql" ? (route.unread ?? []) : [];
    const picked = route.kind === "tool" ? ` They picked ${route.call.tool} ${JSON.stringify(route.call.input)}.` : "";

    const { toolCalls } = await generateText({
      model: llm.model,
      tools: aiTools,
      toolChoice: "auto",
      instructions:
        "Pick the one tool that answers the League of Legends esports question exactly, with its arguments. " +
        "If no tool answers it exactly (other metrics such as end-of-game kills, durations, objective counts, or open rankings), call no tool." +
        (unread.length ? UNREAD_RULES : ""),
      prompt:
        `Question: ${question}\nResolved entities: ${entitySummary(entities)}` +
        (unread.length ? `\nWords the rules could not read: ${unread.join(", ")}.${picked}` : ""),
      telemetry: { functionId: "pick-tool" },
      maxOutputTokens: LLM_CALL.maxOutputTokens,
      maxRetries: LLM_CALL.maxRetries,
      abortSignal: llmSignal(LLM_CALL.timeoutMs),
    });

    // Dynamic calls are unknown or unparsable tool calls: treat them as "no tool".
    const typed = toolCalls.find((c) => !c.dynamic);

    if (!typed || typed.dynamic) return null;
    const call = normalizeToolCall(db, typed);

    if (!call) return null;

    return {
      // The rules' notes (a default competition...) still hold when the LLM confirms their tool.
      result: { plan: toolPlan(bindTool(db, call), 1), notes: route.kind === "tool" && route.call.tool === call.tool ? route.notes : [] },
      confidence: 0.85,
      level: "llm",
      reason: `${llm.id} : ${call.tool}(${JSON.stringify(call.input)})`,
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

    if (gaps.length) return { result: { plan: null, missing: gaps, notes: [] }, confidence: 0.8, level: "llm", reason: `${reply.model} : donnée absente` };

    return {
      result: { plan: { intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: 1, relaxed: [] }, notes: [] },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function buildQuery(input: BuildInput) {
  return decide(input, [rulesRouter, llmRouter, textToSqlDecider], { threshold: 0.8 });
}

// Self-correction -------------------------------------------------------------------

export type CorrectInput = {
  db: DatabaseSync;
  question: string;
  entities: Entities;
  plan: QueryPlan;
  problem: { kind: "guard" | "error" | "empty" | "timeout"; message: string };
};

type Fix = { plan: QueryPlan; note?: string };

/** Deterministic fixes for an empty typed result: the tool's relaxations, in order. */
const rulesCorrector: Decider<CorrectInput, Fix> = {
  level: "rules",
  name: "corrections déterministes",
  run: ({ entities, plan, problem }) => {
    if (!plan.tool || problem.kind !== "empty") return null;
    const next = plan.tool.relaxations(entities).find((r) => !plan.relaxed.includes(r.key));

    if (!next) return null;

    return {
      result: { plan: toolPlan(next.next(), plan.attempt + 1, [...plan.relaxed, next.key]), note: next.note },
      confidence: 0.85,
      level: "rules",
      reason: next.reason,
    };
  },
};

/** The LLM repairs a rejected or failing query, or an empty generated one. */
const llmCorrector: Decider<CorrectInput, Fix> = {
  level: "llm",
  name: "réparation SQL",
  run: async ({ db, question, plan, problem }) => {
    if (problem.kind === "empty" && plan.intent !== "sql") return null;

    const reply = await askSql(
      db,
      `Question: ${question}\nThis query ${problem.kind === "empty" ? "returned no rows" : "was rejected"}:\n${plan.sql}\n` +
        `Parameters: ${JSON.stringify(plan.params)}\nProblem: ${problem.message}\n` +
        "Return a corrected query. Inline the parameter values as literals.",
      "repair-sql",
    );

    // A repair that gives up on real data is no repair.
    if (!reply || generatedGaps(reply).length) return null;

    return {
      result: { plan: { ...plan, intent: "sql", tool: null, sql: reply.sql, params: {}, attempt: plan.attempt + 1 } },
      confidence: 0.6,
      level: "llm",
      reason: `${reply.model} : ${reply.explanation}`,
    };
  },
};

export function correctQuery(input: CorrectInput) {
  return decide(input, [rulesCorrector, llmCorrector], { threshold: 0.75 });
}
