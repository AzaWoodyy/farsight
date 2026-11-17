/**
 * Why a query came back empty. An empty result is an answer when the scope
 * the question names explains it: no game at all, games only in regional
 * qualifiers (excluded by default), or a count that is truly zero over the
 * games that hold in-game data. The probes read the scope from the resolved
 * entities, never from the generated SQL, so a wrong filter in that SQL
 * cannot make an empty scope look like a real zero.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { selectAll } from "../db";
import { leagueMembers } from "../domain/leagues";
import { PLAYER_METRIC_DEFS, TEAM_METRIC_DEFS } from "./metrics";
import { scopeLabel } from "./tools";
import type { Entities } from "./types";

export type EmptyReason = "no_games" | "qualifier_only" | "zero_count" | "no_ingame" | "unexplained";

export type EmptyExplanation = {
  reason: EmptyReason;
  /** True when no other query can do better: the self-correction stops. */
  conclusive: boolean;
  title: string;
  summary: string;
  /** The qualifier games, shown when they are the only ones. */
  table: { columns: string[]; rows: (string | number | null)[][] } | null;
  sources: string[];
};

type Params = Record<string, string | number>;

/** Most qualifier games listed when they are the only ones of the scope. */
const SHOWN_GAMES = 20;

/**
 * Filters on the columns v_game_players and the in-game views share. The first
 * player (or, without one, the first team) filters the row, with the champion
 * on the same row ("Faker sur Azir"); every other name filters the game.
 */
function scopeFilter(e: Entities, alias: string, view: "player" | "team") {
  const params: Params = {};
  const where: string[] = [];
  const list = (prefix: string, values: string[]) => values.map((v, i) => ((params[`${prefix}${i}`] = v), `:${prefix}${i}`)).join(", ");

  const sameGame = (column: string, prefix: string, values: string[]) =>
    `${alias}.game_id IN (SELECT game_id FROM v_game_players WHERE ${column} IN (${list(prefix, values)}))`;

  const [player, ...otherPlayers] = e.players.map((p) => p.player);
  const teams = e.teams.map((t) => t.members);
  const rowTeam = view === "team" || !player ? teams.shift() : undefined;

  if (player && view === "player") {
    where.push(`${alias}.player = :player`);
    params.player = player;
  } else if (player) where.push(sameGame("player", "p", [player]));

  if (e.champion && view === "player") {
    where.push(`${alias}.champion = :champion`);
    params.champion = e.champion.champion;
  } else if (e.champion) where.push(sameGame("champion", "c", [e.champion.champion]));

  if (rowTeam) where.push(`${alias}.team IN (${list("t", rowTeam)})`);
  otherPlayers.forEach((p, i) => where.push(sameGame("player", `op${i}_`, [p])));
  teams.forEach((members, i) => where.push(sameGame("team", `ot${i}_`, members)));

  if (e.league) where.push(`${alias}.league IN (${list("league", leagueMembers(e.league, e.yearFrom, e.yearTo))})`);

  if (e.yearFrom != null) {
    where.push(`${alias}.year >= :yearFrom`);
    params.yearFrom = e.yearFrom;
  }

  if (e.yearTo != null) {
    where.push(`${alias}.year <= :yearTo`);
    params.yearTo = e.yearTo;
  }

  return { where, params };
}

/** "Faker sur Azir aux Worlds en 2024", "Orianna aux Worlds en 2026", "aux Worlds en 2024". */
function scopeText(e: Entities) {
  const players = e.players.map((p) => p.player);
  const named = [...players, ...e.teams.map((t) => t.team)].join(" et ");
  const champion = e.champion ? (named ? ` sur ${e.champion.champion}` : e.champion.champion) : "";
  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };

  return { subject: `${named}${champion}`, where: scopeLabel(e.leagueShort ?? e.league ?? "toutes compétitions", period) };
}

/** "de Faker…", "d'Orianna…". */
const of = (s: string) => (/^[aeiouyhàâéèêîôû]/i.test(s) ? `d'${s}` : `de ${s}`);

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

/** "pentakills" → "pentakill": the singular after "aucun". */
const singular = (label: string) => label.replace(/(kill|blood)s\b/, "$1");

const Stage = z.object({ qualifier: z.number(), games: z.number() });

const QualifierGame = z.object({
  played_at: z.number().nullable(),
  tournament: z.string().nullable(),
  tournament_page: z.string(),
  player: z.string(),
  team: z.string().nullable(),
  champion: z.string().nullable(),
  win: z.number().nullable(),
  kills: z.number().nullable(),
  deaths: z.number().nullable(),
  assists: z.number().nullable(),
  keystone: z.string().nullable(),
});

const date = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString().slice(0, 10));

/** The in-game view a generated query reads, and the count columns it sums there. */
function countedColumns(sql: string): { view: "v_game_player_stats" | "v_game_team_stats"; columns: { column: string; label: string }[] } | null {
  const view = /\bfrom\s+(v_game_player_stats|v_game_team_stats)\b/i.exec(sql)?.[1]?.toLowerCase();

  if (view !== "v_game_player_stats" && view !== "v_game_team_stats") return null;
  const defs = Object.values(view === "v_game_player_stats" ? PLAYER_METRIC_DEFS : TEAM_METRIC_DEFS).filter((d) => d.aggregate !== "avg" && !d.snapshot);
  const summed = [...sql.matchAll(/\b(?:sum|total)\s*\(\s*(?:\w+\.)?(\w+)\s*\)/gi)].map((m) => m[1].toLowerCase());
  const columns = [...new Set(summed)].flatMap((c) => defs.filter((d) => d.column === c).map((d) => ({ column: c, label: d.label })));

  return columns.length ? { view, columns } : null;
}

/**
 * Explains an empty result from the question's scope. `sql` is the query that
 * came back empty: a generated one may sum a count column that is zero.
 * Returns null when the question names no scope at all.
 */
export function explainEmpty(db: DatabaseSync, entities: Entities, sql: string): EmptyExplanation | null {
  const hasScope = entities.players.length || entities.teams.length || entities.champion || entities.league || entities.yearFrom != null || entities.yearTo != null;

  if (!hasScope) return null;
  const { subject, where } = scopeText(entities);
  const scope = [subject, where].filter(Boolean).join(" ");
  const filter = scopeFilter(entities, "gp", "player");
  const clause = filter.where.length ? `WHERE ${filter.where.join(" AND ")}` : "";

  const stages = selectAll(
    db,
    Stage,
    `SELECT gp.stage = 'qualifier' AS qualifier, COUNT(DISTINCT gp.game_id) AS games FROM v_game_players gp ${clause} GROUP BY 1`,
    filter.params,
  );

  const qualifier = stages.find((s) => s.qualifier)?.games ?? 0;
  const main = stages.find((s) => !s.qualifier)?.games ?? 0;
  const empty = { table: null, sources: [] };

  if (!main && !qualifier)
    return { ...empty, reason: "no_games", conclusive: true, title: "Aucune partie", summary: `Aucune partie ${subject ? of(scope) : where} dans la base.` };

  if (!main) {
    const games = selectAll(
      db,
      QualifierGame,
      `SELECT gp.played_at, gp.tournament, gp.tournament_page, gp.player, gp.team, gp.champion, gp.win, gp.kills, gp.deaths, gp.assists, gp.keystone
       FROM v_game_players gp WHERE ${[...filter.where, "gp.stage = 'qualifier'"].join(" AND ")} ORDER BY gp.played_at, gp.game_id LIMIT ${SHOWN_GAMES * 10}`,
      filter.params,
    );

    // One row per game with a player or a champion; a team or a league alone would list every player of each game.
    const shown = entities.players.length || entities.champion ? games.slice(0, SHOWN_GAMES) : [];
    const tournaments = [...new Set(games.map((g) => g.tournament ?? g.tournament_page))];
    const lead = qualifier === 1 ? `La seule partie ${subject ? of(scope) : where} est` : `Les ${qualifier} parties ${subject ? of(scope) : where} sont toutes`;

    return {
      reason: "qualifier_only",
      conclusive: true,
      title: "Seulement en qualifications",
      summary: `${lead} en qualifications régionales (${tournaments.join(", ")}), que les réponses excluent par défaut${shown.length ? ` : ${qualifier === 1 ? "la voici" : "les voici"}` : ""}.`,
      table: shown.length ? {
        columns: ["date", "tournoi", "joueur", "équipe", "champion", "résultat", "K/D/A", "rune"],
        rows: shown.map((g) => [
          date(g.played_at),
          g.tournament,
          g.player,
          g.team,
          g.champion,
          g.win == null ? null : g.win ? "victoire" : "défaite",
          g.kills == null ? null : `${g.kills}/${g.deaths}/${g.assists}`,
          g.keystone,
        ]),
      } : null,
      sources: [...new Set(games.map((g) => g.tournament_page))],
    };
  }

  const counted = countedColumns(sql);

  if (counted) {
    const stats = scopeFilter(entities, "s", counted.view === "v_game_player_stats" ? "player" : "team");
    const sums = counted.columns.map((c, i) => `COALESCE(SUM(s.${c.column}), 0) AS c${i}`).join(", ");

    const row = z
      .record(z.string(), z.number())
      .parse(
        db
          .prepare(`SELECT COUNT(DISTINCT s.game_id) AS games, ${sums} FROM ${counted.view} s WHERE ${[...stats.where, "s.stage <> 'qualifier'"].join(" AND ")}`)
          .get(stats.params),
      );

    const games = row.games;
    const scopeOf = subject ? of(scope) : where;

    if (!games)
      return {
        ...empty,
        reason: "no_ingame",
        conclusive: true,
        title: "Pas de données in-game",
        summary: `Aucune des ${plural(main, "partie")} ${scopeOf} n'a de données in-game (les statistiques Riot que Leaguepedia publie) : le total demandé ne peut pas être calculé.`,
      };

    if (counted.columns.every((_, i) => row[`c${i}`] === 0)) {
      const what = counted.columns.map((c) => singular(c.label)).join(" ni ");

      return {
        ...empty,
        reason: "zero_count",
        conclusive: true,
        title: `Aucun ${what}`,
        summary: `Aucun ${what} sur les ${plural(games, "partie")} avec données in-game ${scopeOf} (qualifications exclues${games < main ? `, ${main - games} autres parties sans données in-game` : ""}).`,
      };
    }
  }

  return {
    ...empty,
    reason: "unexplained",
    conclusive: false,
    title: "Pas de résultat",
    summary: `La requête n'a renvoyé aucune ligne, alors que la base compte ${plural(main, "partie")} ${subject ? of(scope) : where} (qualifications exclues).`,
  };
}

/** Words that link two names ("Orianna vs Azir"): read by no rule, yet no name either. */
const CONNECTORS = new Set(["vs", "versus", "contre", "against", "face"]);

/** What the question names that nothing recognized: said in every empty answer. */
export function unrecognizedNote(entities: Entities, unread: string[]): string | null {
  const words = [...new Set([...entities.unresolved, ...unread])].filter((w) => !CONNECTORS.has(w.toLowerCase()));

  if (!words.length) return null;

  return `${words.length > 1 ? "Mots non reconnus" : "Mot non reconnu"} comme joueur, équipe ou champion : ${words.map((w) => `« ${w} »`).join(", ")}.`;
}
