import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, type Locale } from "../locale";
import { englishBare, englishIn, frenchIn, frenchNamed } from "../domain/leagues";
import type { LlmStatus } from "./llm";

/**
 * What the agent writes outside its tools, in each language: the steps of the trace, the notes, and the
 * answers that hold no table (out of scope, missing data, empty, failed). `en` is typed on `fr`, so a text
 * added in one language and forgotten in the other fails the typecheck. A text with a name or a number in it
 * is a function: each language keeps its own word order.
 *
 * The language is the one of the request (`withLocale`), French when nothing sets it: the tests and the eval
 * run without one.
 */

/** French names its deciders itself. */
const OWN_NAMES: Record<string, string> = {};

const fr = {
  run: {
    cascade: (attempts: string) => `cascade : ${attempts}`,
    examples: ["Résultats de Chovy à tous les Worlds", "T1 contre Gen.G en LCK", "Stats d'Ahri aux Worlds 2024", "Palmarès du MSI"],
    candidate: (player: string, games: number) => `${player} (${games} parties)`,
    otherCandidates: (n: number) => ` et ${n} autres`,
    ambiguity: (mention: string, list: string, player: string, reason: string) => `« ${mention} » désigne plusieurs joueurs : ${list}. Retenu : ${player}, ${reason}.`,
    uncertainChoice: " Choix incertain : précise le pseudo si ce n'est pas le bon joueur.",

    analysing: "Analyse de la question…",
    viaAlias: (alias: string) => ` via l'alias « ${alias} »`,
    homonyms: (list: string, more: boolean, reason: string, uncertain: boolean) => ` ; homonymes : ${list}${more ? "…" : ""} (choix : ${reason}${uncertain ? ", incertain" : ""})`,
    playerLine: (mention: string, player: string, ids: string, rest: string) => `joueur « ${mention} » → ${player}${ids ? ` (${ids})` : ""}${rest}`,
    teamLine: (mention: string, team: string, members: string | null) => `équipe « ${mention} » → ${team}${members ? ` (${members})` : ""}`,
    championLine: (mention: string, champion: string) => `champion « ${mention} » → ${champion}`,
    opponentLine: (mention: string, champion: string) => `adversaire « ${mention} » → ${champion}`,
    unknownPlayer: (mention: string) => `« ${mention} » : aucun joueur connu`,
    leagueLine: (league: string | null, mention: string | null) => `compétition → ${league ?? "non précisée"}${mention ? ` (« ${mention} »)` : ""}`,
    periodLine: (from: number | null, to: number | null, split: string | null) => `période → ${from ?? "début"} – ${to ?? "aujourd'hui"}${split ? ` · split ${split}` : ""}`,
    outOfScopeLine: (mention: string) => `hors périmètre → « ${mention} »`,
    recognized: "Entités reconnues",
    noEntity: "Aucune entité reconnue",
    outOfScopeNamed: (mention: string) => `Hors périmètre (${mention})`,
    ambiguousAlias: " · alias ambigu",

    sqlFallbackDetail: {
      ready: "Le text-to-SQL n'a rien produit.",
      missing: "Mode déterministe (pas de OPENROUTER_API_KEY) : le text-to-SQL de secours est désactivé.",
      exhausted: "Mode déterministe (quota OpenRouter épuisé) : le text-to-SQL de secours est désactivé pour le moment.",
    } satisfies Record<LlmStatus, string>,
    sqlFallbackTitle: {
      ready: "Pas de requête",
      missing: "text-to-SQL requis (désactivé sans clé)",
      exhausted: "text-to-SQL requis (quota épuisé)",
    } satisfies Record<LlmStatus, string>,
    building: "Construction de la requête…",
    outOfScopeQuestion: "Question hors périmètre",
    outOfScope: "Hors périmètre",
    missingData: "Donnée absente de la base",
    noQuery: (reason: string) => `${reason}\nAucune requête : un chiffre serait inventé.`,
    noTool: "Aucun outil typé ne couvre la question",
    typedTool: (label: string) => `Outil typé : ${label}`,
    generatedQuery: "Requête générée (text-to-SQL)",
    parameters: (json: string) => `paramètres : ${json}`,
    toolDone: (intent: string) => `outil typé ${intent}`,

    guardRejected: (attempt: number) => `Tentative ${attempt} : rejetée par le garde-fou`,
    guardOk: (attempt: number, tool: boolean) => `Tentative ${attempt} : garde-fou OK (lecture seule, 1 instruction, ${tool ? "liste blanche" : "vues v_*"}, LIMIT forcé, prepare)`,
    rowsIn: (rows: number, ms: number) => `${rows} ligne(s) en ${ms} ms`,
    emptyIn: (ms: number) => `Résultat vide (${ms} ms)`,
    emptyResult: "résultat vide",
    sqliteError: "Erreur SQL",
    executing: "Exécution…",
    rowsDone: (rows: number, fixes: number) => `${rows} ligne(s)${fixes ? `, après ${fixes} correction(s)` : ""}`,
    emptyExplained: "Résultat vide expliqué par le périmètre, sans autre tentative",
    noRowsAfter: (attempts: number) => `Aucune ligne après ${attempts} tentatives`,
    givenUpAfter: (attempts: number) => `Abandon après ${attempts} tentatives`,
    noFix: "Aucune correction possible",
    noRows: "Aucune ligne",
    failed: "Échec",
    selfCorrection: (reason: string) => `Auto-correction : ${reason}`,
    nothingToRun: "Rien à exécuter",
    internalError: "Erreur interne.",
    stepInterrupted: "Étape interrompue",

    summaryPrompt:
      "Reformule ces faits en une ou deux phrases de synthèse en français, qui répondent à la question. " +
      "Garde exactement leurs chiffres et leur périmètre (compétition, éditions, période) : " +
      "n'ajoute aucun chiffre, aucune période (saison, année en cours…) ni aucune interprétation absente des faits.",
    /** Key of the facts in the JSON given to the model: named in its language, like the instructions. */
    factsKey: "faits",
    summaryFromAggregates: "synthèse à partir des agrégats",
    summaryRejected: (beyond: string) => `synthèse rejetée, absent des faits : ${beyond}`,

    outOfScopeSummary: (reason: string, scope: string) => `Question hors périmètre : ${reason}. La base couvre : ${scope}.`,
    noToolFor: (detail: string) => `Aucun outil typé ne couvre cette question (${detail})`,
    routing: "routage",
    /** No answer, in the visitor's words: the technical reason (no typed tool, no model) stays in the trace. */
    searchGaveNothing: "Je ne sais pas encore répondre à cette question : ma recherche n'a rien donné. Essaie de la reformuler, ou l'une des questions ci-dessous.",
    cannotAnswerYet: "Je ne sais pas encore répondre à cette question. Essaie de la reformuler, ou l'une des questions ci-dessous.",
    noResultFor: (who: string, league: string | null) => `Aucun résultat${who ? ` pour ${who}` : ""}${league ? ` (${league})` : ""} dans la base.`,
    missingHead: (missing: string) => `Donnée absente de la base : ${missing}. `,
    missingForScope:
      "Les statistiques in-game (or, CS et XP aux minutes clés, first blood, solo kills, multi-kills, wards, plaques, premiers objectifs) " +
      "viennent des données Riot que Leaguepedia publie pour une partie des matchs, et il n'en publie aucune pour ce périmètre (aucune pour la LPL). " +
      "Les résultats, les drafts et les statistiques de fin de partie (kills, morts, assists, or, CS, dégâts, vision, objectifs) y restent disponibles : aucun chiffre in-game n'est donc donné.",
    missingInGeneral:
      "La base contient les résultats, les drafts, les statistiques de fin de partie (kills, morts, assists, or, CS, dégâts, vision, objets, rune principale, objectifs) " +
      "et, pour les parties dont Leaguepedia publie les données Riot, les statistiques in-game : aucun chiffre n'est donc donné.",

    formatting: "Mise en forme…",
    missingFormatted: "Réponse « donnée absente » mise en forme, sans chiffre",
    timedOut: "La requête a dépassé le délai de calcul et a été arrêtée. Précise une compétition ou une période plus courte.",
    guardRefused: "La requête a été rejetée par le garde-fou. Aucun résultat ne peut être conclu.",
    queryFailed: "La requête a échoué pendant son exécution. Aucun résultat ne peut être conclu.",
    interruptedOrRejected: "Requête interrompue ou rejetée",
    failureTitle: "Échec de la requête",
    unrecognizedQuestion: "Question non reconnue",
    noResult: "Pas de résultat",
    emptyExplainedBy: (reason: string) => `Réponse vide expliquée (${reason})`,
    emptyFormatted: "Réponse vide mise en forme",
    genericTable: (rows: number, columns: number) => `Tableau générique (${rows} lignes, ${columns} colonnes)`,
    rowCount: (rows: number) => `${rows} lignes`,
    generatedSummary: (rows: number) => `${rows} ligne(s) renvoyée(s) par une requête générée, validée par le garde-fou.`,
    summaryBy: (llm: boolean) => `Synthèse (${llm ? "LLM" : "modèle de phrase"})`,
    timelineShown: (points: number, events: number) => `Timeline : ${points} points d'or, ${events} événements`,
    tableShown: (rows: number) => `Tableau de ${rows} lignes`,
    formatted: (shown: string, sources: number, followUps: number, ms: number) => `${shown}, ${sources} sources, ${followUps} suites, requêtes de mise en forme en ${ms} ms`,
    eventCount: (events: number) => `${events} événements`,
    formatDone: (shown: string, sources: number) => `${shown} · ${sources} sources`,
    leagueNames: (names: string) => `La période couvre plusieurs noms de ligue : ${names}.`,
  },

  route: {
    noLeagueWorldsRanking: "Aucune compétition précisée : classement sur les Worlds.",
    noLeagueWorldsSearch: "Aucune compétition précisée : recherche sur les Worlds.",
    noLeagueAll: "Aucune compétition précisée : toutes compétitions confondues.",
    noLeagueDragons: "Aucune compétition précisée : dragons de toutes les compétitions avec données in-game.",
    noLeagueIngameRanking: "Aucune compétition précisée : classement sur toutes les compétitions avec données in-game.",
    championRanking: (sort: string, total: boolean, role: string | null, side: string | null) =>
      `classement de champions (tri : ${sort}${total ? " au total" : ""}${role ? `, rôle ${role}` : ""}${side ? `, côté ${side}` : ""})`,
    playerRanking: (role: string | null, criterion: string, side: string | null) => `classement de joueurs${role ? ` du rôle ${role}` : ""} (critère : ${criterion}${side ? `, côté ${side}` : ""})`,
    teamRanking: (criterion: string, ascending: boolean, side: string | null) => `classement d'équipes (critère : ${criterion}${ascending ? ", ordre croissant" : ""}${side ? `, côté ${side}` : ""})`,
    /** A league of the scope as a sentence names it: "la LPL", "le MSI", "les Worlds". */
    leagueScope: (short: string | null) => (!short ? "cette compétition" : frenchNamed(short)),
    ingameStats: (mention: string) => `les statistiques in-game (${mention})`,
    ingameFor: (what: string, scope: string) => `${what} pour ${scope}`,
    noRiotGames: (league: string, year: number | null) => `aucune partie de ${league} ${year ?? ""} avec données Riot sur Leaguepedia`.replace(/\s+/g, " "),
    minuteOnly: (mention: string, asked: number, minutes: readonly number[]) => `${mention} à ${asked} min (relevé seulement à ${minutes.join(", ").replace(/, (\d+)$/, " et $1")} min)`,
    minuteAbsent: (asked: number) => `minute ${asked} absente des données in-game`,
    ingameOf: (what: string, who: string, league: string | null) => `${what} de ${who}${league ? ` ${frenchIn(league)}` : ""}`,
    noRiotGamesOf: (who: string) => `aucune partie de ${who} avec données Riot dans ce périmètre`,
    dragons: (mention: string) => `dragons par élément et âmes (« ${mention} »)`,
    teamMetricForPlayer: (mention: string) => `métrique d'équipe (« ${mention} ») demandée pour un joueur`,
    playerIngame: (mention: string) => `statistique in-game d'un joueur (« ${mention} »)`,
    playerMetricForTeam: (mention: string) => `métrique individuelle (« ${mention} ») demandée pour une équipe`,
    teamIngame: (mention: string) => `profil in-game d'une équipe (« ${mention} »)`,
    dragonElementRanking: (mention: string) => `classement sur un élément de dragon (« ${mention} ») sans outil typé`,
    rankingUntyped: (mention: string) => `classement sur « ${mention} » sans outil typé`,
    ingameRanking: (mention: string) => `classement sur une statistique in-game (« ${mention} »)`,
    ingameUntyped: (mention: string) => `statistique in-game (« ${mention} ») sans outil typé pour ces entités`,
    gameTimeline: "déroulé d'une partie (timeline, courbe d'or)",
    gameByNumber: "partie désignée par son numéro dans une série",
    onlyTwoTeamsKept: (a: string, b: string) => `Plus de deux équipes reconnues : seules ${a} et ${b} sont retenues.`,
    phaseSeries: (cue: string) => `phase de compétition (« ${cue} ») → séries en BO`,
    twoTeamsSeries: (cue: string) => `deux équipes et « ${cue} » sur une saison → leurs séries en BO`,
    snapshotMinutes: (mention: string, asked: number) => `Les données in-game ne relèvent l'or, le CS et l'XP qu'à 10, 15 et 20 min : pas de « ${mention} » à ${asked} min.`,
    teamStatNotCompared: (mention: string) => `« ${mention} » est une statistique d'équipe : la comparaison de deux joueurs ne la contient pas.`,
    onlyTwoPlayers: (a: string, b: string) => `Plusieurs joueurs reconnus : seuls ${a} et ${b} sont comparés.`,
    twoPlayers: (cue: string | null, first: string | null) => (cue ? `deux joueurs opposés (« ${cue} ») → comparaison` : "deux joueurs → comparaison") + (first ? `, « ${first} » en premier` : ""),
    twoTeams: (cue: string | null) => (cue ? `deux équipes opposées (« ${cue} ») → confrontations` : "deux équipes → confrontations"),
    onlyTwoTeamsOpposed: (a: string, b: string) => `Plusieurs équipes reconnues : seules ${a} et ${b} sont opposées.`,
    roster: (cue: string | null, role: string | null) => (cue ? `une équipe et « ${cue} » → roster par poste` : `une équipe et un poste (${role}) → roster, poste demandé en premier`),
    teamIgnoredPool: (mention: string, name: string) => `Équipe « ${mention} » ignorée : champion pool de ${name} toutes équipes confondues.`,
    roleNotFiltered: "Poste non filtré : pool de toute l'équipe, avec le joueur de chaque champion.",
    pool: (team: boolean, cue: string) => `${team ? "une équipe" : "un joueur"} et « ${cue} » → champion pool`,
    matchup: (opponent: boolean, cue: string) => (opponent ? `deux champions opposés (« ${cue} ») → leur matchup` : `un champion et « ${cue} » → ses adversaires directs`),
    singleGameRecord: (metric: string, player: string | null) => `record sur une partie (${metric})${player ? ` de ${player}` : ""}`,
    recentGames: (cue: string) => `un joueur et « ${cue} » → ses dernières parties`,
    playerTeam: (cue: string, team: string) => `un joueur et « ${cue} » → roster de son équipe (${team})`,
    playerTeamAsked: (player: string, team: string) => `Équipe de ${player} sur la période demandée : ${team}.`,
    playerTeamLatest: (player: string, team: string, year: number) => `Aucune période précisée : dernière équipe de ${player} (${team}, ${year}).`,
    playerTeamOthers: (player: string, teams: string) => `${player} a aussi joué pour ${teams} sur cette période : seule sa dernière équipe est affichée.`,
    teamIgnoredRecent: (mention: string, player: string) => `Équipe « ${mention} » ignorée : dernières parties de ${player} toutes équipes confondues.`,
    championAlone: "champion seul → stats du champion dans la compétition",
    notInScope: (mention: string) => `« ${mention} » n'est pas dans le périmètre (Worlds, MSI, LCK, LPL, LEC, LCS, LFL…)`,
    noEsport: "aucune entité ni notion esport League of Legends dans la question",
    missing: (concepts: string) => `donnée absente de la base : ${concepts}`,
    perMinuteRecord: "record sur une partie d'un chiffre par minute : pas d'outil typé",
    championDragonKills: "le champion qui a tué chaque dragon (seule son équipe est enregistrée)",
    championFigureUnsorted: (figure: string) => `classement de champions sur une statistique que l'outil ne trie pas (« ${figure} »)`,
    championLowest: "classement de champions du plus bas au plus haut : l'outil ne classe que du plus haut vers le bas",
    playerLowest: "classement des pires joueurs : les outils ne classent que du plus haut vers le bas",
    unsupported: (cue: string) => `métrique ou classement non couvert par les outils typés (« ${cue} »)`,
    playerVersusTeam: "confrontation joueur contre équipe : pas d'outil typé",
    championOfOne: "champion joué par un joueur ou une équipe précis : pas d'outil typé",
    teamIgnoredHistory: (mention: string, player: string) => `Équipe « ${mention} » ignorée : historique de ${player} toutes équipes confondues.`,
    onePlayerVersus: "un seul joueur reconnu pour une confrontation",
    playerHistory: "intention « historique joueur × compétition » → outil paramétré",
    oneTeamVersus: "une seule équipe reconnue pour une confrontation",
    teamAlone: "équipe seule → historique d'équipe",
    leagueAlone: "compétition sans joueur ni équipe → palmarès / classement",
    noMatchingTool: "aucun outil typé ne correspond aux entités reconnues",
    unreadIgnored: (reason: string, words: string) => `${reason} ; mots non lus ignorés : ${words}`,
    unreadShare: (reason: string, share: number, words: string) => `${reason} ; mots non compris (${share} %) : ${words}`,
    readNothing: "la donnée demandée (la requête générée ne lisait aucune donnée réelle)",
    modelSays: (model: string, text: string) => `${model} : ${text}`,
    leagueDropped: (league: string) => `compétition « ${league} » retirée : la question ne la nomme pas et aucune partie n'y correspond sur la période`,
    dataAbsent: "donnée absente",
    /** Data the questions ask for and no column holds. */
    concepts: { spells: "les sorts d'invocateur", mvp: "les distinctions MVP et joueur du match" },
    /** The language of this catalog, as the SQL prompt names it to the model. */
    promptLanguage: "French",
  },

  llm: {
    /** Shown to the user when the answer was produced without the LLM because of the quota. */
    quotaNote: "Le modèle de langage est indisponible pour le moment : les questions les plus libres peuvent rester sans réponse.",
    quotaError: "quota OpenRouter épuisé, bascule en mode déterministe",
  },

  decide: {
    /** A decider as the trace names it; a name without an entry is shown as it is. */
    names: OWN_NAMES,
    failed: (who: string, error: string) => `${who}: erreur (${error})`,
    unavailable: (who: string) => `${who}: indisponible`,
    confidence: (who: string, value: string) => `${who}: confiance ${value}`,
  },

  period: {
    before: (first: number) => `La base commence en ${first} : cette année est hors couverture.`,
    future: (year: number) => `Cette année est future : la couverture s'arrête en ${year}.`,
  },

  understand: {
    exactCase: (mention: string) => `casse exacte « ${mention} »`,
    onlyInContext: (games: number) => `seul à avoir joué dans le contexte de la question (${games} parties)`,
    moreInContext: (games: number, next: number) => `plus de parties dans le contexte de la question (${games} contre ${next})`,
    moreOverall: (games: number, next: number) => `plus de parties au total (${games} contre ${next})`,
    outOfScope: (mention: string) => `hors périmètre : « ${mention} »`,
    nothingKnown: "aucun joueur, équipe ou champion connu dans la question",
    recognized: (n: number) => `${n} entité(s) reconnue(s) par les tables d'alias`,
    extracted: (model: string, n: number) => `${model} : ${n} mention(s) extraite(s)`,
  },
};

export type Messages = typeof fr;

const en: Messages = {
  run: {
    cascade: (attempts) => `cascade: ${attempts}`,
    examples: ["Chovy's results at every Worlds", "T1 vs Gen.G in LCK", "Ahri stats at Worlds 2024", "Who won MSI"],
    candidate: (player, games) => `${player} (${games} games)`,
    otherCandidates: (n) => ` and ${n} more`,
    ambiguity: (mention, list, player, reason) => `"${mention}" names several players: ${list}. Kept: ${player}, ${reason}.`,
    uncertainChoice: " Uncertain choice: give the exact handle if this is not the right player.",

    analysing: "Reading the question…",
    viaAlias: (alias) => ` through the alias "${alias}"`,
    homonyms: (list, more, reason, uncertain) => `; homonyms: ${list}${more ? "…" : ""} (choice: ${reason}${uncertain ? ", uncertain" : ""})`,
    playerLine: (mention, player, ids, rest) => `player "${mention}" → ${player}${ids ? ` (${ids})` : ""}${rest}`,
    teamLine: (mention, team, members) => `team "${mention}" → ${team}${members ? ` (${members})` : ""}`,
    championLine: (mention, champion) => `champion "${mention}" → ${champion}`,
    opponentLine: (mention, champion) => `opponent "${mention}" → ${champion}`,
    unknownPlayer: (mention) => `"${mention}": no known player`,
    leagueLine: (league, mention) => `competition → ${league ?? "not given"}${mention ? ` ("${mention}")` : ""}`,
    periodLine: (from, to, split) => `period → ${from ?? "start"} – ${to ?? "today"}${split ? ` · ${split} split` : ""}`,
    outOfScopeLine: (mention) => `out of scope → "${mention}"`,
    recognized: "Entities recognized",
    noEntity: "No entity recognized",
    outOfScopeNamed: (mention) => `Out of scope (${mention})`,
    ambiguousAlias: " · ambiguous alias",

    sqlFallbackDetail: {
      ready: "Text-to-SQL produced nothing.",
      missing: "Deterministic mode (no OPENROUTER_API_KEY): the text-to-SQL fallback is off.",
      exhausted: "Deterministic mode (OpenRouter quota used up): the text-to-SQL fallback is off for now.",
    },
    sqlFallbackTitle: {
      ready: "No query",
      missing: "text-to-SQL needed (off without a key)",
      exhausted: "text-to-SQL needed (quota used up)",
    },
    building: "Building the query…",
    outOfScopeQuestion: "Question out of scope",
    outOfScope: "Out of scope",
    missingData: "Data missing from the database",
    noQuery: (reason) => `${reason}\nNo query: a figure would be made up.`,
    noTool: "No typed tool covers the question",
    typedTool: (label) => `Typed tool: ${label}`,
    generatedQuery: "Generated query (text-to-SQL)",
    parameters: (json) => `parameters: ${json}`,
    toolDone: (intent) => `typed tool ${intent}`,

    guardRejected: (attempt) => `Attempt ${attempt}: rejected by the guard`,
    guardOk: (attempt, tool) => `Attempt ${attempt}: guard OK (read-only, 1 statement, ${tool ? "allow list" : "v_* views"}, forced LIMIT, prepare)`,
    rowsIn: (rows, ms) => `${rows} row(s) in ${ms} ms`,
    emptyIn: (ms) => `Empty result (${ms} ms)`,
    emptyResult: "empty result",
    sqliteError: "SQL error",
    executing: "Running…",
    rowsDone: (rows, fixes) => `${rows} row(s)${fixes ? `, after ${fixes} correction(s)` : ""}`,
    emptyExplained: "Empty result explained by the scope, no other attempt",
    noRowsAfter: (attempts) => `No row after ${attempts} attempts`,
    givenUpAfter: (attempts) => `Given up after ${attempts} attempts`,
    noFix: "No correction possible",
    noRows: "No row",
    failed: "Failed",
    selfCorrection: (reason) => `Self-correction: ${reason}`,
    nothingToRun: "Nothing to run",
    internalError: "Internal error.",
    stepInterrupted: "Step interrupted",

    summaryPrompt:
      "Rephrase these facts as one or two summary sentences in English that answer the question. " +
      "Keep their figures and their scope (competition, editions, period) exactly: " +
      "add no figure, no period (season, current year…) and no interpretation the facts do not hold.",
    factsKey: "facts",
    summaryFromAggregates: "summary from the aggregates",
    summaryRejected: (beyond) => `summary rejected, not in the facts: ${beyond}`,

    outOfScopeSummary: (reason, scope) => `Question out of scope: ${reason}. The database covers: ${scope}.`,
    noToolFor: (detail) => `No typed tool covers this question (${detail})`,
    routing: "routing",
    searchGaveNothing: "I cannot answer this question yet: my search returned nothing. Try rephrasing it, or one of the questions below.",
    cannotAnswerYet: "I cannot answer this question yet. Try rephrasing it, or one of the questions below.",
    noResultFor: (who, league) => `No result${who ? ` for ${who}` : ""}${league ? ` (${league})` : ""} in the database.`,
    missingHead: (missing) => `Data missing from the database: ${missing}. `,
    missingForScope:
      "In-game statistics (gold, CS and XP at key minutes, first blood, solo kills, multi-kills, wards, plates, first objectives) " +
      "come from the Riot data Leaguepedia publishes for part of the matches, and it publishes none for this scope (none for the LPL). " +
      "Results, drafts and end-of-game statistics (kills, deaths, assists, gold, CS, damage, vision, objectives) remain available there: so no in-game figure is given.",
    missingInGeneral:
      "The database holds results, drafts, end-of-game statistics (kills, deaths, assists, gold, CS, damage, vision, items, keystone, objectives) " +
      "and, for the games whose Riot data Leaguepedia publishes, in-game statistics: so no figure is given.",

    formatting: "Laying out…",
    missingFormatted: "\"Missing data\" answer laid out, without a figure",
    timedOut: "The query ran past its time limit and was stopped. Name a competition or a shorter period.",
    guardRefused: "The query was rejected by the guard. No result can be concluded.",
    queryFailed: "The query failed while running. No result can be concluded.",
    interruptedOrRejected: "Query interrupted or rejected",
    failureTitle: "Query failed",
    unrecognizedQuestion: "Question not recognized",
    noResult: "No result",
    emptyExplainedBy: (reason) => `Empty answer explained (${reason})`,
    emptyFormatted: "Empty answer laid out",
    genericTable: (rows, columns) => `Generic table (${rows} rows, ${columns} columns)`,
    rowCount: (rows) => `${rows} rows`,
    generatedSummary: (rows) => `${rows} row(s) returned by a generated query, checked by the guard.`,
    summaryBy: (llm) => `Summary (${llm ? "LLM" : "sentence template"})`,
    timelineShown: (points, events) => `Timeline: ${points} gold points, ${events} events`,
    tableShown: (rows) => `Table of ${rows} rows`,
    formatted: (shown, sources, followUps, ms) => `${shown}, ${sources} sources, ${followUps} follow-ups, layout queries in ${ms} ms`,
    eventCount: (events) => `${events} events`,
    formatDone: (shown, sources) => `${shown} · ${sources} sources`,
    leagueNames: (names) => `The period covers several league names: ${names}.`,
  },

  route: {
    noLeagueWorldsRanking: "No competition given: ranking over Worlds.",
    noLeagueWorldsSearch: "No competition given: search over Worlds.",
    noLeagueAll: "No competition given: all competitions together.",
    noLeagueDragons: "No competition given: dragons of every competition with in-game data.",
    noLeagueIngameRanking: "No competition given: ranking over every competition with in-game data.",
    championRanking: (sort, total, role, side) => `champion ranking (sorted by: ${sort}${total ? ", totals" : ""}${role ? `, role ${role}` : ""}${side ? `, ${side} side` : ""})`,
    playerRanking: (role, criterion, side) => `player ranking${role ? ` for the ${role} role` : ""} (criterion: ${criterion}${side ? `, ${side} side` : ""})`,
    teamRanking: (criterion, ascending, side) => `team ranking (criterion: ${criterion}${ascending ? ", ascending" : ""}${side ? `, ${side} side` : ""})`,
    leagueScope: (short) => (!short ? "this competition" : englishBare(short) ? short : `the ${short}`),
    ingameStats: (mention) => `in-game statistics (${mention})`,
    ingameFor: (what, scope) => `${what} for ${scope}`,
    noRiotGames: (league, year) => `no game of ${league} ${year ?? ""} with Riot data on Leaguepedia`.replace(/\s+/g, " "),
    minuteOnly: (mention, asked, minutes) => `${mention} at ${asked} min (recorded only at ${minutes.join(", ").replace(/, (\d+)$/, " and $1")} min)`,
    minuteAbsent: (asked) => `minute ${asked} is not in the in-game data`,
    ingameOf: (what, who, league) => `${what} of ${who}${league ? ` ${englishIn(league)}` : ""}`,
    noRiotGamesOf: (who) => `no game of ${who} with Riot data in this scope`,
    dragons: (mention) => `dragons by element and souls ("${mention}")`,
    teamMetricForPlayer: (mention) => `team metric ("${mention}") asked for a player`,
    playerIngame: (mention) => `in-game statistic of a player ("${mention}")`,
    playerMetricForTeam: (mention) => `individual metric ("${mention}") asked for a team`,
    teamIngame: (mention) => `in-game profile of a team ("${mention}")`,
    dragonElementRanking: (mention) => `ranking on a dragon element ("${mention}") without a typed tool`,
    rankingUntyped: (mention) => `ranking on "${mention}" without a typed tool`,
    ingameRanking: (mention) => `ranking on an in-game statistic ("${mention}")`,
    ingameUntyped: (mention) => `in-game statistic ("${mention}") without a typed tool for these entities`,
    gameTimeline: "how a game went (timeline, gold curve)",
    gameByNumber: "game named by its number in a series",
    onlyTwoTeamsKept: (a, b) => `More than two teams recognized: only ${a} and ${b} are kept.`,
    phaseSeries: (cue) => `competition phase ("${cue}") → best-of series`,
    twoTeamsSeries: (cue) => `two teams and "${cue}" over a season → their best-of series`,
    snapshotMinutes: (mention, asked) => `In-game data records gold, CS and XP only at 10, 15 and 20 min: no "${mention}" at ${asked} min.`,
    teamStatNotCompared: (mention) => `"${mention}" is a team statistic: the comparison of two players does not hold it.`,
    onlyTwoPlayers: (a, b) => `Several players recognized: only ${a} and ${b} are compared.`,
    twoPlayers: (cue, first) => (cue ? `two players set against each other ("${cue}") → comparison` : "two players → comparison") + (first ? `, "${first}" first` : ""),
    twoTeams: (cue) => (cue ? `two teams set against each other ("${cue}") → head-to-head` : "two teams → head-to-head"),
    onlyTwoTeamsOpposed: (a, b) => `Several teams recognized: only ${a} and ${b} are set against each other.`,
    roster: (cue, role) => (cue ? `a team and "${cue}" → roster by role` : `a team and a role (${role}) → roster, the role asked first`),
    teamIgnoredPool: (mention, name) => `Team "${mention}" ignored: champion pool of ${name} across all teams.`,
    roleNotFiltered: "Role not filtered: pool of the whole team, with the player of each champion.",
    pool: (team, cue) => `${team ? "a team" : "a player"} and "${cue}" → champion pool`,
    matchup: (opponent, cue) => (opponent ? `two champions set against each other ("${cue}") → their matchup` : `a champion and "${cue}" → its lane opponents`),
    singleGameRecord: (metric, player) => `single-game record (${metric})${player ? ` of ${player}` : ""}`,
    recentGames: (cue) => `a player and "${cue}" → their latest games`,
    playerTeam: (cue, team) => `a player and "${cue}" → roster of their team (${team})`,
    playerTeamAsked: (player, team) => `Team of ${player} over the period asked: ${team}.`,
    playerTeamLatest: (player, team, year) => `No period given: latest team of ${player} (${team}, ${year}).`,
    playerTeamOthers: (player, teams) => `${player} also played for ${teams} over this period: only their latest team is shown.`,
    teamIgnoredRecent: (mention, player) => `Team "${mention}" ignored: latest games of ${player} across all teams.`,
    championAlone: "champion alone → the champion's stats in the competition",
    notInScope: (mention) => `"${mention}" is not in the scope (Worlds, MSI, LCK, LPL, LEC, LCS, LFL…)`,
    noEsport: "no League of Legends esports entity or notion in the question",
    missing: (concepts) => `data missing from the database: ${concepts}`,
    perMinuteRecord: "single-game record of a per-minute figure: no typed tool",
    championDragonKills: "the champion that killed each dragon (only its team is recorded)",
    championFigureUnsorted: (figure) => `champion ranking on a statistic the tool does not sort by ("${figure}")`,
    championLowest: "champion ranking from the lowest up: the tool only ranks from the highest down",
    playerLowest: "ranking of the worst players: the tools only rank from the highest down",
    unsupported: (cue) => `metric or ranking the typed tools do not cover ("${cue}")`,
    playerVersusTeam: "player against team: no typed tool",
    championOfOne: "champion played by one given player or team: no typed tool",
    teamIgnoredHistory: (mention, player) => `Team "${mention}" ignored: history of ${player} across all teams.`,
    onePlayerVersus: "only one player recognized for a head-to-head",
    playerHistory: "intent \"player history × competition\" → parameterized tool",
    oneTeamVersus: "only one team recognized for a head-to-head",
    teamAlone: "team alone → team history",
    leagueAlone: "competition without a player or a team → winners / standings",
    noMatchingTool: "no typed tool matches the recognized entities",
    unreadIgnored: (reason, words) => `${reason}; unread words ignored: ${words}`,
    unreadShare: (reason, share, words) => `${reason}; words not understood (${share}%): ${words}`,
    readNothing: "the data asked (the generated query read no real data)",
    modelSays: (model, text) => `${model}: ${text}`,
    leagueDropped: (league) => `competition "${league}" removed: the question does not name it and no game matches it over the period`,
    dataAbsent: "data missing",
    concepts: { spells: "summoner spells", mvp: "MVP and player-of-the-game awards" },
    promptLanguage: "English",
  },

  llm: {
    quotaNote: "The language model is unavailable for now: the most open-ended questions may stay unanswered.",
    quotaError: "OpenRouter quota used up, switching to deterministic mode",
  },

  decide: {
    names: {
      "regex + alias": "regex + alias",
      "outil typé": "typed tool",
      "choix d'outil": "tool choice",
      "corrections déterministes": "deterministic corrections",
      "réparation SQL": "SQL repair",
      "modèle de phrase": "sentence template",
      rédaction: "writing",
    },
    failed: (who, error) => `${who}: error (${error})`,
    unavailable: (who) => `${who}: unavailable`,
    confidence: (who, value) => `${who}: confidence ${value}`,
  },

  period: {
    before: (first) => `The database starts in ${first}: that year is not covered.`,
    future: (year) => `That year is in the future: coverage stops in ${year}.`,
  },

  understand: {
    exactCase: (mention) => `exact case "${mention}"`,
    onlyInContext: (games) => `the only one who played in the context of the question (${games} games)`,
    moreInContext: (games, next) => `more games in the context of the question (${games} against ${next})`,
    moreOverall: (games, next) => `more games overall (${games} against ${next})`,
    outOfScope: (mention) => `out of scope: "${mention}"`,
    nothingKnown: "no known player, team or champion in the question",
    recognized: (n) => `${n} entity(ies) recognized by the alias tables`,
    extracted: (model, n) => `${model}: ${n} mention(s) extracted`,
  },
};

const MESSAGES: Record<Locale, Messages> = { fr, en };

// The language of the answer follows the request through every step without a parameter on each function.
const requestLocale = new AsyncLocalStorage<Locale>();

export const withLocale = <T>(locale: Locale, run: () => T): T => requestLocale.run(locale, run);

export const answerLocale = (): Locale => requestLocale.getStore() ?? DEFAULT_LOCALE;

/**
 * A text written where it is used, in the language of the request: the tools build their sentences from many
 * small parts, each one next to the figures it names.
 */
export const say = <T>(fr: T, en: T): T => (answerLocale() === "fr" ? fr : en);

/** A label kept in a table read later, in both languages. */
export type Phrase = Record<Locale, string>;

export const phrase = (fr: string, en: string): Phrase => ({ fr, en });

export const tr = (phrase: Phrase): string => phrase[answerLocale()];

/** The agent's texts in the language of the request. */
export const msg = (): Messages => MESSAGES[answerLocale()];

/** The same texts for a named language, outside a request's run (the stream's own error). */
export const messagesIn = (locale: Locale): Messages => MESSAGES[locale];
