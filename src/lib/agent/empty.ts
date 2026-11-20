/**
 * Why a query came back empty. An empty result is an answer when the scope
 * the question names explains it: no game at all, games only in regional
 * qualifiers (excluded by default), or a count that is truly zero over the
 * games that hold in-game data. The probes read the scope from the resolved
 * entities, never from the generated SQL, so a wrong filter in that SQL
 * cannot make an empty scope look like a real zero.
 */
import { z } from "zod";
import { type Db, selectAll, selectOne } from "../db";
import { leagueMembers } from "../domain/leagues";
import { PLAYER_METRIC_DEFS, TEAM_METRIC_DEFS } from "./metrics";
import { say } from "./messages";
import { allCompetitions, scopeLabel } from "./tools";
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
 * Filters on the columns v_game_players and the in-game views share, for at
 * most one player and one team. On the player view the player (or, without
 * one, the team) filters the row, with the champion on the same row ("Faker
 * sur Azir"); on the team view the team filters the row and the player and
 * the champion filter the game.
 */
function scopeFilter(e: Entities, alias: string, view: "player" | "team") {
  const params: Params = {};
  const where: string[] = [];
  const list = (prefix: string, values: string[]) => values.map((v, i) => ((params[`${prefix}${i}`] = v), `:${prefix}${i}`)).join(", ");

  const sameGame = (column: string, prefix: string, values: string[]) =>
    `${alias}.game_id IN (SELECT game_id FROM v_game_players WHERE ${column} IN (${list(prefix, values)}))`;

  const player = e.players[0]?.player;
  const team = e.teams[0]?.members;

  if (player && view === "player") {
    where.push(`${alias}.player = :player`);
    params.player = player;
  } else if (player) where.push(sameGame("player", "p", [player]));

  if (e.champion && view === "player") {
    where.push(`${alias}.champion = :champion`);
    params.champion = e.champion.champion;
  } else if (e.champion) where.push(sameGame("champion", "c", [e.champion.champion]));

  if (team && (view === "team" || !player)) where.push(`${alias}.team IN (${list("t", team)})`);
  else if (team) where.push(sameGame("team", "t", team));

  if (e.league) where.push(`${alias}.league IN (${list("league", leagueMembers(e.league, e.yearFrom, e.yearTo))})`);

  if (e.yearFrom != null) {
    where.push(`${alias}.year >= :yearFrom`);
    params.yearFrom = e.yearFrom;
  }

  if (e.yearTo != null) {
    where.push(`${alias}.year <= :yearTo`);
    params.yearTo = e.yearTo;
  }

  if (e.split) {
    where.push(`${alias}.tournament_page IN (SELECT st.tournament_page FROM v_tournaments st WHERE st.split = :split)`);
    params.split = e.split;
  }

  return { where, params };
}

/** "Faker sur Azir aux Worlds en 2024", "Orianna aux Worlds en 2026", "aux Worlds en 2024". */
function scopeText(e: Entities) {
  const players = e.players.map((p) => p.player);
  const named = [...players, ...e.teams.map((t) => t.team)].join(say(" et ", " and "));
  const champion = e.champion ? (named ? say(` sur ${e.champion.champion}`, ` on ${e.champion.champion}`) : e.champion.champion) : "";
  const period = { yearFrom: e.yearFrom, yearTo: e.yearTo };
  const where = [e.split ? say(`au split ${e.split}`, `in the ${e.split} split`) : "", scopeLabel(e.leagueShort ?? e.league ?? allCompetitions(), period)].filter(Boolean).join(" ");

  return { subject: `${named}${champion}`, where };
}

/** "de Faker…", "d'Orianna…" / "of Faker…". */
const of = (s: string) => say(/^[aeiouyhàâéèêîôû]/i.test(s) ? `d'${s}` : `de ${s}`, `of ${s}`);

/** "3 parties" / "3 games", "1 partie" / "1 game". */
const games = (n: number) => say(`${n} partie${n > 1 ? "s" : ""}`, `${n} game${n === 1 ? "" : "s"}`);

/** "pentakills" → "aucun pentakill", "plaques de tourelle" → "aucune plaque de tourelle" / "no pentakill", "no turret plate". */
const none = (label: { label: string; en: string }) =>
  say(`${/^(?:plaque|première)/.test(label.label) ? "aucune" : "aucun"} ${label.label.replace(/(kill|blood|plaque)s\b/, "$1")}`, `no ${label.en.replace(/(kill|blood|plate|dragon)s\b/, "$1")}`);

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

const QualifierMatch = z.object({
  played_at: z.number().nullable(),
  tournament: z.string().nullable(),
  tournament_page: z.string(),
  blue_team: z.string().nullable(),
  red_team: z.string().nullable(),
  winner: z.string().nullable(),
});

const date = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString().slice(0, 10));

/** The in-game view a generated query reads, and the count columns it sums there. */
function countedColumns(sql: string): { view: "v_game_player_stats" | "v_game_team_stats"; columns: { column: string; label: string; en: string }[] } | null {
  const view = /\bfrom\s+(v_game_player_stats|v_game_team_stats)\b/i.exec(sql)?.[1]?.toLowerCase();

  if (view !== "v_game_player_stats" && view !== "v_game_team_stats") return null;
  const defs = Object.values(view === "v_game_player_stats" ? PLAYER_METRIC_DEFS : TEAM_METRIC_DEFS).filter((d) => d.aggregate !== "avg" && !d.snapshot);
  const summed = [...sql.matchAll(/\b(?:sum|total)\s*\(\s*(?:\w+\.)?(\w+)\s*\)/gi)].map((m) => m[1].toLowerCase());
  const columns = [...new Set(summed)].flatMap((c) => defs.filter((d) => d.column === c).map((d) => ({ column: c, label: d.label, en: d.en })));

  return columns.length ? { view, columns } : null;
}

/**
 * Explains an empty result from the question's scope. `sql` is the query that
 * came back empty: a generated one may sum a count column that is zero.
 * Returns null when the question names no scope at all, or several players or teams.
 */
export async function explainEmpty(db: Db, entities: Entities, sql: string): Promise<EmptyExplanation | null> {
  const hasScope = entities.players.length || entities.teams.length || entities.champion || entities.league || entities.yearFrom != null || entities.yearTo != null;

  // Several players or teams: their games together, or each one's own? The question does not say, so nothing is concluded.
  if (!hasScope || entities.players.length > 1 || entities.teams.length > 1) return null;
  const { subject, where } = scopeText(entities);
  const scope = [subject, where].filter(Boolean).join(" ");
  const filter = scopeFilter(entities, "gp", "player");
  const clause = filter.where.length ? `WHERE ${filter.where.join(" AND ")}` : "";

  const stages = await selectAll(
    db,
    Stage,
    `SELECT gp.stage = 'qualifier' AS qualifier, COUNT(DISTINCT gp.game_id) AS games FROM v_game_players gp ${clause} GROUP BY 1`,
    filter.params,
  );

  const qualifier = stages.find((s) => s.qualifier)?.games ?? 0;
  const main = stages.find((s) => !s.qualifier)?.games ?? 0;
  const empty = { table: null, sources: [] };

  if (!main && !qualifier)
    return { ...empty, reason: "no_games", conclusive: true, title: say("Aucune partie", "No game"), summary: say(`Aucune partie ${subject ? of(scope) : where} dans la base.`, `No game ${subject ? of(scope) : where} in the database.`) };

  if (!main) {
    const lead = say(
      qualifier === 1 ? `La seule partie ${subject ? of(scope) : where} est` : `Les ${qualifier} parties ${subject ? of(scope) : where} sont toutes`,
      qualifier === 1 ? `The only game ${subject ? of(scope) : where} is` : `The ${qualifier} games ${subject ? of(scope) : where} are all`,
    );

    const qualifiers = [...filter.where, "gp.stage = 'qualifier'"].join(" AND ");
    let table: EmptyExplanation["table"];
    let pages: { tournament: string | null; tournament_page: string }[];

    // A player or a champion: their row of each game. A team or a league alone: one row per game.
    if (entities.players.length || entities.champion) {
      const games = await selectAll(
        db,
        QualifierGame,
        `SELECT gp.played_at, gp.tournament, gp.tournament_page, gp.player, gp.team, gp.champion, gp.win, gp.kills, gp.deaths, gp.assists, gp.keystone
         FROM v_game_players gp WHERE ${qualifiers} ORDER BY gp.played_at, gp.game_id LIMIT ${SHOWN_GAMES}`,
        filter.params,
      );

      pages = games;
      table = {
        columns: say(["date", "tournoi", "joueur", "équipe", "champion", "résultat", "K/D/A", "rune"], ["date", "tournament", "player", "team", "champion", "result", "K/D/A", "rune"]),
        rows: games.map((g) => [
          date(g.played_at),
          g.tournament,
          g.player,
          g.team,
          g.champion,
          g.win == null ? null : g.win ? say("victoire", "win") : say("défaite", "loss"),
          g.kills == null ? null : `${g.kills}/${g.deaths}/${g.assists}`,
          g.keystone,
        ]),
      };
    } else {
      const games = await selectAll(
        db,
        QualifierMatch,
        `SELECT g.played_at, g.tournament, g.tournament_page, g.blue_team, g.red_team, g.winner FROM v_games g
         WHERE g.game_id IN (SELECT gp.game_id FROM v_game_players gp WHERE ${qualifiers}) ORDER BY g.played_at, g.game_id LIMIT ${SHOWN_GAMES}`,
        filter.params,
      );

      pages = games;
      table = {
        columns: say(["date", "tournoi", "bleu", "rouge", "vainqueur"], ["date", "tournament", "blue", "red", "winner"]),
        rows: games.map((g) => [date(g.played_at), g.tournament, g.blue_team, g.red_team, g.winner]),
      };
    }

    const tournaments = [...new Set(pages.map((g) => g.tournament ?? g.tournament_page))];

    const shown = say(
      qualifier === 1 ? "la voici" : qualifier > SHOWN_GAMES ? `voici les ${SHOWN_GAMES} premières` : "les voici",
      qualifier === 1 ? "here it is" : qualifier > SHOWN_GAMES ? `here are the first ${SHOWN_GAMES}` : "here they are",
    );

    return {
      reason: "qualifier_only",
      conclusive: true,
      title: say("Seulement en qualifications", "Only in qualifiers"),
      summary: say(
        `${lead} en qualifications régionales (${tournaments.join(", ")}), que les réponses excluent par défaut : ${shown}.`,
        `${lead} in regional qualifiers (${tournaments.join(", ")}), which answers exclude by default: ${shown}.`,
      ),
      table,
      sources: [...new Set(pages.map((g) => g.tournament_page))],
    };
  }

  const counted = countedColumns(sql);

  if (counted) {
    const stats = scopeFilter(entities, "s", counted.view === "v_game_player_stats" ? "player" : "team");

    // A NULL is a statistic the Riot data does not give (plates before 2020…): each column is a zero only over the games that measure it.
    const sums = counted.columns
      .map((c, i) => `COALESCE(SUM(s.${c.column}), 0) AS c${i}, COUNT(DISTINCT CASE WHEN s.${c.column} IS NOT NULL THEN s.game_id END) AS m${i}`)
      .join(", ");

    const row = (await selectOne(
      db,
      z.record(z.string(), z.number()),
      `SELECT COUNT(DISTINCT s.game_id) AS games, ${sums} FROM ${counted.view} s WHERE ${[...stats.where, "s.stage <> 'qualifier'"].join(" AND ")}`,
      stats.params,
    ))!;

    const { games } = row;
    // The fewest games that measure one of the columns: the sample every zero holds on.
    const measuredGames = Math.min(...counted.columns.map((_, i) => row[`m${i}`]));
    const scopeOf = subject ? of(scope) : where;

    if (!games)
      return {
        ...empty,
        reason: "no_ingame",
        conclusive: true,
        title: say("Pas de données in-game", "No in-game data"),
        summary: say(
          `${main === 1 ? `La seule partie ${scopeOf} n'a pas` : `Aucune des ${main} parties ${scopeOf} n'a`} de données in-game (les statistiques Riot que Leaguepedia publie) : le total demandé ne peut pas être calculé.`,
          `${main === 1 ? `The only game ${scopeOf} has no` : `None of the ${main} games ${scopeOf} has`} in-game data (the Riot statistics Leaguepedia publishes): the total asked cannot be computed.`,
        ),
      };

    if (measuredGames > 0 && counted.columns.every((_, i) => row[`c${i}`] === 0)) {
      const what = capitalized(counted.columns.map((c) => none(c)).join(", "));
      const unmeasured = main - measuredGames;

      return {
        ...empty,
        reason: "zero_count",
        conclusive: true,
        title: what,
        summary: say(
          `${what} sur ${measuredGames === 1 ? "la seule partie" : `les ${measuredGames} parties`} avec données in-game ${scopeOf} (qualifications exclues` +
            `${unmeasured > 0 ? `, ${unmeasured} ${unmeasured > 1 ? "autres parties" : "autre partie"} sans cette donnée` : ""}).`,
          `${what} over ${measuredGames === 1 ? "the only game" : `the ${measuredGames} games`} with in-game data ${scopeOf} (qualifiers excluded` +
            `${unmeasured > 0 ? `, ${unmeasured} other game${unmeasured === 1 ? "" : "s"} without this data` : ""}).`,
        ),
      };
    }
  }

  return {
    ...empty,
    reason: "unexplained",
    conclusive: false,
    title: say("Pas de résultat", "No result"),
    summary: say(
      `La requête n'a renvoyé aucune ligne, alors que la base compte ${games(main)} ${subject ? of(scope) : where} (qualifications exclues).`,
      `The query returned no row, although the database holds ${games(main)} ${subject ? of(scope) : where} (qualifiers excluded).`,
    ),
  };
}

/** Words that link two names ("Orianna vs Azir"): read by no rule, yet no name either. */
const CONNECTORS = new Set(["vs", "versus", "contre", "against", "face"]);

/** What the question names that nothing recognized: said in every empty answer. */
export function unrecognizedNote(entities: Entities, unread: string[]): string | null {
  const words = [...new Set([...entities.unresolved, ...unread])].filter((w) => !CONNECTORS.has(w.toLowerCase()));

  if (!words.length) return null;

  return say(
    `${words.length > 1 ? "Mots non reconnus" : "Mot non reconnu"} comme joueur, équipe ou champion : ${words.map((w) => `« ${w} »`).join(", ")}.`,
    `${words.length > 1 ? "Words" : "Word"} not recognized as a player, a team or a champion: ${words.map((w) => `"${w}"`).join(", ")}.`,
  );
}
