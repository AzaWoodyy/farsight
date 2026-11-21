import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 12;

export const PG_MIGRATION = 3;

export const PG_MIGRATION_READ = 2;

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
-- short: the team's abbreviation on Leaguepedia (Teams.Short, "KCB"), through TeamRedirects for an older name; read by understand.
-- logo: the team's square logo file on Leaguepedia (scripts/data/team-logos.ts), the file name only, the image stays on
-- Fandom's CDN (fair use, not CC BY-SA); read by team-badges.
CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, short TEXT, logo TEXT);
CREATE TABLE players (
  id INTEGER PRIMARY KEY, page TEXT NOT NULL UNIQUE, ign TEXT, real_name TEXT, native_name TEXT);
-- Leaguepedia headshots (PlayerImages): the file name only, the image stays on Fandom's CDN (fair use, not CC BY-SA).
-- taken_at: start of the tournament the photo was taken for, in unix seconds like games.played_at.
CREATE TABLE player_images (
  player_id INT NOT NULL, taken_at INT NOT NULL, file TEXT NOT NULL,
  PRIMARY KEY (player_id, taken_at, file)) WITHOUT ROWID;
CREATE TABLE player_aliases (
  alias TEXT NOT NULL, raw TEXT NOT NULL, player_id INT NOT NULL,
  PRIMARY KEY (alias, player_id)) WITHOUT ROWID;
CREATE TABLE champions (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT);
-- kind: complete | boots | component | starter | consumable (src/lib/domain/items.ts), NULL when Data Dragon does not know the item
CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT NOT NULL, kind TEXT);
-- Every rune of a page: keystones, minor runes and stat shards. tree: Precision | Domination | Sorcery | Resolve | Inspiration,
-- NULL for a stat shard; icon_url is NULL for a shard and for a rune the Data Dragon patch of the build no longer has.
CREATE TABLE runes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, tree TEXT, icon_url TEXT);
CREATE TABLE summoner_spells (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT);
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
  -- dragon_soul: 1 when the team got the soul, NULL when the game has no timeline or predates the soul (patch 9.23);
  -- soul: its element (src/lib/domain/dragons.ts)
  elder_dragons INT, dragon_soul INT, soul TEXT,
  PRIMARY KEY (game_id, side)) WITHOUT ROWID;
-- Every dragon kill of a game with a Riot timeline, in order (seq), and its order among the team's own dragons
-- (team_seq). side and team_seq are NULL when the timeline does not name the killer's team; kind is the element
-- (or 'elder'), NULL before the elements (patch 6.9).
CREATE TABLE game_dragons (
  game_id INT NOT NULL, seq INT NOT NULL, team_seq INT, side INT, kind TEXT, time_s INT NOT NULL,
  PRIMARY KEY (game_id, seq)) WITHOUT ROWID;
CREATE TABLE game_draft (
  game_id INT NOT NULL, side INT NOT NULL, kind INT NOT NULL, slot INT NOT NULL, champion_id INT NOT NULL,
  PRIMARY KEY (game_id, side, kind, slot)) WITHOUT ROWID;
CREATE TABLE game_players (
  game_id INT NOT NULL, player_id INT NOT NULL, team_id INT, side INT, role TEXT, champion_id INT, win INT,
  kills INT, deaths INT, assists INT, gold INT, cs INT, damage INT, vision INT, keystone_id INT,
  -- the two summoner spells in alphabetical order (the source order is the key binding), so a pair groups as one
  spell1_id INT, spell2_id INT,
  PRIMARY KEY (game_id, player_id)) WITHOUT ROWID;
-- Rune page from Leaguepedia (ScoreboardPlayers.Runes), for the lines that list one (from 2020; 2018 and 2019 only have
-- the keystone, which stays in game_players). The shards are NULL on a page without them.
CREATE TABLE game_player_runes (
  game_id INT NOT NULL, player_id INT NOT NULL,
  primary1_id INT, primary2_id INT, primary3_id INT, secondary1_id INT, secondary2_id INT,
  shard1_id INT, shard2_id INT, shard3_id INT,
  PRIMARY KEY (game_id, player_id)) WITHOUT ROWID;
-- End-of-game inventory from Leaguepedia (ScoreboardPlayers.Items, slots 1-6, trinket excluded).
CREATE TABLE game_player_items (
  game_id INT NOT NULL, player_id INT NOT NULL, slot INT NOT NULL, item_id INT NOT NULL,
  PRIMARY KEY (game_id, player_id, slot)) WITHOUT ROWID;
-- Series Leaguepedia lists on its match schedule (MatchSchedule) without any scoreboard game: the result alone, no game
-- statistic (scripts/data/schedule.ts). winner_side is 1 (team1) or 2 (team2); forfeit is the side that forfeited, NULL
-- when the series was played; the scores are NULL when the schedule has none.
CREATE TABLE series_results (
  id INTEGER PRIMARY KEY, tournament_id INT NOT NULL, tab TEXT, match_n INT,
  team1_id INT NOT NULL, team2_id INT NOT NULL, winner_side INT NOT NULL, team1_score INT, team2_score INT, forfeit INT,
  played_at INT);
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  schema_version INT NOT NULL, row_counts TEXT NOT NULL, details TEXT);
`;

export const QUERY_DDL = `
CREATE INDEX gp_player ON game_players(player_id);
CREATE INDEX gp_champion ON game_players(champion_id);
CREATE INDEX gp_team ON game_players(team_id);
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
         gp.kills, gp.deaths, gp.assists, gp.gold, gp.cs, gp.damage, gp.vision, k.name AS keystone,
         s1.name AS spell1, s2.name AS spell2
  FROM game_players gp JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
  JOIN leagues l ON l.id = t.league_id JOIN players p ON p.id = gp.player_id
  LEFT JOIN teams tm ON tm.id = gp.team_id LEFT JOIN champions c ON c.id = gp.champion_id
  LEFT JOIN runes k ON k.id = gp.keystone_id
  LEFT JOIN summoner_spells s1 ON s1.id = gp.spell1_id LEFT JOIN summoner_spells s2 ON s2.id = gp.spell2_id;
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
         s.elder_dragons, s.dragon_soul, s.soul,
         gr.stats_page
  FROM game_team_stats s JOIN games g ON g.id = s.game_id JOIN game_riot gr ON gr.game_id = s.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
-- One row per dragon kill: seq is its order in the game, team_seq its order among the team's own dragons.
CREATE VIEW v_game_dragons AS
  SELECT d.game_id, t.event_page, l.name AS league, l.short_name AS league_short, t.year, t.stage, g.played_at, g.patch,
         CASE d.side WHEN 1 THEN b.name WHEN 2 THEN r.name END AS team,
         CASE d.side WHEN 1 THEN r.name WHEN 2 THEN b.name END AS opponent,
         d.side, (g.winner_side = d.side) AS win, d.seq, d.team_seq, d.kind AS dragon, d.time_s
  FROM game_dragons d JOIN games g ON g.id = d.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
-- Series without a scoreboard game (series_results): count them with the series of v_games, never as games with statistics.
CREATE VIEW v_series_results AS
  SELECT s.id AS series_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, s.tab, s.match_n, s.played_at,
         a.name AS team1, b.name AS team2, CASE s.winner_side WHEN 1 THEN a.name ELSE b.name END AS winner,
         s.team1_score, s.team2_score,
         CASE s.forfeit WHEN 1 THEN a.name WHEN 2 THEN b.name END AS forfeited_by
  FROM series_results s JOIN tournaments t ON t.id = s.tournament_id JOIN leagues l ON l.id = t.league_id
  JOIN teams a ON a.id = s.team1_id JOIN teams b ON b.id = s.team2_id;
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
-- One row per rune of a page, in page order: slot 1 the keystone, 2-4 the primary tree, 5-6 the secondary tree, 7-9 the stat shards.
CREATE VIEW v_player_runes AS
  SELECT gp.game_id, p.page AS player, s.slot,
         CASE WHEN s.slot = 1 THEN 'keystone' WHEN s.slot <= 4 THEN 'primary' WHEN s.slot <= 6 THEN 'secondary' ELSE 'shard' END AS kind,
         r.name AS rune, r.tree, r.icon_url
  FROM game_players gp
  JOIN (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
        UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) s
  LEFT JOIN game_player_runes pr ON pr.game_id = gp.game_id AND pr.player_id = gp.player_id
  JOIN runes r ON r.id = CASE s.slot WHEN 1 THEN gp.keystone_id WHEN 2 THEN pr.primary1_id WHEN 3 THEN pr.primary2_id
                                     WHEN 4 THEN pr.primary3_id WHEN 5 THEN pr.secondary1_id WHEN 6 THEN pr.secondary2_id
                                     WHEN 7 THEN pr.shard1_id WHEN 8 THEN pr.shard2_id ELSE pr.shard3_id END
  JOIN players p ON p.id = gp.player_id;
`;

export function createSchema(db: DatabaseSync): void {
  db.exec(TABLE_DDL);
}

export function createQuerySchema(db: DatabaseSync): void {
  db.exec(QUERY_DDL);
}

export const SCHEMA_TABLES = [...TABLE_DDL.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
export const SCHEMA_VIEWS = [...QUERY_DDL.matchAll(/CREATE VIEW (\w+)/g)].map((m) => m[1]);
export const SCHEMA_OBJECTS = [...SCHEMA_TABLES, ...SCHEMA_VIEWS];
