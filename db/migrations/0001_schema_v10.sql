-- Schema v10 of the read-only database (src/lib/db/schema.ts), in Postgres.
-- Applied inside the schema the loader builds (search_path), never with a schema name: scripts/db/load.ts applies
-- every migration to a fresh schema, loads it, then swaps it in. Text sorts and compares byte by byte (COLLATE "C"),
-- as in SQLite, so answers keep their order whatever the server's locale. Flags stay 0/1 integers, as in SQLite.

CREATE TABLE leagues (
  id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, short_name text COLLATE "C" NOT NULL,
  region text COLLATE "C" NOT NULL, is_international integer NOT NULL);
CREATE TABLE tournaments (
  id integer PRIMARY KEY,
  page text COLLATE "C" NOT NULL UNIQUE,
  event_page text COLLATE "C" NOT NULL,
  stage text COLLATE "C" NOT NULL,
  name text COLLATE "C", league_id integer NOT NULL REFERENCES leagues(id),
  year integer, date_start text COLLATE "C", date_end text COLLATE "C", split text COLLATE "C");
CREATE TABLE teams (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, short text COLLATE "C");
CREATE TABLE players (
  id integer PRIMARY KEY, page text COLLATE "C" NOT NULL UNIQUE, ign text COLLATE "C", real_name text COLLATE "C", native_name text COLLATE "C");
CREATE TABLE player_images (
  player_id integer NOT NULL, taken_at integer NOT NULL, file text COLLATE "C" NOT NULL,
  PRIMARY KEY (player_id, taken_at, file));
CREATE TABLE player_aliases (
  alias text COLLATE "C" NOT NULL, raw text COLLATE "C" NOT NULL, player_id integer NOT NULL,
  PRIMARY KEY (alias, player_id));
CREATE TABLE champions (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, icon_url text COLLATE "C");
CREATE TABLE items (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, icon_url text COLLATE "C" NOT NULL, kind text COLLATE "C");
CREATE TABLE runes (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, tree text COLLATE "C", icon_url text COLLATE "C");
CREATE TABLE summoner_spells (id integer PRIMARY KEY, name text COLLATE "C" NOT NULL UNIQUE, icon_url text COLLATE "C");
CREATE TABLE tournament_results (
  tournament_id integer NOT NULL, team_id integer NOT NULL, place text COLLATE "C", place_number integer, prize_usd double precision,
  PRIMARY KEY (tournament_id, team_id));
CREATE TABLE games (
  id integer PRIMARY KEY, tournament_id integer NOT NULL,
  tab text COLLATE "C", match_n integer, game_n integer,
  blue_team_id integer, red_team_id integer, winner_side integer, length_s integer, patch text COLLATE "C", played_at integer,
  blue_dragons integer, red_dragons integer, blue_barons integer, red_barons integer, blue_towers integer, red_towers integer,
  blue_heralds integer, red_heralds integer, blue_void_grubs integer, red_void_grubs integer, blue_inhibitors integer, red_inhibitors integer);
CREATE TABLE game_riot (
  game_id integer PRIMARY KEY, riot_key text COLLATE "C" NOT NULL, stats_page text COLLATE "C" NOT NULL, json_version integer NOT NULL,
  has_timeline integer NOT NULL,
  side_swapped integer NOT NULL);
CREATE TABLE game_player_stats (
  game_id integer NOT NULL, player_id integer NOT NULL,
  gold_10 integer, gold_15 integer, gold_20 integer, xp_10 integer, xp_15 integer, xp_20 integer, cs_10 integer, cs_15 integer, cs_20 integer,
  gold_diff_10 integer, gold_diff_15 integer, gold_diff_20 integer, xp_diff_10 integer, xp_diff_15 integer, xp_diff_20 integer,
  cs_diff_10 integer, cs_diff_15 integer, cs_diff_20 integer,
  kills_10 integer, deaths_10 integer, assists_10 integer, solo_kills integer,
  first_blood_kill integer, first_blood_assist integer, first_blood_victim integer,
  double_kills integer, triple_kills integer, quadra_kills integer, penta_kills integer,
  wards_placed integer, wards_killed integer, control_wards integer, plates integer, damage_taken integer,
  PRIMARY KEY (game_id, player_id));
CREATE TABLE game_team_stats (
  game_id integer NOT NULL, side integer NOT NULL,
  first_blood integer, first_tower integer, first_dragon integer, first_herald integer, first_baron integer, first_inhibitor integer,
  plates integer, gold_10 integer, gold_15 integer, gold_20 integer, gold_diff_10 integer, gold_diff_15 integer, gold_diff_20 integer,
  kills_10 integer, kills_15 integer, kills_20 integer, towers_15 integer,
  elder_dragons integer, dragon_soul integer, soul text COLLATE "C",
  PRIMARY KEY (game_id, side));
CREATE TABLE game_dragons (
  game_id integer NOT NULL, seq integer NOT NULL, team_seq integer, side integer, kind text COLLATE "C", time_s integer NOT NULL,
  PRIMARY KEY (game_id, seq));
CREATE TABLE game_draft (
  game_id integer NOT NULL, side integer NOT NULL, kind integer NOT NULL, slot integer NOT NULL, champion_id integer NOT NULL,
  PRIMARY KEY (game_id, side, kind, slot));
CREATE TABLE game_players (
  game_id integer NOT NULL, player_id integer NOT NULL, team_id integer, side integer, role text COLLATE "C", champion_id integer, win integer,
  kills integer, deaths integer, assists integer, gold integer, cs integer, damage integer, vision integer, keystone_id integer,
  spell1_id integer, spell2_id integer,
  PRIMARY KEY (game_id, player_id));
CREATE TABLE game_player_runes (
  game_id integer NOT NULL, player_id integer NOT NULL,
  primary1_id integer, primary2_id integer, primary3_id integer, secondary1_id integer, secondary2_id integer,
  shard1_id integer, shard2_id integer, shard3_id integer,
  PRIMARY KEY (game_id, player_id));
CREATE TABLE game_player_items (
  game_id integer NOT NULL, player_id integer NOT NULL, slot integer NOT NULL, item_id integer NOT NULL,
  PRIMARY KEY (game_id, player_id, slot));
CREATE TABLE ingest_runs (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, kind text COLLATE "C" NOT NULL, started_at text COLLATE "C" NOT NULL,
  finished_at text COLLATE "C" NOT NULL, schema_version integer NOT NULL, row_counts text COLLATE "C" NOT NULL, details text COLLATE "C");

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
         (gr.game_id IS NOT NULL)::integer AS has_ingame
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
         s.side, (g.winner_side = s.side)::integer AS win,
         s.first_blood, s.first_tower, s.first_dragon, s.first_herald, s.first_baron, s.first_inhibitor,
         s.plates, s.gold_10, s.gold_15, s.gold_20, s.gold_diff_10, s.gold_diff_15, s.gold_diff_20,
         s.kills_10, s.kills_15, s.kills_20, s.towers_15,
         s.elder_dragons, s.dragon_soul, s.soul,
         gr.stats_page
  FROM game_team_stats s JOIN games g ON g.id = s.game_id JOIN game_riot gr ON gr.game_id = s.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
CREATE VIEW v_game_dragons AS
  SELECT d.game_id, t.event_page, l.name AS league, l.short_name AS league_short, t.year, t.stage, g.played_at, g.patch,
         CASE d.side WHEN 1 THEN b.name WHEN 2 THEN r.name END AS team,
         CASE d.side WHEN 1 THEN r.name WHEN 2 THEN b.name END AS opponent,
         d.side, (g.winner_side = d.side)::integer AS win, d.seq, d.team_seq, d.kind AS dragon, d.time_s
  FROM game_dragons d JOIN games g ON g.id = d.game_id
  JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
CREATE VIEW v_ingame_coverage AS
  SELECT l.name AS league, l.short_name AS league_short, t.year,
         COUNT(*)::integer AS games, COUNT(gr.game_id)::integer AS ingame_games
  FROM games g JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN game_riot gr ON gr.game_id = g.id
  GROUP BY l.id, t.year;
CREATE VIEW v_draft AS
  SELECT d.game_id, d.side, CASE d.kind WHEN 0 THEN 'pick' ELSE 'ban' END::text COLLATE "C" AS kind, d.slot,
         c.name AS champion
  FROM game_draft d JOIN champions c ON c.id = d.champion_id;
CREATE VIEW v_player_items AS
  SELECT gi.game_id, p.page AS player, gi.slot, i.name AS item, i.icon_url, i.kind
  FROM game_player_items gi JOIN players p ON p.id = gi.player_id JOIN items i ON i.id = gi.item_id;
CREATE VIEW v_player_runes AS
  SELECT gp.game_id, p.page AS player, s.slot,
         CASE WHEN s.slot = 1 THEN 'keystone' WHEN s.slot <= 4 THEN 'primary' WHEN s.slot <= 6 THEN 'secondary' ELSE 'shard' END::text COLLATE "C" AS kind,
         r.name AS rune, r.tree, r.icon_url
  FROM game_players gp
  CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9)) AS s(slot)
  LEFT JOIN game_player_runes pr ON pr.game_id = gp.game_id AND pr.player_id = gp.player_id
  JOIN runes r ON r.id = CASE s.slot WHEN 1 THEN gp.keystone_id WHEN 2 THEN pr.primary1_id WHEN 3 THEN pr.primary2_id
                                     WHEN 4 THEN pr.primary3_id WHEN 5 THEN pr.secondary1_id WHEN 6 THEN pr.secondary2_id
                                     WHEN 7 THEN pr.shard1_id WHEN 8 THEN pr.shard2_id ELSE pr.shard3_id END
  JOIN players p ON p.id = gp.player_id;
