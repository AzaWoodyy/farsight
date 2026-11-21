/**
 * The rows of the normalized database, computed from the raw cache (data/raw) without writing anything: every
 * writer (the SQLite file of the Data release, scripts/data/build.ts; Postgres, scripts/db/load.ts) stores the
 * same rows. Ids are given in the order rows are first seen, so two runs on the same cache give the same ids.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { normalizeAlias } from "../../src/lib/aliases";
import { enchantedKind, type ItemKind, ItemMeta, itemKinds } from "../../src/lib/domain/items";
import { UNDATED_PHOTO } from "../../src/lib/domain/player-photos";
import { TABLE_DDL } from "../../src/lib/db/schema";
import { DDRAGON_BASE } from "../../src/lib/sources/ddragon";
import { type CargoValue, StoredCargoRow } from "../../src/lib/sources/leaguepedia";
import { playerIdentity, teamIdentity } from "./identity";
import { DERIVE_COMPATIBLE, DERIVE_VERSION, leaguepediaPatch, type PlayerSummary } from "./ingame";
import { loadIngame } from "./riot";
import { RETIRED_RUNES, RUNE_TREES, runeName } from "./runes";
import { type ScoreboardMatch, scheduleOnly, scheduledSeries } from "./schedule";
import { type Classification, type Dataset, IngestRun, LEAGUES, classifyTournament, datasetFile } from "./scope";

/** A value of a row, as both writers take it. */
export type Cell = string | number | null;

/** A table's columns, in the order of its DDL, and its rows in the order they were first inserted. */
export type TableRows = { columns: string[]; rows: Cell[][] };

type Stored = TableRows & { key: number[]; byKey: Map<string, Cell[]>; byId: Map<Cell, Cell[]> };

/** Columns and primary key of each table, read from the shared DDL (src/lib/db/schema.ts). */
export function tableColumns(ddl = TABLE_DDL): Map<string, { columns: string[]; key: string[] }> {
  const tables = new Map<string, { columns: string[]; key: string[] }>();

  for (const m of ddl.replace(/--[^\n]*/g, "").matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\)(?: WITHOUT ROWID)?;/g)) {
    const parts = m[2].split(/,(?![^(]*\))/).map((p) => p.trim()).filter(Boolean);
    const columns = parts.filter((p) => !/^PRIMARY KEY/i.test(p)).map((p) => p.split(/\s+/)[0]);
    const composite = parts.find((p) => /^PRIMARY KEY/i.test(p));
    const key = composite ? composite.replace(/^PRIMARY KEY\s*\(|\)$/gi, "").split(",").map((c) => c.trim()) : parts.filter((p) => /PRIMARY KEY/i.test(p)).map((p) => p.split(/\s+/)[0]);

    tables.set(m[1], { columns, key });
  }

  return tables;
}

/**
 * Rows kept in memory, table by table, with the semantics the SQLite build relied on: a plain insert refuses a key
 * already there, an ignoring insert (`INSERT OR IGNORE`) keeps the first row, an update by id changes it in place.
 */
export class Store {
  readonly tables = new Map<string, Stored>();

  constructor() {
    for (const [name, { columns, key }] of tableColumns()) this.tables.set(name, { columns, rows: [], key: key.map((k) => columns.indexOf(k)), byKey: new Map(), byId: new Map() });
  }

  private table(name: string): Stored {
    const t = this.tables.get(name);

    if (!t) throw new Error(`Unknown table ${name}`);

    return t;
  }

  private indexes(t: Stored, name: string, columns: string[]) {
    return columns.map((c) => {
      const i = t.columns.indexOf(c);

      if (i < 0) throw new Error(`Unknown column ${name}.${c}`);

      return i;
    });
  }

  insert(name: string, columns: string[], { ignore = false } = {}) {
    const t = this.table(name);
    const at = this.indexes(t, name, columns);
    const id = t.columns.indexOf("id");

    return {
      run: (...values: (Cell | undefined)[]) => {
        const row: Cell[] = t.columns.map(() => null);

        at.forEach((i, k) => (row[i] = values[k] ?? null));
        const key = JSON.stringify(t.key.map((i) => row[i]));

        if (t.key.length && t.byKey.has(key)) {
          if (ignore) return;
          throw new Error(`Duplicate key ${key} in ${name}`);
        }

        if (t.key.length) t.byKey.set(key, row);
        t.rows.push(row);

        if (id >= 0) t.byId.set(row[id], row);
      },
    };
  }

  /** `UPDATE name SET columns… WHERE id = ?`: the id is the last value. */
  update(name: string, columns: string[]) {
    const t = this.table(name);
    const at = this.indexes(t, name, columns);

    return {
      run: (...values: (Cell | undefined)[]) => {
        const row = t.byId.get(values.at(-1) ?? null);

        if (row) at.forEach((i, k) => (row[i] = values[k] ?? null));
      },
    };
  }

  /**
   * `UPDATE name SET column = ? WHERE <primary key> = ? AND column IS NULL`: the key values follow the value, in the
   * order of the primary key. True when a row changed.
   */
  fill(name: string, column: string) {
    const t = this.table(name);
    const [at] = this.indexes(t, name, [column]);

    return {
      run: (value: Cell | undefined, ...key: Cell[]): boolean => {
        const row = t.byKey.get(JSON.stringify(key));

        if (value == null || !row || row[at] != null) return false;
        row[at] = value;

        return true;
      },
    };
  }

  /** Whether a row of `name` has this primary key. */
  has(name: string, ...key: Cell[]): boolean {
    return this.table(name).byKey.has(JSON.stringify(key));
  }

  /** `SELECT id, name FROM name`, in insertion order. */
  names(name: string): { id: number; name: string }[] {
    const t = this.table(name);
    const [id, label] = this.indexes(t, name, ["id", "name"]);

    return t.rows.map((r) => ({ id: Number(r[id]), name: String(r[label]) }));
  }
}

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

/** Every row of the database, from the raw cache. */
export function deriveDataset() {
  const store = new Store();

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
    const insert = store.insert(table, ["id", "name"]);

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

  // Leagues -----------------------------------------------------------------------
  const leagueId = new Map<string, number>();
  const insLeague = store.insert("leagues", ["id", "name", "short_name", "region", "is_international"]);

  LEAGUES.forEach((l, i) => {
    leagueId.set(l.name, i + 1);
    insLeague.run(i + 1, l.name, l.short, l.region, l.international ? 1 : 0);
  });

  const leagueByName = new Map<string, (typeof LEAGUES)[number]>(LEAGUES.map((l) => [l.name, l]));

  // Teams of Leaguepedia (page, abbreviation). Absent from an older raw cache: the names then stay as written and the
  // teams have no abbreviation.
  const teamsFile = datasetFile("teams");
  const teamPageRows = existsSync(teamsFile) ? load("teams", Rows) : null;
  const teamName = teamPageRows ? teamIdentity(teamPageRows.flatMap((r) => text(r.Page) ?? [])) : (name: string) => name;
  const teamDict = dictionary("teams");
  // Spellings folded into another one ("Dplus KIA" -> "Dplus Kia"): only the team ids move.
  const caseMerged = new Set<string>();

  const team = (name: Field) => {
    if (name == null || name === "") return teamDict(name);
    const raw = String(name).trim();
    const canonical = teamName(raw);

    if (canonical !== raw) caseMerged.add(raw);

    return teamDict(canonical);
  };

  const champion = dictionary("champions");
  const rune = dictionary("runes");
  const spell = dictionary("summoner_spells");

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
  // A page named after its edition is that year: Leaguepedia files the December KeSPA Cup ("2025 LoL KeSPA Cup")
  // under the next LCK season.
  const yearOf = (t: Row) => {
    const page = String(t.Page);
    const edition = /^(\d{4}) /.exec(page);

    if (edition) return Number(edition[1]);
    const y = int(t.Year);

    if (y) return y;
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
  const insTournament = store.insert("tournaments", ["id", "page", "event_page", "stage", "name", "league_id", "year", "date_start", "date_end", "split"]);

  for (const [page, t] of tournaments) {
    const id = tournamentId.size + 1;
    tournamentId.set(page, id);
    insTournament.run(
      id, page, t.eventPage, t.stage, text(t.Name), leagueId.get(String(t.League))!, yearOf(t),
      text(t.DateStart), text(t.DateEnd), text(t.Split),
    );
  }

  const insResult = store.insert("tournament_results", ["tournament_id", "team_id", "place", "place_number", "prize_usd"], { ignore: true });

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
  const insGame = store.insert("games", ["id", "tournament_id", "tab", "match_n", "game_n", "blue_team_id", "red_team_id", "winner_side", "length_s", "patch", "played_at", "blue_dragons", "red_dragons", "blue_barons", "red_barons", "blue_towers", "red_towers", "blue_heralds", "red_heralds", "blue_void_grubs", "red_void_grubs", "blue_inhibitors", "red_inhibitors"]);
  const insDraft = store.insert("game_draft", ["game_id", "side", "kind", "slot", "champion_id"], { ignore: true });
  let skippedGames = 0;

  /** Every scoreboard game, to tell the schedule's series that have one from those that have none. */
  const scoreboardMatches: ScoreboardMatch[] = [];

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
    const playedAt = date ? Math.floor(Date.parse(`${date.replace(" ", "T")}Z`) / 1000) : null;
    scoreboardMatches.push({ page, tab: slot?.tab ?? null, n: slot?.match ?? null, team1: text(g.Team1), team2: text(g.Team2), playedAt });
    insGame.run(
      id, tid, slot?.tab ?? null, slot?.match ?? null, slot?.game ?? null, team(g.Team1), team(g.Team2), int(g.Winner), seconds(g.Len), text(g.Patch),
      playedAt,
      int(g.D1), int(g.D2), int(g.Ba1), int(g.Ba2), int(g.To1), int(g.To2),
      int(g.H1), int(g.H2), int(g.V1), int(g.V2), int(g.I1), int(g.I2),
    );

    for (const [side, kind, value] of [[1, 0, g.P1], [2, 0, g.P2], [1, 1, g.B1], [2, 1, g.B2]] as const)
      list(value).forEach((c, slot) => {
        if (c !== "None" && c !== "Loss of Ban") insDraft.run(id, side, kind, slot + 1, champion(c));
      });
  }

  // Player lines ------------------------------------------------------------------
  // A scoreboard link is not always the player page (case, older handle): every
  // link of a player goes to one row, keyed by the page `canonical` finds.
  const playerRows = load("players", Rows);
  const redirectRows = load("redirects", Rows);

  const canonical = playerIdentity(
    playerRows.map((p) => String(p.Page)),
    redirectRows.map((r) => ({ name: String(r.AllName), page: String(r.Page) })),
  );

  const playerId = new Map<string, number>();
  const insPlayer = store.insert("players", ["id", "page"]);

  const player = (page: string) => {
    let id = playerId.get(page);

    if (id == null) {
      id = playerId.size + 1;
      playerId.set(page, id);
      insPlayer.run(id, page);
    }

    return id;
  };

  /** The scoreboard links behind each player, kept as aliases. */
  const linksByPlayer = new Map<number, Set<string>>();
  const identity = { page: 0, case: 0, redirect: 0, ambiguous: 0, unknown: 0, merged_lines: 0, same_game: 0 };
  const countedLinks = new Set<string>();

  const insLine = store.insert("game_players", ["game_id", "player_id", "team_id", "side", "role", "champion_id", "win", "kills", "deaths", "assists", "gold", "cs", "damage", "vision", "keystone_id", "spell1_id", "spell2_id"], { ignore: true });
  const insRunes = store.insert("game_player_runes", ["game_id", "player_id", "primary1_id", "primary2_id", "primary3_id", "secondary1_id", "secondary2_id", "shard1_id", "shard2_id", "shard3_id"], { ignore: true });
  const insItem = store.insert("game_player_items", ["game_id", "player_id", "slot", "item_id"], { ignore: true });
  let skippedLines = 0;
  let oddRunePages = 0;

  /** The Leaguepedia lines of each game, to map Riot participants onto players. */
  const linesByGame = new Map<number, { pid: number; side: number | null; role: string | null; championId: number | null; kills: number | null }[]>();
  const ignByPlayer = new Map<number, Set<string>>();

  const lineRows = load("lines", Rows);
  const linkOf = (l: Row) => text(l.Link) ?? text(l.Name);

  // Two links of one player in the same game: one of them is another person on
  // that scoreboard, so in that game a renamed link keeps its own identity.
  const pagesInGame = new Map<string, Map<string, number>>();

  /**
   * A rune page in order: the keystone, three primary runes, two secondary ones, then three stat shards (absent on some
   * pages). A list of another length is not trusted slot by slot.
   */
  const runePage = (l: Row) => {
    const page = list(l.Runes);

    return page.length === 9 || page.length === 6 ? page : [];
  };

  // Tree of each rune, as the lines name it (Data Dragon only knows the runes of its patch): the tree most lines agree on.
  const treeVotes = new Map<string, Map<string, number>>();

  const vote = (name: Field, tree: Field) => {
    if (!name || !tree) return;
    const votes = treeVotes.get(String(name)) ?? new Map<string, number>();
    votes.set(String(tree), (votes.get(String(tree)) ?? 0) + 1);
    treeVotes.set(String(name), votes);
  };

  for (const l of lineRows) {
    vote(l.Keystone, l.Primary);
    runePage(l).slice(1, 6).forEach((name, i) => vote(name, i < 3 ? l.Primary : l.Secondary));
    const link = linkOf(l);

    if (!link) continue;
    const seen = pagesInGame.get(String(l.GameId)) ?? new Map<string, number>();
    const { page } = canonical(link);
    seen.set(page, (seen.get(page) ?? 0) + 1);
    pagesInGame.set(String(l.GameId), seen);
  }

  for (const l of lineRows) {
    const gid = gameId.get(String(l.GameId));
    const link = linkOf(l);

    if (!gid || !link) {
      skippedLines++;
      continue;
    }

    const { page, via } = canonical(link);
    const sameGame = page !== link && (pagesInGame.get(String(l.GameId))?.get(page) ?? 0) > 1;
    const pid = player(sameGame ? link : page);

    if (sameGame) identity.same_game++;
    else if (page !== link) identity.merged_lines++;

    if (!countedLinks.has(link)) {
      countedLinks.add(link);
      identity[via]++;
    }

    linksByPlayer.set(pid, (linksByPlayer.get(pid) ?? new Set()).add(link));
    const championId = champion(l.Champion);
    const side = int(l.Side);
    const lines = linesByGame.get(gid) ?? [];
    lines.push({ pid, side, role: text(l.Role), championId, kills: int(l.K) });
    linesByGame.set(gid, lines);

    if (l.Name) ignByPlayer.set(pid, (ignByPlayer.get(pid) ?? new Set()).add(String(l.Name)));
    const spells = list(l.Spells).sort();
    insLine.run(
      gid, pid, team(l.Team), side, text(l.Role), championId, yes(l.Win),
      int(l.K), int(l.D), int(l.A), int(l.Gold), int(l.CS), int(l.Dmg), int(l.Vision), rune(l.Keystone),
      spell(spells[0]), spell(spells[1]),
    );

    const slots = runePage(l).slice(1);

    if (slots.length) insRunes.run(gid, pid, ...Array.from({ length: 8 }, (_, i) => rune(slots[i])));
    else if (list(l.Runes).length) oddRunePages++;

    list(l.Items).forEach((it, slot) => insItem.run(gid, pid, slot + 1, item(it)));
  }

  // Players and aliases -----------------------------------------------------------
  const insAlias = store.insert("player_aliases", ["alias", "raw", "player_id"], { ignore: true });

  const alias = (raw: Field, pid: number) => {
    if (!raw) return;
    const n = normalizeAlias(String(raw));

    if (n.length >= 2) insAlias.run(n, String(raw), pid);
  };

  const updPlayer = store.update("players", ["ign", "real_name", "native_name"]);

  for (const p of playerRows) {
    const pid = playerId.get(String(p.Page));

    if (!pid) continue;
    updPlayer.run(text(p.ID), text(p.Name), text(p.NativeName), pid);

    for (const a of [p.ID, p.Name, p.NativeName]) alias(a, pid);
    // Korean/Chinese romanizations: also index the given name ("Jeong Ji-hoon" -> "Ji-hoon").
    const real = text(p.Name);

    if (real?.includes(" ")) alias(real.split(" ").slice(1).join(" "), pid);
  }

  for (const r of redirectRows) {
    const pid = playerId.get(String(r.Page));

    if (pid) alias(r.AllName, pid);
  }

  for (const [page, pid] of playerId) alias(page, pid);

  for (const [pid, links] of linksByPlayer) for (const link of links) alias(link, pid);

  for (const [pid, names] of ignByPlayer) for (const n of names) alias(n, pid);

  // Player photos -----------------------------------------------------------------
  // Leaguepedia headshots, dated by the start of the tournament they were taken for. An image's link is resolved
  // like a scoreboard link (case, older handle). Absent from an older raw cache: the players then have no photo.
  // An undated headshot is kept only for a player who has no dated one, at the oldest date (UNDATED_PHOTO): any
  // dated photo would win over it, and the page shows it without a year.
  const insImage = store.insert("player_images", ["player_id", "taken_at", "file"], { ignore: true });
  const photoCounts = { kept: 0, other_players: 0, undated: 0, undated_fallback: 0, wide_shot: 0 };
  const datedPhotos = new Set<number>();
  const undatedPhotos = new Map<number, string[]>();

  // ImageType is free text (Headshot, headshot, Portrait, Profile, Bodyshot, Stageshot...): wide shots crop badly into an avatar.
  const WIDE_SHOT = /body|full|stage|tilt|valentine/i;
  const imagesFile = datasetFile("player_images");

  for (const r of existsSync(imagesFile) ? load("player_images", Rows) : []) {
    const file = text(r.File);
    const link = text(r.Link);
    const date = text(r.DateStart) ?? text(r.SortDate);
    const pid = link ? playerId.get(canonical(link).page) : undefined;

    if (!file || pid == null) photoCounts.other_players++;
    else if (r.Type != null && WIDE_SHOT.test(String(r.Type))) photoCounts.wide_shot++;
    else if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) undatedPhotos.set(pid, [...(undatedPhotos.get(pid) ?? []), file]);
    else {
      insImage.run(pid, Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 1000, file);
      datedPhotos.add(pid);
      photoCounts.kept++;
    }
  }

  for (const [pid, files] of undatedPhotos) {
    if (datedPhotos.has(pid)) {
      photoCounts.undated += files.length;
      continue;
    }

    // Several undated files: the first by name, so a rebuild picks the same one.
    insImage.run(pid, UNDATED_PHOTO, files.toSorted()[0]);
    photoCounts.undated_fallback++;
    photoCounts.undated += files.length - 1;
  }

  if (!existsSync(imagesFile)) console.warn(`  ${imagesFile} is missing: no player photo (run \`bun run data:fetch\`)`);

  // Data Dragon -------------------------------------------------------------------
  const DdragonData = z.object({
    version: z.string(),
    champion: z.object({
      data: z.record(z.string(), z.object({ id: z.string(), key: z.string(), name: z.string(), image: z.object({ full: z.string() }) })),
    }),
    item: z.object({ data: z.record(z.string(), z.looseObject({ name: z.string() })) }),
    runes: z.array(z.object({ name: z.string(), slots: z.array(z.object({ runes: z.array(z.object({ id: z.number().int(), name: z.string(), icon: z.string() })) })) })),
    summoner: z.object({ data: z.record(z.string(), z.object({ name: z.string(), image: z.object({ full: z.string() }), modes: z.array(z.string()).optional() })) }),
    // `meta` is absent from raw caches fetched before items had a kind: their retired items get a NULL kind.
    legacyItems: z.array(z.object({ version: z.string(), items: z.record(z.string(), z.string()), meta: z.record(z.string(), ItemMeta).optional() })),
  });

  const dd = load("ddragon", DdragonData);
  const cdn = `${DDRAGON_BASE}/cdn`;

  const championByName = new Map(Object.values(dd.champion.data).map((c) => [normalizeAlias(c.name), c]));

  for (const [display, id] of [["Nunu", "Nunu"], ["Wukong", "MonkeyKing"]] as const) {
    const c = Object.values(dd.champion.data).find((x) => x.id === id);

    if (c) championByName.set(normalizeAlias(display), c);
  }

  const updChampion = store.update("champions", ["icon_url"]);

  for (const c of store.names("champions")) {
    const d = championByName.get(normalizeAlias(c.name));
    updChampion.run(d ? `${cdn}/${dd.version}/img/champion/${d.image.full}` : null, c.id);
  }

  // Summoner spells: the Summoner's Rift entry when several modes share a name.
  const ddSpells = new Map<string, string>();

  for (const sp of Object.values(dd.summoner.data).sort((a, b) => Number(b.modes?.includes("CLASSIC") ?? false) - Number(a.modes?.includes("CLASSIC") ?? false)))
    if (!ddSpells.has(normalizeAlias(sp.name))) ddSpells.set(normalizeAlias(sp.name), sp.image.full);

  const updSpell = store.update("summoner_spells", ["icon_url"]);

  for (const sp of store.names("summoner_spells")) {
    const image = ddSpells.get(normalizeAlias(sp.name));
    updSpell.run(image ? `${cdn}/${dd.version}/img/spell/${image}` : null, sp.id);
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

  // Kind from the newest patch that has the item (ARAM and Arena variants share names with another recipe).
  const kindSources: { meta: Record<string, ItemMeta>; items: Record<string, string> }[] = [
    {
      meta: Object.fromEntries(Object.entries(dd.item.data).flatMap(([id, it]) => {
        const meta = ItemMeta.safeParse(it);

        return meta.success ? [[id, meta.data]] : [];
      })),
      items: Object.fromEntries(Object.entries(dd.item.data).map(([k, v]) => [k, v.name])),
    },
    ...dd.legacyItems.map((l) => ({ meta: l.meta ?? {}, items: l.items })),
  ];

  const itemKindByName = new Map<string, ItemKind>();

  // Summoner's Rift entries of every patch first, then the other maps' entries for names the Rift never had.
  for (const rift of [true, false])
    for (const src of kindSources) {
      const kinds = itemKinds(src.meta);

      for (const [id, name] of Object.entries(src.items)) {
        const key = normalizeAlias(name);

        if (kinds[id] && (src.meta[id].maps?.["11"] === true) === rift && !itemKindByName.has(key)) itemKindByName.set(key, kinds[id]);
      }
    }

  const kindOfItem = (name: string) => {
    const kindOf = (n: string) => itemKindByName.get(normalizeAlias(n));

    return kindOf(name) ?? enchantedKind(name, kindOf) ?? null;
  };

  const insItemRow = store.insert("items", ["id", "name", "icon_url", "kind"]);
  const itemIcons = { ddragon: 0, ddragon_legacy: 0, fallback: 0 };
  const kindCounts: Record<string, number> = {};

  for (const [name, id] of itemIds) {
    const icon = itemIcon.get(normalizeAlias(name));
    const kind = kindOfItem(name);
    insItemRow.run(id, name, icon ? `${cdn}/${icon.version}/img/item/${icon.id}.png` : ITEM_FALLBACK_ICON, kind);
    itemIcons[icon ? (icon.legacy ? "ddragon_legacy" : "ddragon") : "fallback"]++;
    kindCounts[kind ?? "unknown"] = (kindCounts[kind ?? "unknown"] ?? 0) + 1;
  }

  // In-game stats (Riot JSON summaries) --------------------------------------------
  // Riot participants are matched to Leaguepedia lines by champion (unique in a
  // game), then by side and position for the rare champion that does not match.
  const ROLE_ORDER = ["Top", "Jungle", "Mid", "Bot", "Support"];

  const championIdByKey = new Map<number, number>();

  const championIdByName = new Map(
    store.names("champions").map((c) => [normalizeAlias(c.name), c.id]),
  );

  for (const c of Object.values(dd.champion.data)) {
    const id = championIdByName.get(normalizeAlias(c.name)) ?? championIdByName.get(normalizeAlias(c.id));

    if (id != null) championIdByKey.set(Number(c.key), id);
  }

  const insRiot = store.insert("game_riot", ["game_id", "riot_key", "stats_page", "json_version", "has_timeline", "side_swapped"]);
  const insPlayerStats = store.insert("game_player_stats", ["game_id", "player_id", "gold_10", "gold_15", "gold_20", "xp_10", "xp_15", "xp_20", "cs_10", "cs_15", "cs_20", "gold_diff_10", "gold_diff_15", "gold_diff_20", "xp_diff_10", "xp_diff_15", "xp_diff_20", "cs_diff_10", "cs_diff_15", "cs_diff_20", "kills_10", "deaths_10", "assists_10", "solo_kills", "first_blood_kill", "first_blood_assist", "first_blood_victim", "double_kills", "triple_kills", "quadra_kills", "penta_kills", "wards_placed", "wards_killed", "control_wards", "plates", "damage_taken"], { ignore: true });
  const insTeamStats = store.insert("game_team_stats", ["game_id", "side", "first_blood", "first_tower", "first_dragon", "first_herald", "first_baron", "first_inhibitor", "plates", "gold_10", "gold_15", "gold_20", "gold_diff_10", "gold_diff_15", "gold_diff_20", "kills_10", "kills_15", "kills_20", "towers_15", "elder_dragons", "dragon_soul", "soul"], { ignore: true });
  const insDragon = store.insert("game_dragons", ["game_id", "seq", "team_seq", "side", "kind", "time_s"]);
  const ingameCounts = { games: 0, skipped_unknown_game: 0, skipped_mapping: 0, participants_by_position: 0, kills_mismatch: 0, missing: 0, invalid: 0, duplicates: 0, stale_derive: 0, older_derive: 0 };
  const diff = (a: number | null, b: number | null | undefined) => (a == null || b == null ? null : a - b);

  // What the scoreboard lacks, taken from the Riot JSON (derive 4): Leaguepedia's value always wins.
  const fromRiot = { damage: 0, vision: 0, heralds: 0, patch: 0, rune_pages: 0, keystones: 0, rune_pages_unknown_id: 0 };
  const fillDamage = store.fill("game_players", "damage");
  const fillVision = store.fill("game_players", "vision");
  const fillBlueHeralds = store.fill("games", "blue_heralds");
  const fillRedHeralds = store.fill("games", "red_heralds");
  const fillPatch = store.fill("games", "patch");
  const fillKeystone = store.fill("game_players", "keystone_id");
  const ddRuneNames = new Map(dd.runes.flatMap((t) => t.slots.flatMap((sl) => sl.runes.map((r) => [r.id, r.name] as const))));

  /** Filled from the Riot JSON when the value is known and Leaguepedia has none; counted in `fromRiot`. */
  const fill = (filler: ReturnType<Store["fill"]>, field: keyof typeof fromRiot, value: Cell | undefined, ...key: Cell[]) => {
    if (filler.run(value, ...key)) fromRiot[field]++;
  };

  /**
   * A scoreboard without a rune page gets the Riot one (names of the game's patch, `runes.ts`), with its trees as votes.
   * A page with an id that no table names is left out, not stored with a hole.
   */
  const fillRunes = (p: PlayerSummary, gid: number, pid: number, version: string | null | undefined) => {
    if (!p.runes || store.has("game_player_runes", gid, pid)) return;
    const names = p.runes.map((id) => runeName(id, version, ddRuneNames));

    if (!names.every((n) => n != null)) {
      fromRiot.rune_pages_unknown_id++;

      return;
    }

    const slots = names.slice(1);

    insRunes.run(gid, pid, ...Array.from({ length: 8 }, (_, i) => rune(slots[i])));
    fromRiot.rune_pages++;
    const primary = RUNE_TREES.get(p.primary_tree ?? -1);
    const secondary = RUNE_TREES.get(p.secondary_tree ?? -1);
    names.slice(0, 6).forEach((name, i) => vote(name, i < 4 ? primary : secondary));

    fill(fillKeystone, "keystones", rune(names[0]), gid, pid);
  };

  const ingame = loadIngame();
  const doneGames = new Set<number>();

  for (const line of ingame.values()) {
    if (line.status !== "ok") {
      ingameCounts[line.status]++;
      continue;
    }

    if (line.derive < DERIVE_COMPATIBLE || line.derive > DERIVE_VERSION) {
      ingameCounts.stale_derive++;
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

    // Kept, without what the versions after it added (NULL columns, no dragon row).
    if (line.derive !== DERIVE_VERSION) ingameCounts.older_derive++;

    insRiot.run(gid, line.key, line.statsPage, line.version, line.hasTimeline ? 1 : 0, swapped ? 1 : 0);

    const stats = line.players.map((p) => ({ p, l: matched.get(p.pid)! }));

    for (const { p, l } of stats) {
      // Riot and Leaguepedia disagree on kills: a mapping (or scoreboard) problem worth a look.
      if (l.kills != null && l.kills !== p.kills) ingameCounts.kills_mismatch++;
      const opp = stats.find((o) => o.l.side !== l.side && o.l.role != null && o.l.role === l.role)?.p;
      fill(fillDamage, "damage", p.damage, gid, l.pid);
      fillRunes(p, gid, l.pid, line.gameVersion);
      fill(fillVision, "vision", p.vision, gid, l.pid);
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

    fill(fillPatch, "patch", leaguepediaPatch(line.gameVersion), gid);

    for (const t of line.teams) {
      const o = line.teams.find((x) => x.teamId !== t.teamId);
      fill(sideOf(t.teamId) === 1 ? fillBlueHeralds : fillRedHeralds, "heralds", t.heralds, gid);
      insTeamStats.run(
        gid, sideOf(t.teamId),
        t.first_blood, t.first_tower, t.first_dragon, t.first_herald, t.first_baron, t.first_inhibitor,
        t.plates, t.gold_10, t.gold_15, t.gold_20,
        diff(t.gold_10, o?.gold_10), diff(t.gold_15, o?.gold_15), diff(t.gold_20, o?.gold_20),
        t.kills_10, t.kills_15, t.kills_20, t.towers_15,
        t.elder_dragons ?? null, t.dragon_soul ?? null, t.soul ?? null,
      );
    }

    const teamSeq = new Map<number, number>();

    (line.dragons ?? []).forEach((d, i) => {
      const s = d.teamId == null ? null : sideOf(d.teamId);

      if (s != null) teamSeq.set(s, (teamSeq.get(s) ?? 0) + 1);
      insDragon.run(gid, i + 1, s == null ? null : teamSeq.get(s)!, s, d.kind, d.t);
    });
  }

  // Runes: tree and icon from Data Dragon, the tree of a removed rune from `runes.ts` or from the lines (Leaguepedia's
  // and the Riot pages'). Stat shards have neither. After the in-game stats, which may add runes.
  const ddRunes = new Map(dd.runes.flatMap((t) => t.slots.flatMap((s) => s.runes.map((r) => [normalizeAlias(r.name), { tree: t.name, icon: r.icon }] as const))));
  const updRune = store.update("runes", ["tree", "icon_url"]);
  const runeCounts = { ddragon: 0, tree_retired: 0, tree_from_lines: 0, shard_or_unknown: 0 };
  const retiredTree = new Map([...RETIRED_RUNES.values()].map((x) => [x.name, x.tree]));

  for (const r of store.names("runes")) {
    const d = ddRunes.get(normalizeAlias(r.name));
    const retired = retiredTree.get(r.name);
    const voted = [...(treeVotes.get(r.name) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    updRune.run(d?.tree ?? retired ?? voted, d ? `${cdn}/img/${d.icon}` : null, r.id);
    runeCounts[d ? "ddragon" : retired ? "tree_retired" : voted ? "tree_from_lines" : "shard_or_unknown"]++;
  }

  // Series without a scoreboard ----------------------------------------------------
  // The decided matches of Leaguepedia's schedule that no scoreboard game covers: their result, without any game
  // statistic. Team names are the schedule's, the same page names as the scoreboards'. Absent from an older raw cache.
  const scheduleFile = datasetFile("schedule");
  const insSeries = store.insert("series_results", ["id", "tournament_id", "tab", "match_n", "team1_id", "team2_id", "winner_side", "team1_score", "team2_score", "forfeit", "played_at"]);
  const seriesCounts = { decided: 0, outside_scope: 0, with_scoreboard: 0, kept: 0, forfeits: 0 };

  if (existsSync(scheduleFile)) {
    const matches = load("schedule", Rows).flatMap((r) => scheduledSeries(r) ?? []);
    const decided = matches.filter((s) => s.winner != null);
    seriesCounts.decided = decided.length;
    seriesCounts.outside_scope = decided.filter((s) => !tournamentId.has(s.page)).length;
    // Every match of the scope claims its scoreboards, a draw included; only the decided ones are kept.
    const kept = scheduleOnly(matches.filter((s) => tournamentId.has(s.page)), scoreboardMatches);
    seriesCounts.with_scoreboard = decided.length - seriesCounts.outside_scope - kept.length;

    kept.forEach((s, i) => {
      insSeries.run(i + 1, tournamentId.get(s.page)!, s.tab, s.n, team(s.team1), team(s.team2), s.winner!, s.score1, s.score2, s.forfeit, s.playedAt);
      seriesCounts.kept++;

      if (s.forfeit) seriesCounts.forfeits++;
    });
  } else {
    console.warn(`  ${scheduleFile} is missing: no series without a scoreboard (run \`bun run data:fetch\`)`);
  }

  // Team abbreviations ------------------------------------------------------------
  // Teams.Short of the team's page ("Karmine Corp Blue Stars" -> "KCBS"), or of the page an older name redirects to
  // ("Afreeca Freecs" -> "DN SOOPers" -> "DNS"). Absent from an older raw cache: the teams then have no abbreviation.
  const redirectsFile = datasetFile("team_redirects");
  const shortCounts = { page: 0, redirect: 0, none: 0 };

  if (teamPageRows) {
    const shortOf = new Map<string, string>();

    for (const r of teamPageRows) {
      const page = text(r.Page);
      const short = text(r.Short)?.trim();

      if (page && short) shortOf.set(page.toLowerCase(), short);
    }

    const redirectTo = new Map<string, string>();

    for (const r of existsSync(redirectsFile) ? load("team_redirects", Rows) : []) {
      const name = text(r.AllName);
      const page = text(r.Page);

      if (name && page) redirectTo.set(name.toLowerCase(), page.toLowerCase());
    }

    const setShort = store.update("teams", ["short"]);
    const teamRows = store.names("teams");
    // An abbreviation a team holds on its own page is not lent to an older name through a redirect: "DNS.C" is
    // DN SOOPers Challengers, not Kwangdong Freecs Challengers, which redirects there and has more games.
    const heldDirectly = new Set(teamRows.flatMap((t) => shortOf.get(t.name.toLowerCase()) ?? []));

    for (const { id, name } of teamRows) {
      const key = name.toLowerCase();
      const direct = shortOf.get(key);
      const redirected = redirectTo.has(key) ? shortOf.get(redirectTo.get(key)!) : undefined;
      const viaRedirect = redirected && !heldDirectly.has(redirected) ? redirected : undefined;
      const short = direct ?? viaRedirect;

      if (short) setShort.run(short, id);
      shortCounts[direct ? "page" : viaRedirect ? "redirect" : "none"]++;
    }
  } else {
    console.warn(`  ${teamsFile} is missing: no team abbreviation (run \`bun run data:fetch\`)`);
  }

  const runs = load("runs", z.array(IngestRun));

  return {
    tables: new Map([...store.tables].map(([name, t]) => [name, { columns: t.columns, rows: t.rows }])),
    runs,
    ddragonVersion: dd.version,
    report: { skipped_games: skippedGames, skipped_lines: skippedLines, item_icons: itemIcons, item_kinds: kindCounts, rune_sources: runeCounts, odd_rune_pages: oddRunePages, ingame: ingameCounts, from_riot: fromRiot, identity, player_images: photoCounts, team_shorts: shortCounts, team_case_merged: caseMerged.size, schedule_series: seriesCounts },
  };
}
