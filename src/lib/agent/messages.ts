import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, type Locale } from "../locale";
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
    sqliteError: "Erreur SQLite",
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
    internalError: "Erreur interne de l'agent.",
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
    generatedGaveNothing: (why: string) => `${why} et la requête générée n'a rien donné.`,
    fallbackExhausted: (why: string) => `${why}. Le text-to-SQL de secours est indisponible pour le moment (quota du modèle épuisé).`,
    fallbackNoKey: (why: string) => `${why}. Le text-to-SQL de secours demande une clé OpenRouter, absente ici.`,
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

  llm: {
    /** Shown to the user when the answer was produced without the LLM because of the quota. */
    quotaNote: "Le quota du modèle de langage est épuisé pour le moment : réponse en mode déterministe (règles et outils typés uniquement, sans text-to-SQL).",
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
    sqliteError: "SQLite error",
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
    internalError: "Internal agent error.",
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
    generatedGaveNothing: (why) => `${why} and the generated query returned nothing.`,
    fallbackExhausted: (why) => `${why}. The text-to-SQL fallback is unavailable for now (model quota used up).`,
    fallbackNoKey: (why) => `${why}. The text-to-SQL fallback needs an OpenRouter key, missing here.`,
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

  llm: {
    quotaNote: "The language model quota is used up for now: answer in deterministic mode (rules and typed tools only, without text-to-SQL).",
    quotaError: "OpenRouter quota used up, switching to deterministic mode",
  },

  decide: {
    names: {
      "regex + alias": "regex + alias",
      "outil typé": "typed tool",
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

/** The agent's texts in the language of the request. */
export const msg = (): Messages => MESSAGES[answerLocale()];

/** The same texts for a named language, outside a request's run (the stream's own error). */
export const messagesIn = (locale: Locale): Messages => MESSAGES[locale];
