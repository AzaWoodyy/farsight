/**
 * data:build: rebuild the normalized SQLite file from the raw cache.
 *
 *   bun run data:build
 *
 * The file is recreated from scratch on every run (no migrations), finished
 * with `journal_mode=DELETE` + `VACUUM` so it opens on a read-only filesystem.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeAlias } from "../../src/lib/aliases";
import { selectAll, selectOne } from "../../src/lib/db";
import { DDRAGON_BASE } from "../../src/lib/sources/ddragon";
import { type CargoValue, StoredCargoRow } from "../../src/lib/sources/leaguepedia";
import {
  type Classification,
  DB_FILE,
  type Dataset,
  IngestRun,
  LEAGUES,
  SCHEMA_VERSION,
  classifyTournament,
  datasetFile,
} from "./scope";

/** Served from /public, for items that no Data Dragon patch knows. */
const ITEM_FALLBACK_ICON = "/icons/item-fallback.svg";

/** Reads a dataset written by data:fetch and validates it with `schema`. */
function load<S extends z.ZodType>(name: Dataset, schema: S): z.infer<S> {
  const file = datasetFile(name);

  if (!existsSync(file)) throw new Error(`${file} is missing: run \`bun run data:fetch\` first.`);

  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const Rows = z.array(StoredCargoRow);

type Row = z.infer<typeof StoredCargoRow>;

/** A Cargo field, or a field the row does not have. */
type Field = CargoValue | undefined;

const t0 = Date.now();
const startedAt = new Date().toISOString();

mkdirSync(dirname(DB_FILE), { recursive: true });

for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });

const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");

db.exec(`
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
CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon_url TEXT NOT NULL);
CREATE TABLE runes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);  -- keystones
CREATE TABLE tournament_results (
  tournament_id INT NOT NULL, team_id INT NOT NULL, place TEXT, place_number INT, prize_usd REAL,
  PRIMARY KEY (tournament_id, team_id)) WITHOUT ROWID;
CREATE TABLE games (
  id INTEGER PRIMARY KEY, tournament_id INT NOT NULL,
  blue_team_id INT, red_team_id INT, winner_side INT, length_s INT, patch TEXT, played_at INT);
CREATE TABLE game_draft (
  game_id INT NOT NULL, side INT NOT NULL, kind INT NOT NULL, slot INT NOT NULL, champion_id INT NOT NULL,
  PRIMARY KEY (game_id, side, kind, slot)) WITHOUT ROWID;
CREATE TABLE game_players (
  game_id INT NOT NULL, player_id INT NOT NULL, team_id INT, side INT, role TEXT, champion_id INT, win INT,
  kills INT, deaths INT, assists INT, gold INT, cs INT, damage INT, vision INT, keystone_id INT,
  PRIMARY KEY (game_id, player_id)) WITHOUT ROWID;
CREATE TABLE game_player_items (
  game_id INT NOT NULL, player_id INT NOT NULL, slot INT NOT NULL, item_id INT NOT NULL,
  PRIMARY KEY (game_id, player_id, slot)) WITHOUT ROWID;
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  schema_version INT NOT NULL, row_counts TEXT NOT NULL, details TEXT);
`);

const list = (v: Field): string[] =>
  (Array.isArray(v) ? v : v ? String(v).split(",") : []).map((s) => String(s).trim()).filter(Boolean);

const int = (v: Field) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const yes = (v: Field) => (v === "Yes" || v === 1 || v === "1" || v === true ? 1 : 0);
const text = (v: Field) => (v == null || v === "" ? null : String(v));

const seconds = (v: Field) => {
  if (!v) return null;
  const p = String(v).split(":").map(Number);

  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
};

/** Name -> integer id lookup table, inserted on first sight. */
function dictionary(table: string) {
  const ids = new Map<string, number>();
  const insert = db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`);

  return (name: Field): number | null => {
    if (name == null || name === "") return null;
    const key = String(name).trim();
    let id = ids.get(key);

    if (id == null) {
      id = ids.size + 1;
      ids.set(key, id);
      insert.run(id, key);
    }

    return id;
  };
}

db.exec("BEGIN");

// Leagues -----------------------------------------------------------------------
const leagueId = new Map<string, number>();
const insLeague = db.prepare("INSERT INTO leagues VALUES (?, ?, ?, ?, ?)");

LEAGUES.forEach((l, i) => {
  leagueId.set(l.name, i + 1);
  insLeague.run(i + 1, l.name, l.short, l.region, l.international ? 1 : 0);
});

const leagueByName = new Map(LEAGUES.map((l) => [l.name, l]));

const team = dictionary("teams");
const champion = dictionary("champions");
const rune = dictionary("runes");

// Items carry a NOT NULL icon, so they are collected first and inserted at the end.
const itemIds = new Map<string, number>();

const item = (name: Field) => {
  if (name == null || name === "") return null;
  const key = String(name).trim();
  let id = itemIds.get(key);

  if (id == null) itemIds.set(key, (id = itemIds.size + 1));

  return id;
};

// Tournaments -------------------------------------------------------------------
const yearOf = (t: Row) => {
  const y = int(t.Year);

  if (y) return y;
  const page = String(t.Page);
  const m = /(\d{4})/.exec(page) ?? /Season (\d)\b/.exec(page);

  if (m) return m[1].length === 4 ? Number(m[1]) : 2010 + Number(m[1]);

  return int(String(t.DateStart ?? t.DateEnd ?? "").slice(0, 4));
};

const tournaments = new Map<string, Row & Classification>();

for (const t of load("tournaments", Rows)) {
  const page = String(t.Page);
  const league = leagueByName.get(String(t.League));

  if (!league || tournaments.has(page)) continue;
  const kind = classifyTournament(page, league);

  if (kind) tournaments.set(page, { ...t, ...kind });
}

// An international page whose stages exist separately only holds standings.
for (const t of tournaments.values())
  if (t.eventPage !== t.Page && tournaments.has(t.eventPage)) tournaments.get(t.eventPage)!.stage = "event";

const tournamentId = new Map<string, number>();
const insTournament = db.prepare("INSERT INTO tournaments VALUES (?,?,?,?,?,?,?,?,?,?)");

for (const [page, t] of tournaments) {
  const id = tournamentId.size + 1;
  tournamentId.set(page, id);
  insTournament.run(
    id, page, t.eventPage, t.stage, text(t.Name), leagueId.get(String(t.League))!, yearOf(t),
    text(t.DateStart), text(t.DateEnd), text(t.Split),
  );
}

const insResult = db.prepare("INSERT OR IGNORE INTO tournament_results VALUES (?,?,?,?,?)");

for (const r of load("results", Rows)) {
  const tid = tournamentId.get(String(r.Page));

  if (!tid || !r.Team) continue;
  const prize = r.PrizeUSD == null || r.PrizeUSD === "" ? null : Number(String(r.PrizeUSD).replace(/,/g, ""));
  insResult.run(tid, team(r.Team), text(r.Place), int(r.PlaceNumber), Number.isNaN(prize) ? null : prize);
}

// Games -------------------------------------------------------------------------
const gameId = new Map<string, number>();
const insGame = db.prepare("INSERT INTO games VALUES (?,?,?,?,?,?,?,?)");
const insDraft = db.prepare("INSERT OR IGNORE INTO game_draft VALUES (?,?,?,?,?)");
let skippedGames = 0;

for (const g of load("games", Rows)) {
  const page = String(g.Page);
  const tid = tournamentId.get(page);
  const key = String(g.GameId);

  if (!tid || gameId.has(key)) {
    skippedGames++;
    continue;
  }

  const id = gameId.size + 1;
  gameId.set(key, id);
  const date = text(g.Date);
  insGame.run(
    id, tid, team(g.Team1), team(g.Team2), int(g.Winner), seconds(g.Len), text(g.Patch),
    date ? Math.floor(Date.parse(`${date.replace(" ", "T")}Z`) / 1000) : null,
  );

  for (const [side, kind, value] of [[1, 0, g.P1], [2, 0, g.P2], [1, 1, g.B1], [2, 1, g.B2]] as const)
    list(value).forEach((c, slot) => {
      if (c !== "None" && c !== "Loss of Ban") insDraft.run(id, side, kind, slot + 1, champion(c));
    });
}

// Player lines ------------------------------------------------------------------
const playerId = new Map<string, number>();
const insPlayer = db.prepare("INSERT INTO players (id, page) VALUES (?, ?)");

const player = (page: string) => {
  let id = playerId.get(page);

  if (id == null) {
    id = playerId.size + 1;
    playerId.set(page, id);
    insPlayer.run(id, page);
  }

  return id;
};

const insLine = db.prepare(`INSERT OR IGNORE INTO game_players VALUES (${Array(15).fill("?").join(",")})`);
const insItem = db.prepare("INSERT OR IGNORE INTO game_player_items VALUES (?,?,?,?)");
let skippedLines = 0;
const ignByPlayer = new Map<number, Set<string>>();

for (const l of load("lines", Rows)) {
  const gid = gameId.get(String(l.GameId));
  const page = text(l.Link) ?? text(l.Name);

  if (!gid || !page) {
    skippedLines++;
    continue;
  }

  const pid = player(page);

  if (l.Name) ignByPlayer.set(pid, (ignByPlayer.get(pid) ?? new Set()).add(String(l.Name)));
  insLine.run(
    gid, pid, team(l.Team), int(l.Side), text(l.Role), champion(l.Champion), yes(l.Win),
    int(l.K), int(l.D), int(l.A), int(l.Gold), int(l.CS), int(l.Dmg), int(l.Vision), rune(l.Keystone),
  );
  list(l.Items).forEach((it, slot) => insItem.run(gid, pid, slot + 1, item(it)));
}

// Players and aliases -----------------------------------------------------------
const insAlias = db.prepare("INSERT OR IGNORE INTO player_aliases VALUES (?,?,?)");

const alias = (raw: Field, pid: number) => {
  if (!raw) return;
  const n = normalizeAlias(String(raw));

  if (n.length >= 2) insAlias.run(n, String(raw), pid);
};

const updPlayer = db.prepare("UPDATE players SET ign=?, real_name=?, native_name=? WHERE id=?");

for (const p of load("players", Rows)) {
  const pid = playerId.get(String(p.Page));

  if (!pid) continue;
  updPlayer.run(text(p.ID), text(p.Name), text(p.NativeName), pid);

  for (const a of [p.ID, p.Name, p.NativeName]) alias(a, pid);
  // Korean/Chinese romanizations: also index the given name ("Jeong Ji-hoon" -> "Ji-hoon").
  const real = text(p.Name);

  if (real?.includes(" ")) alias(real.split(" ").slice(1).join(" "), pid);
}

for (const r of load("redirects", Rows)) {
  const pid = playerId.get(String(r.Page));

  if (pid) alias(r.AllName, pid);
}

for (const [page, pid] of playerId) alias(page, pid);

for (const [pid, names] of ignByPlayer) for (const n of names) alias(n, pid);

// Data Dragon -------------------------------------------------------------------
const DdragonData = z.object({
  version: z.string(),
  champion: z.object({
    data: z.record(z.string(), z.object({ id: z.string(), name: z.string(), image: z.object({ full: z.string() }) })),
  }),
  item: z.object({ data: z.record(z.string(), z.object({ name: z.string() })) }),
  legacyItems: z.array(z.object({ version: z.string(), items: z.record(z.string(), z.string()) })),
});

const dd = load("ddragon", DdragonData);
const cdn = `${DDRAGON_BASE}/cdn`;

const championByName = new Map(Object.values(dd.champion.data).map((c) => [normalizeAlias(c.name), c]));

for (const [display, id] of [["Nunu", "Nunu"], ["Wukong", "MonkeyKing"]] as const) {
  const c = Object.values(dd.champion.data).find((x) => x.id === id);

  if (c) championByName.set(normalizeAlias(display), c);
}

const updChampion = db.prepare("UPDATE champions SET icon_url=? WHERE id=?");

for (const c of selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM champions")) {
  const d = championByName.get(normalizeAlias(c.name));
  updChampion.run(d ? `${cdn}/${dd.version}/img/champion/${d.image.full}` : null, c.id);
}

// Latest patch first, then older patches (newest first) for retired items.
const itemSources = [
  { version: dd.version, legacy: false, items: Object.fromEntries(Object.entries(dd.item.data).map(([k, v]) => [k, v.name])) },
  ...dd.legacyItems.map((l) => ({ ...l, legacy: true })),
];

const itemIcon = new Map<string, { id: string; version: string; legacy: boolean }>();

for (const src of itemSources)
  for (const [id, name] of Object.entries(src.items)) {
    const key = normalizeAlias(name);

    if (!itemIcon.has(key)) itemIcon.set(key, { id, version: src.version, legacy: src.legacy });
  }

const insItemRow = db.prepare("INSERT INTO items VALUES (?, ?, ?)");
const itemIcons = { ddragon: 0, ddragon_legacy: 0, fallback: 0 };

for (const [name, id] of itemIds) {
  const icon = itemIcon.get(normalizeAlias(name));
  insItemRow.run(id, name, icon ? `${cdn}/${icon.version}/img/item/${icon.id}.png` : ITEM_FALLBACK_ICON);
  itemIcons[icon ? (icon.legacy ? "ddragon_legacy" : "ddragon") : "fallback"]++;
}

// Indexes and views -------------------------------------------------------------
db.exec(`
CREATE INDEX gp_player ON game_players(player_id);
CREATE INDEX gp_champion ON game_players(champion_id);
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
         l.name AS league, l.short_name AS league_short, t.year, g.played_at, g.patch, g.length_s,
         b.name AS blue_team, r.name AS red_team,
         CASE g.winner_side WHEN 1 THEN b.name WHEN 2 THEN r.name END AS winner
  FROM games g JOIN tournaments t ON t.id = g.tournament_id JOIN leagues l ON l.id = t.league_id
  LEFT JOIN teams b ON b.id = g.blue_team_id LEFT JOIN teams r ON r.id = g.red_team_id;
CREATE VIEW v_game_players AS
  SELECT g.id AS game_id, t.page AS tournament_page, t.event_page, t.stage, t.name AS tournament,
         l.name AS league, l.short_name AS league_short, t.year, g.played_at, g.patch,
         p.page AS player, gp.role, tm.name AS team, gp.side, c.name AS champion, gp.win,
         gp.kills, gp.deaths, gp.assists, gp.gold, gp.cs, gp.damage, gp.vision, k.name AS keystone
  FROM game_players gp JOIN games g ON g.id = gp.game_id JOIN tournaments t ON t.id = g.tournament_id
  JOIN leagues l ON l.id = t.league_id JOIN players p ON p.id = gp.player_id
  LEFT JOIN teams tm ON tm.id = gp.team_id LEFT JOIN champions c ON c.id = gp.champion_id
  LEFT JOIN runes k ON k.id = gp.keystone_id;
CREATE VIEW v_draft AS
  SELECT d.game_id, d.side, CASE d.kind WHEN 0 THEN 'pick' ELSE 'ban' END AS kind, d.slot,
         c.name AS champion
  FROM game_draft d JOIN champions c ON c.id = d.champion_id;
CREATE VIEW v_player_items AS
  SELECT gi.game_id, p.page AS player, gi.slot, i.name AS item, i.icon_url
  FROM game_player_items gi JOIN players p ON p.id = gi.player_id JOIN items i ON i.id = gi.item_id;
`);

// Ingest metadata ---------------------------------------------------------------
const TABLES = [
  "leagues", "tournaments", "tournament_results", "teams", "players", "player_aliases", "champions",
  "items", "runes", "games", "game_draft", "game_players", "game_player_items",
] as const;

const count = (sql: string) => selectOne(db, z.object({ n: z.number() }), sql)?.n ?? 0;
const rowCounts = Object.fromEntries(TABLES.map((t) => [t, count(`SELECT COUNT(*) AS n FROM ${t}`)]));
const insRun = db.prepare("INSERT INTO ingest_runs (kind, started_at, finished_at, schema_version, row_counts, details) VALUES (?,?,?,?,?,?)");

for (const r of load("runs", z.array(IngestRun)))
  insRun.run(
    String(r.kind), String(r.started_at), String(r.finished_at), SCHEMA_VERSION,
    JSON.stringify(r.row_counts),
    JSON.stringify({ requests: r.requests, cached_responses: r.cached_responses }),
  );

insRun.run(
  "build", startedAt, new Date().toISOString(), SCHEMA_VERSION, JSON.stringify(rowCounts),
  JSON.stringify({ ddragon_version: dd.version, skipped_games: skippedGames, skipped_lines: skippedLines, item_icons: itemIcons }),
);

db.exec("COMMIT");

db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; PRAGMA journal_mode=DELETE; ANALYZE; VACUUM;`);

const byLeague = db
  .prepare(
    `SELECT l.short_name AS league, COUNT(DISTINCT t.id) AS tournaments, COUNT(g.id) AS games
     FROM leagues l LEFT JOIN tournaments t ON t.league_id = l.id LEFT JOIN games g ON g.tournament_id = t.id
     GROUP BY l.id ORDER BY l.id`,
  )
  .all();

const journal = selectOne(db, z.object({ journal_mode: z.string() }), "PRAGMA journal_mode")?.journal_mode;

db.close();

console.log(`built ${DB_FILE} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

console.log(`size: ${(statSync(DB_FILE).size / 1e6).toFixed(1)} MB, journal_mode=${journal}, schema v${SCHEMA_VERSION}`);

console.log(`skipped: ${skippedGames} games, ${skippedLines} player lines (outside scope or duplicates)`);

console.log("rows:", rowCounts);

console.log("item icons:", itemIcons);

console.table(byLeague);
