import { leagueMembers } from "../domain/leagues";
import type { DatabaseSync } from "node:sqlite";
import { generateText, Output } from "ai";
import { z } from "zod";
import { readSchema, selectOne } from "../db";
import { type Decider, decide } from "./decide";
import { allowedSchema, VIEWS, MAX_ROWS } from "./guard";
import { getLlm, LLM_CALL, llmSignal } from "./llm";
import { aiTools, type BoundTool, bindTool, type GamePhase, normalizeToolCall, type ToolCall } from "./tools";
import { detectMetric, type MetricCue, MINUTE } from "./metrics";
import { ROLE_CUES as ROLES } from "./roles";
import type { Entities, QueryPlan, ToolName } from "./types";
import { LOL_DOMAIN, maskUnderstood, SPLIT_CUES } from "./understand";

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
  "le plus|la plus|les plus|le moins|most|meilleure?s?|best|top ?\\d+|classement|leaderboard|record|quels? joueurs?|quelles? [ée]quipes?|which (?:players?|teams?)|qui (?:a|fait|prend|prennent)",
);

const TEAM_WORDS = word("[ée]quipes?|teams?");

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

  if (e.players.length + e.teams.length === 0 && !e.champion && RANKING.test(question)) {
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
  { phase: "semifinal", pattern: word("demi[- ]?finales?|demies?|semi[- ]?finals?|semis") },
  { phase: "quarterfinal", pattern: word("quarts?(?: de finale)?|quarter[- ]?finals?") },
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

  const cue = detectMetric(question);
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

  if (e.players.length >= 2) {
    const [a, b] = e.players;

    if (e.players.length > 2) notes.push(`Plusieurs joueurs reconnus : seuls ${a.player} et ${b.player} sont comparés.`);

    // Every way of setting two players against each other ("compare", "vs", "h2h", "confrontations"…) gets the
    // same answer; such a word settles it, so the LLM router is not asked again.
    const cue = OPPOSE.exec(question)?.[0];

    return {
      kind: "tool",
      call: { tool: "player_comparison", input: { playerA: a.player, playerB: b.player, league: e.league, ...period } },
      confidence: cue ? 0.95 : 0.9,
      reason: cue ? `deux joueurs opposés (« ${cue} ») → comparaison` : "deux joueurs → comparaison",
      notes,
      forced: cue != null,
    };
  }

  if (e.teams.length >= 2)
    return {
      kind: "tool",
      call: { tool: "head_to_head", input: { kind: "team", sideA: e.teams[0].team, sideB: e.teams[1].team, league: e.league, ...period } },
      confidence: 0.9,
      reason: "deux équipes → confrontations",
      notes,
    };

  if (e.players.length === 1 && e.teams.length === 1 && versus)
    return { kind: "sql", reason: "confrontation joueur contre équipe : pas d'outil typé" };

  if (e.champion && (e.players.length || e.teams.length))
    return { kind: "sql", reason: "champion joué par un joueur ou une équipe précis : pas d'outil typé" };

  if (e.champion)
    return {
      kind: "tool",
      call: { tool: "champion_event_stats", input: { champion: e.champion.champion, league: defaultLeague(), ...period } },
      confidence: 0.9,
      reason: "champion seul → stats du champion dans la compétition",
      notes,
    };

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
  head_to_head: [OPPOSE, VERSUS, HISTORY_WORDS, GAME_WORDS],
  player_comparison: [OPPOSE, VERSUS, HISTORY_WORDS, INGAME_WORDS, GAME_WORDS],
  champion_event_stats: [
    word(
      "stats?|statistiques?|(?:pick|ban|win) ?rates?|picks?|bans?|bannie?s?|taux de (?:victoire|pick|ban|pr[ée]sence|s[ée]lection)|pr[ée]sence|presence|" +
        "priorit[ée]|jou[ée]e?s?|played|champion|r[ée]sultats?|results?|bilan|victoires?|d[ée]faites?|wins?|losses|forte?s?|strong|bons?|good|m[ée]ta",
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
  "If the listed words ask for a filter or a result that no tool has (a stage such as the final, who plays a role or a roster, " +
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
