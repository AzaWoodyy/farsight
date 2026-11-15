/** Shared contract of the read-only database. Rebuild from raw data after a schema change. */
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 6;

export const TABLE_DDL = `
CREATE TABLE leagues (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, short_name TEXT NOT NULL,
  region TEXT NOT NULL, is_international INT NOT NULL);
CREATE TABLE tournaments (
  id INTEGER PRIMARY KEY,
  page TEXT NOT NULL UNIQUE,          -- Leaguepedia OverviewPage, e.g. "2024 Season World Championship/Main Event"
  event_page TEXT NOT NULL,           -- page holding the final standings (parent event for Worlds/MSI stages)
  stage TEXT NOT NULL,                -- event | main_event | play_in | qualifier | season | playoffs
  name TEXT, league_id INT NOT NULL REFERENCES leagues(id),
  year INT, date_start TEXT, date_end TEXT, split TEXT);
CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE players (
  id INTEGER PRIMARY KEY, page TEXT NOT NULL UNIQUE, ign TEXT, real_name TEXT, native_name TEXT);
CREATE TABLE player_aliases (
  alias TEXT NOT NULL, raw TEXT NOT NULL, player_id INT NOT NULL,
  PRIMARY KEY (alias, player_id)) WITHOUT ROWID;
CREATE TABLE champions (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT);
-- kind: complete | boots | component | starter | consumable (src/lib/domain/items.ts), NULL when Data Dragon does not know the item
CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT NOT NULL, kind TEXT);
CREATE TABLE runes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);  -- keystones
CREATE TABLE tournament_results (
  tournament_id INT NOT NULL, team_id INT NOT NULL, place TEXT, place_number INT, prize_usd REAL,
  PRIMARY KEY (tournament_id, team_id)) WITHOUT ROWID;
CREATE TABLE games (
  id INTEGER PRIMARY KEY, tournament_id INT NOT NULL,
  -- from the ScoreboardGames GameId "<page>_<tab>_<match>_<game>": the tab of the tournament page
  -- (Finals, Semifinals, Week 3...), the match's number in that tab, the game's number in the match
  tab TEXT, match_n INT, game_n INT,
  blue_team_id INT, red_team_id INT, winner_side INT, length_s INT, patch TEXT, played_at INT,
  -- end-of-game objective counts from Leaguepedia scoreboards (every league)
  blue_dragons INT, red_dragons INT, blue_barons INT, red_barons INT, blue_towers INT, red_towers INT,
  blue_heralds INT, red_heralds INT, blue_void_grubs INT, red_void_grubs INT, blue_inhibitors INT, red_inhibitors INT);
-- Games with Riot JSON on Leaguepedia (none for the LPL): the source of the two tables below.
CREATE TABLE game_riot (
  game_id INTEGER PRIMARY KEY, riot_key TEXT NOT NULL, stats_page TEXT NOT NULL, json_version INT NOT NULL,
  has_timeline INT NOT NULL,
  -- 1 when Riot team 100 is the Leaguepedia red side (side 2), 0 when it is blue
  side_swapped INT NOT NULL);
-- Per player, computed at ingestion from the Riot JSON (scripts/data/ingame.ts has the definitions).
CREATE TABLE game_player_stats (
  game_id INT NOT NULL, player_id INT NOT NULL,
  gold_10 INT, gold_15 INT, gold_20 INT, xp_10 INT, xp_15 INT, xp_20 INT, cs_10 INT, cs_15 INT, cs_20 INT,
  gold_diff_10 INT, gold_diff_15 INT, gold_diff_20 INT, xp_diff_10 INT, xp_diff_15 INT, xp_diff_20 INT,
  cs_diff_10 INT, cs_diff_15 INT, cs_diff_20 INT,
  kills_10 INT, deaths_10 INT, assists_10 INT, solo_kills INT,
  first_blood_kill INT, first_blood_assist INT, first_blood_victim INT,
  double_kills INT, triple_kills INT, quadra_kills INT, penta_kills INT,
  wards_placed INT, wards_killed INT, control_wards INT, plates INT, damage_taken INT,
  PRIMARY KEY (game_id, player_id)) WITHOUT ROWID;
CREATE TABLE game_team_stats (
  game_id INT NOT NULL, side INT NOT NULL,
  first_blood INT, first_tower INT, first_dragon INT, first_herald INT, first_baron INT, first_inhibitor INT,
  plates INT, gold_10 INT, gold_15 INT, gold_20 INT, gold_diff_10 INT, gold_diff_15 INT, gold_diff_20 INT,
  kills_10 INT, kills_15 INT, kills_20 INT, towers_15 INT,
  PRIMARY KEY (game_id, side)) WITHOUT ROWID;
CREATE TABLE game_draft (
  game_id INT NOT NULL, side INT NOT NULL, kind INT NOT NULL, slot INT NOT NULL, champion_id INT NOT NULL,
  PRIMARY KEY (game_id, side, kind, slot)) WITHOUT ROWID;
CREATE TABLE game_players (
  game_id INT NOT NULL, player_id INT NOT NULL, team_id INT, side INT, role TEXT, champion_id INT, win INT,
  kills INT, deaths INT, assists INT, gold INT, cs INT, damage INT, vision INT, keystone_id INT,
  PRIMARY KEY (game_id, player_id)) WITHOUT ROWID;
-- End-of-game inventory from Leaguepedia (ScoreboardPlayers.Items, slots 1-6, trinket excluded).
CREATE TABLE game_player_items (
  game_id INT NOT NULL, player_id INT NOT NULL, slot INT NOT NULL, item_id INT NOT NULL,
  PRIMARY KEY (game_id, player_id, slot)) WITHOUT ROWID;
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  schema_version INT NOT NULL, row_counts TEXT NOT NULL, details TEXT);
`;

export const QUERY_DDL = `
CREATE INDEX gp_player ON game_players(player_id);
CREATE INDEX gp_champion ON game_players(champion_id);
CREATE INDEX draft_champion_kind_game ON game_draft(champion_id, kind, game_id);
CREATE INDEX gps_player ON game_player_stats(player_id);
CREATE INDEX games_tournament ON games(tournament_id);
CREATE INDEX tournaments_league_year ON tournaments(league_id, year);
CREATE INDEX tournaments_event ON tournaments(event_page);

CREATE VIEW v_tournaments AS
  SELECT t.id AS tournament_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, l.region AS league_region, l.is_international,
         t.year, t.date_start, t.date_end, t.split
  FROM tournaments t JOIN leagues l ON l.id = t.league_id;
CREATE VIEW v_tournament_results AS
  SELECT t.page AS event_page, t.name AS tournament, l.name AS league, l.short_name AS league_short, t.year,
         tm.name AS team, r.place, r.place_number, r.prize_usd
  FROM tournament_results r JOIN tournaments t ON t.id = r.tournament_id JOIN leagues l ON l.id = t.league_id
  JOIN teams tm ON tm.id = r.team_id;
CREATE VIEW v_games AS
  SELECT g.id AS game_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, g.tab, g.match_n, g.game_n,
         g.played_at, g.patch, g.length_s,
         b.name AS blue_team, r.name AS red_team,
         CASE g.winner_side WHEN 1 THEN b.name WHEN 2 THEN r.name END AS winner,
         g.blue_dragons, g.red_dragons, g.blue_barons, g.red_barons, g.blue_towers, g.red_towers,
         g.blue_heralds, g.red_heralds, g.blue_void_grubs, g.red_void_grubs, g.blue_inhibitors, g.red_inhibitors,
         (gr.game_id IS NOT NULL) AS has_ingame
  FROM games g JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id
  LEFT JOIN game_riot gr ON gr.game_id = g.id;
CREATE VIEW v_game_players AS
  SELECT g.id AS game_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, g.played_at, g.patch,
         p.page AS player, gp.role, tm.name AS team, gp.side, c.name AS champion, gp.win,
         gp.kills, gp.deaths, gp.assists, gp.gold, gp.cs, gp.damage, gp.vision, k.name AS keystone
  FROM game_players gp JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
  JOIN leagues l ON l.id = t.league_id JOIN players p ON p.id = gp.player_id
  LEFT JOIN teams tm ON tm.id = gp.team_id LEFT JOIN champions c ON c.id = gp.champion_id
  LEFT JOIN runes k ON k.id = gp.keystone_id;
CREATE VIEW v_game_player_stats AS
  SELECT g.id AS game_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, g.played_at, g.patch, g.length_s,
         p.page AS player, gp.role, tm.name AS team, gp.side, c.name AS champion, gp.win,
         gp.kills, gp.deaths, gp.assists,
         s.gold_10, s.gold_15, s.gold_20, s.xp_10, s.xp_15, s.xp_20, s.cs_10, s.cs_15, s.cs_20,
         s.gold_diff_10, s.gold_diff_15, s.gold_diff_20, s.xp_diff_10, s.xp_diff_15, s.xp_diff_20,
         s.cs_diff_10, s.cs_diff_15, s.cs_diff_20,
         s.kills_10, s.deaths_10, s.assists_10, s.solo_kills,
         s.first_blood_kill, s.first_blood_assist, s.first_blood_victim,
         s.double_kills, s.triple_kills, s.quadra_kills, s.penta_kills,
         s.wards_placed, s.wards_killed, s.control_wards, s.plates, s.damage_taken,
         gr.stats_page
  FROM game_player_stats s JOIN game_players gp ON gp.game_id = s.game_id AND gp.player_id = s.player_id
  JOIN games g ON g.id = s.game_id JOIN game_riot gr ON gr.game_id = s.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  JOIN players p ON p.id = s.player_id
  LEFT JOIN teams tm ON tm.id = gp.team_id LEFT JOIN champions c ON c.id = gp.champion_id;
CREATE VIEW v_game_team_stats AS
  SELECT g.id AS game_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, g.played_at, g.patch, g.length_s,
         CASE s.side WHEN 1 THEN b.name ELSE r.name END AS team,
         CASE s.side WHEN 1 THEN r.name ELSE b.name END AS opponent,
         s.side, (g.winner_side = s.side) AS win,
         s.first_blood, s.first_tower, s.first_dragon, s.first_herald, s.first_baron, s.first_inhibitor,
         s.plates, s.gold_10, s.gold_15, s.gold_20, s.gold_diff_10, s.gold_diff_15, s.gold_diff_20,
         s.kills_10, s.kills_15, s.kills_20, s.towers_15,
         gr.stats_page
  FROM game_team_stats s JOIN games g ON g.id = s.game_id JOIN game_riot gr ON gr.game_id = s.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
CREATE VIEW v_ingame_coverage AS
  SELECT l.name AS league, l.short_name AS league_short, t.year,
         COUNT(*) AS games, COUNT(gr.game_id) AS ingame_games
  FROM games g JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN game_riot gr ON gr.game_id = g.id
  GROUP BY l.id, t.year;
CREATE VIEW v_draft AS
  SELECT d.game_id, d.side, CASE d.kind WHEN 0 THEN 'pick' ELSE 'ban' END AS kind, d.slot,
         c.name AS champion
  FROM game_draft d JOIN champions c ON c.id = d.champion_id;
CREATE VIEW v_player_items AS
  SELECT gi.game_id, p.page AS player, gi.slot, i.name AS item, i.icon_url, i.kind
  FROM game_player_items gi JOIN players p ON p.id = gi.player_id JOIN items i ON i.id = gi.item_id;
`;

export function createSchema(db: DatabaseSync): void {
  db.exec(TABLE_DDL);
}

/** Install after ingestion so indexes are built once from the complete dataset. */
export function createQuerySchema(db: DatabaseSync): void {
  db.exec(QUERY_DDL);
}

export const SCHEMA_TABLES = [...TABLE_DDL.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
export const SCHEMA_VIEWS = [...QUERY_DDL.matchAll(/CREATE VIEW (\w+)/g)].map((m) => m[1]);
export const SCHEMA_OBJECTS = [...SCHEMA_TABLES, ...SCHEMA_VIEWS];
