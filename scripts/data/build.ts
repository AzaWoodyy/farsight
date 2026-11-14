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
import { DB_MAX_BYTES, DB_WARN_BYTES } from "./artifact";
import { loadIngame } from "./riot";
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

/** Tab, match and game numbers of a ScoreboardGames GameId ("<page>_Finals_1_3"), null when it has another shape. */
function gameSlot(page: string, gameId: string): { tab: string; match: number; game: number } | null {
  const m = gameId.startsWith(`${page}_`) ? /^(.+)_(\d+)_(\d+)$/.exec(gameId.slice(page.length + 1)) : null;

  return m ? { tab: m[1], match: Number(m[2]), game: Number(m[3]) } : null;
}

const gameId = new Map<string, number>();
const insGame = db.prepare(`INSERT INTO games VALUES (${Array(23).fill("?").join(",")})`);
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
  const slot = gameSlot(page, key);
  insGame.run(
    id, tid, slot?.tab ?? null, slot?.match ?? null, slot?.game ?? null, team(g.Team1), team(g.Team2), int(g.Winner), seconds(g.Len), text(g.Patch),
    date ? Math.floor(Date.parse(`${date.replace(" ", "T")}Z`) / 1000) : null,
    int(g.D1), int(g.D2), int(g.Ba1), int(g.Ba2), int(g.To1), int(g.To2),
    int(g.H1), int(g.H2), int(g.V1), int(g.V2), int(g.I1), int(g.I2),
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

/** The Leaguepedia lines of each game, to map Riot participants onto players. */
const linesByGame = new Map<number, { pid: number; side: number | null; role: string | null; championId: number | null; kills: number | null }[]>();
const ignByPlayer = new Map<number, Set<string>>();

for (const l of load("lines", Rows)) {
  const gid = gameId.get(String(l.GameId));
  const page = text(l.Link) ?? text(l.Name);

  if (!gid || !page) {
    skippedLines++;
    continue;
  }

  const pid = player(page);
  const championId = champion(l.Champion);
  const side = int(l.Side);
  const lines = linesByGame.get(gid) ?? [];
  lines.push({ pid, side, role: text(l.Role), championId, kills: int(l.K) });
  linesByGame.set(gid, lines);

  if (l.Name) ignByPlayer.set(pid, (ignByPlayer.get(pid) ?? new Set()).add(String(l.Name)));
  insLine.run(
    gid, pid, team(l.Team), side, text(l.Role), championId, yes(l.Win),
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
    data: z.record(z.string(), z.object({ id: z.string(), key: z.string(), name: z.string(), image: z.object({ full: z.string() }) })),
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

// In-game stats (Riot JSON summaries) --------------------------------------------
// Riot participants are matched to Leaguepedia lines by champion (unique in a
// game), then by side and position for the rare champion that does not match.
const ROLE_ORDER = ["Top", "Jungle", "Mid", "Bot", "Support"];

const championIdByKey = new Map<number, number>();

const championIdByName = new Map(
  selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM champions").map((c) => [normalizeAlias(c.name), c.id]),
);

for (const c of Object.values(dd.champion.data)) {
  const id = championIdByName.get(normalizeAlias(c.name)) ?? championIdByName.get(normalizeAlias(c.id));

  if (id != null) championIdByKey.set(Number(c.key), id);
}

const insRiot = db.prepare("INSERT INTO game_riot VALUES (?,?,?,?,?,?)");
const PLAYER_STATS = 36;
const insPlayerStats = db.prepare(`INSERT OR IGNORE INTO game_player_stats VALUES (${Array(PLAYER_STATS).fill("?").join(",")})`);
const insTeamStats = db.prepare(`INSERT OR IGNORE INTO game_team_stats VALUES (${Array(19).fill("?").join(",")})`);
const ingameCounts = { games: 0, skipped_unknown_game: 0, skipped_mapping: 0, participants_by_position: 0, kills_mismatch: 0, missing: 0, invalid: 0, duplicates: 0 };
const diff = (a: number | null, b: number | null | undefined) => (a == null || b == null ? null : a - b);
const ingame = loadIngame();
const doneGames = new Set<number>();

for (const line of ingame.values()) {
  if (line.status !== "ok") {
    ingameCounts[line.status]++;
    continue;
  }

  const gid = gameId.get(line.gameId);
  const lines = gid == null ? undefined : linesByGame.get(gid);

  if (gid == null || !lines) {
    ingameCounts.skipped_unknown_game++;
    continue;
  }

  if (doneGames.has(gid)) {
    ingameCounts.duplicates++;
    continue;
  }

  // Champion match first (a champion is unique in a game, except in the odd
  // blind-pick game), then the Riot side each matched team corresponds to.
  const byChampion = new Map<number, typeof lines>();

  for (const l of lines) if (l.championId != null) byChampion.set(l.championId, [...(byChampion.get(l.championId) ?? []), l]);
  const candidates = (p: (typeof line.players)[number]) => byChampion.get(championIdByKey.get(p.championId) ?? -1) ?? [];
  const sideVotes = { same: 0, swapped: 0 };

  for (const p of line.players) {
    const c = candidates(p);

    if (c.length === 1) sideVotes[(p.teamId === 100) === (c[0].side === 1) ? "same" : "swapped"]++;
  }

  const swapped = sideVotes.swapped > sideVotes.same;
  const sideOf = (teamId: number) => ((teamId === 100) !== swapped ? 1 : 2);
  const matched = new Map<number, (typeof lines)[number]>();

  for (const p of line.players) {
    const c = candidates(p);
    const l = c.length === 1 ? c[0] : c.find((x) => x.side === sideOf(p.teamId));

    if (l) matched.set(p.pid, l);
  }

  for (const p of line.players) {
    if (matched.has(p.pid)) continue;
    const role = ROLE_ORDER[(p.pid - 1) % 5];
    const taken = new Set(matched.values());
    const l = lines.find((x) => x.side === sideOf(p.teamId) && x.role === role && !taken.has(x));

    if (l) {
      matched.set(p.pid, l);
      ingameCounts.participants_by_position++;
    }
  }

  if (matched.size < line.players.length || new Set([...matched.values()].map((l) => l.pid)).size < matched.size) {
    ingameCounts.skipped_mapping++;
    continue;
  }

  doneGames.add(gid);
  ingameCounts.games++;
  insRiot.run(gid, line.key, line.statsPage, line.version, line.hasTimeline ? 1 : 0, swapped ? 1 : 0);

  const stats = line.players.map((p) => ({ p, l: matched.get(p.pid)! }));

  for (const { p, l } of stats) {
    // Riot and Leaguepedia disagree on kills: a mapping (or scoreboard) problem worth a look.
    if (l.kills != null && l.kills !== p.kills) ingameCounts.kills_mismatch++;
    const opp = stats.find((o) => o.l.side !== l.side && o.l.role != null && o.l.role === l.role)?.p;
    insPlayerStats.run(
      gid, l.pid,
      p.gold_10, p.gold_15, p.gold_20, p.xp_10, p.xp_15, p.xp_20, p.cs_10, p.cs_15, p.cs_20,
      diff(p.gold_10, opp?.gold_10), diff(p.gold_15, opp?.gold_15), diff(p.gold_20, opp?.gold_20),
      diff(p.xp_10, opp?.xp_10), diff(p.xp_15, opp?.xp_15), diff(p.xp_20, opp?.xp_20),
      diff(p.cs_10, opp?.cs_10), diff(p.cs_15, opp?.cs_15), diff(p.cs_20, opp?.cs_20),
      p.kills_10, p.deaths_10, p.assists_10, p.solo_kills,
      p.first_blood_kill, p.first_blood_assist, p.first_blood_victim,
      p.double_kills, p.triple_kills, p.quadra_kills, p.penta_kills,
      p.wards_placed, p.wards_killed, p.control_wards, p.plates, p.damage_taken,
    );
  }

  for (const t of line.teams) {
    const o = line.teams.find((x) => x.teamId !== t.teamId);
    insTeamStats.run(
      gid, sideOf(t.teamId),
      t.first_blood, t.first_tower, t.first_dragon, t.first_herald, t.first_baron, t.first_inhibitor,
      t.plates, t.gold_10, t.gold_15, t.gold_20,
      diff(t.gold_10, o?.gold_10), diff(t.gold_15, o?.gold_15), diff(t.gold_20, o?.gold_20),
      t.kills_10, t.kills_15, t.kills_20, t.towers_15,
    );
  }
}

// Indexes and views -------------------------------------------------------------
db.exec(`
CREATE INDEX gp_player ON game_players(player_id);
CREATE INDEX gp_champion ON game_players(champion_id);
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
  SELECT gi.game_id, p.page AS player, gi.slot, i.name AS item, i.icon_url
  FROM game_player_items gi JOIN players p ON p.id = gi.player_id JOIN items i ON i.id = gi.item_id;
`);

// Ingest metadata ---------------------------------------------------------------
const TABLES = [
  "leagues", "tournaments", "tournament_results", "teams", "players", "player_aliases", "champions",
  "items", "runes", "games", "game_draft", "game_players", "game_player_items",
  "game_riot", "game_player_stats", "game_team_stats",
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
  JSON.stringify({ ddragon_version: dd.version, skipped_games: skippedGames, skipped_lines: skippedLines, item_icons: itemIcons, ingame: ingameCounts }),
);

db.exec("COMMIT");

db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; PRAGMA journal_mode=DELETE; ANALYZE; VACUUM;`);

const byLeague = db
  .prepare(
    `SELECT l.short_name AS league, COUNT(DISTINCT t.id) AS tournaments, COUNT(g.id) AS games, COUNT(gr.game_id) AS ingame
     FROM leagues l LEFT JOIN tournaments t ON t.league_id = l.id LEFT JOIN games g ON g.tournament_id = t.id
     LEFT JOIN game_riot gr ON gr.game_id = g.id
     GROUP BY l.id ORDER BY l.id`,
  )
  .all();

const journal = selectOne(db, z.object({ journal_mode: z.string() }), "PRAGMA journal_mode")?.journal_mode;

db.close();

console.log(`built ${DB_FILE} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const dbSize = statSync(DB_FILE).size;

console.log(`size: ${(dbSize / 1e6).toFixed(1)} MB, journal_mode=${journal}, schema v${SCHEMA_VERSION}`);

if (dbSize > DB_WARN_BYTES)
  console.warn(
    `warning: ${(dbSize / 1e6).toFixed(1)} MB is ${dbSize > DB_MAX_BYTES ? "over" : "close to"} the ${DB_MAX_BYTES / 1e6} MB budget (data:package refuses more): the /api/ask function must stay under 250 MB`,
  );

console.log(`skipped: ${skippedGames} games, ${skippedLines} player lines (outside scope or duplicates)`);

console.log("rows:", rowCounts);

console.log("item icons:", itemIcons);

console.log("in-game:", ingameCounts);

console.table(byLeague);
