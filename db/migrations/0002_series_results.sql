-- Schema v11 (src/lib/db/schema.ts): the series Leaguepedia lists on its match schedule (MatchSchedule) without any
-- scoreboard game, with their result alone and no game statistic (scripts/data/schedule.ts). It only adds a table and a
-- view: the code of migration 1 reads a database at this migration unchanged.
-- winner_side is 1 (team1) or 2 (team2); forfeit is the side that forfeited, NULL when the series was played; the
-- scores are NULL when the schedule has none.

CREATE TABLE series_results (
  id integer PRIMARY KEY, tournament_id integer NOT NULL, tab text COLLATE "C", match_n integer,
  team1_id integer NOT NULL, team2_id integer NOT NULL, winner_side integer NOT NULL, team1_score integer,
  team2_score integer, forfeit integer, played_at integer);

-- Count them with the series of v_games, never as games with statistics.
CREATE VIEW v_series_results AS
  SELECT s.id AS series_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, s.tab, s.match_n, s.played_at,
         a.name AS team1, b.name AS team2, CASE s.winner_side WHEN 1 THEN a.name ELSE b.name END AS winner,
         s.team1_score, s.team2_score,
         CASE s.forfeit WHEN 1 THEN a.name WHEN 2 THEN b.name END AS forfeited_by
  FROM series_results s JOIN tournaments t ON t.id = s.tournament_id JOIN leagues l ON l.id = t.league_id
  JOIN teams a ON a.id = s.team1_id JOIN teams b ON b.id = s.team2_id;
