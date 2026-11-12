import type { Entities, QueryPlan } from "./types";

/**
 * Templated query builder. The milestone supports one intent: a player's
 * history across editions of a competition. The SQL is still validated by the
 * schema guard like any generated query would be.
 */
export function buildPlayerEventHistory(
  entities: Entities,
  options: { period: boolean },
  attempt: number,
): QueryPlan {
  const player = entities.players[0];
  const params: Record<string, string | number> = {
    player: player.player,
    league: entities.league ?? "World Championship",
  };
  const periodFilters: string[] = [];
  if (options.period && entities.yearFrom != null) {
    periodFilters.push("AND t.year >= :yearFrom");
    params.yearFrom = entities.yearFrom;
  }
  if (options.period && entities.yearTo != null) {
    periodFilters.push("AND t.year <= :yearTo");
    params.yearTo = entities.yearTo;
  }

  const sql = `WITH player_games AS (
  SELECT t.year, t.event_page, gp.team, gp.champion, gp.win
  FROM games_players gp
  JOIN tournaments t ON t.overview_page = gp.overview_page
  WHERE gp.player = :player
    AND t.league = :league
    ${periodFilters.join("\n    ")}
),
champ_counts AS (
  SELECT year, event_page, team, champion, COUNT(*) AS games, SUM(win) AS wins
  FROM player_games
  GROUP BY year, event_page, team, champion
)
SELECT pg.year, pg.event_page, pg.team,
       SUM(pg.win) AS wins,
       COUNT(*) - SUM(pg.win) AS losses,
       tr.place, tr.place_number,
       (SELECT json_group_array(json_object('name', c.champion, 'games', c.games, 'wins', c.wins)
                ORDER BY c.games DESC, c.wins DESC, c.champion)
          FROM champ_counts c
         WHERE c.event_page = pg.event_page AND c.team = pg.team) AS champions
FROM player_games pg
LEFT JOIN tournament_results tr
  ON tr.event_page = pg.event_page AND tr.team = pg.team
GROUP BY pg.year, pg.event_page, pg.team
ORDER BY pg.year`.replace(/\n\s*\n/g, "\n");

  return {
    intent: "player_event_history",
    sql,
    params,
    filters: { period: options.period && (entities.yearFrom != null || entities.yearTo != null) },
    attempt,
  };
}
