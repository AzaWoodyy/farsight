/**
 * Local SQLite cache schema.
 *
 * Tables mirror the Leaguepedia Cargo tables we ingest, trimmed to the fields
 * the agent needs. `tournaments.league` and `tournaments.event_page` already
 * allow MSI and regional leagues to land here later without a migration.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tournaments (
  overview_page TEXT PRIMARY KEY,   -- Leaguepedia page, e.g. "2024 Season World Championship/Main Event"
  event_page    TEXT NOT NULL,      -- parent event page that holds final standings
  name          TEXT NOT NULL,
  league        TEXT NOT NULL,      -- "World Championship", later "Mid-Season Invitational", "LCK", ...
  year          INTEGER NOT NULL,
  phase         TEXT,               -- "Main Event", "Play-In", or NULL for single-stage events
  date_start    TEXT
);

CREATE TABLE IF NOT EXISTS tournament_results (
  event_page   TEXT NOT NULL,
  team         TEXT NOT NULL,
  place        TEXT NOT NULL,       -- "1", "3-4", "9-11" ...
  place_number INTEGER,
  last_result  TEXT,
  prize_usd    REAL,
  PRIMARY KEY (event_page, team)
);

CREATE TABLE IF NOT EXISTS games_players (
  game_id       TEXT NOT NULL,
  overview_page TEXT NOT NULL,
  player        TEXT NOT NULL,      -- canonical Leaguepedia player page (Link)
  name          TEXT,               -- in-game name at the time
  team          TEXT NOT NULL,
  role          TEXT,
  champion      TEXT,
  win           INTEGER NOT NULL,   -- 1 win, 0 loss
  datetime_utc  TEXT,
  kills         INTEGER,
  deaths        INTEGER,
  assists       INTEGER,
  PRIMARY KEY (game_id, player)
);
CREATE INDEX IF NOT EXISTS idx_games_players_player ON games_players(player);
CREATE INDEX IF NOT EXISTS idx_games_players_page ON games_players(overview_page);

CREATE TABLE IF NOT EXISTS players (
  player      TEXT PRIMARY KEY,     -- canonical Leaguepedia page
  real_name   TEXT,
  native_name TEXT,
  country     TEXT,
  role        TEXT,
  team        TEXT
);

CREATE TABLE IF NOT EXISTS player_aliases (
  alias      TEXT NOT NULL,         -- normalized (lowercase, no spaces/punctuation)
  raw_alias  TEXT NOT NULL,
  player     TEXT NOT NULL,
  source     TEXT NOT NULL,         -- "redirect", "native_name", "real_name", "ign"
  PRIMARY KEY (alias, player)
);

CREATE TABLE IF NOT EXISTS champions (
  name      TEXT PRIMARY KEY,       -- display name as used by Leaguepedia
  ddragon_id TEXT NOT NULL,
  image_url TEXT NOT NULL,
  version   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  row_counts  TEXT
);
`;
