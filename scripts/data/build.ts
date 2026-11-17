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
import { enchantedKind, type ItemKind, ItemMeta, itemKinds } from "../../src/lib/domain/items";
import { DB_MAX_BYTES, DB_WARN_BYTES } from "./artifact";
import { playerIdentity } from "./identity";
import { loadIngame } from "./riot";
import { DERIVE_COMPATIBLE, DERIVE_VERSION } from "./ingame";
import { createSchema, createQuerySchema, SCHEMA_TABLES } from "../../src/lib/db/schema";
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

createSchema(db);

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
const insLeague = db.prepare("INSERT INTO leagues (id, name, short_name, region, is_international) VALUES (?, ?, ?, ?, ?)");

LEAGUES.forEach((l, i) => {
  leagueId.set(l.name, i + 1);
  insLeague.run(i + 1, l.name, l.short, l.region, l.international ? 1 : 0);
});

const leagueByName = new Map<string, (typeof LEAGUES)[number]>(LEAGUES.map((l) => [l.name, l]));

const team = dictionary("teams");
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
const insTournament = db.prepare("INSERT INTO tournaments (id, page, event_page, stage, name, league_id, year, date_start, date_end, split) VALUES (?,?,?,?,?,?,?,?,?,?)");

for (const [page, t] of tournaments) {
  const id = tournamentId.size + 1;
  tournamentId.set(page, id);
  insTournament.run(
    id, page, t.eventPage, t.stage, text(t.Name), leagueId.get(String(t.League))!, yearOf(t),
    text(t.DateStart), text(t.DateEnd), text(t.Split),
  );
}

const insResult = db.prepare("INSERT OR IGNORE INTO tournament_results (tournament_id, team_id, place, place_number, prize_usd) VALUES (?,?,?,?,?)");

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
const insGame = db.prepare(`INSERT INTO games (id, tournament_id, tab, match_n, game_n, blue_team_id, red_team_id, winner_side, length_s, patch, played_at, blue_dragons, red_dragons, blue_barons, red_barons, blue_towers, red_towers, blue_heralds, red_heralds, blue_void_grubs, red_void_grubs, blue_inhibitors, red_inhibitors) VALUES (${Array(23).fill("?").join(",")})`);
const insDraft = db.prepare("INSERT OR IGNORE INTO game_draft (game_id, side, kind, slot, champion_id) VALUES (?,?,?,?,?)");
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
// A scoreboard link is not always the player page (case, older handle): every
// link of a player goes to one row, keyed by the page `canonical` finds.
const playerRows = load("players", Rows);
const redirectRows = load("redirects", Rows);

const canonical = playerIdentity(
  playerRows.map((p) => String(p.Page)),
  redirectRows.map((r) => ({ name: String(r.AllName), page: String(r.Page) })),
);

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

/** The scoreboard links behind each player, kept as aliases. */
const linksByPlayer = new Map<number, Set<string>>();
const identity = { page: 0, case: 0, redirect: 0, ambiguous: 0, unknown: 0, merged_lines: 0, same_game: 0 };
const countedLinks = new Set<string>();

const insLine = db.prepare(`INSERT OR IGNORE INTO game_players (game_id, player_id, team_id, side, role, champion_id, win, kills, deaths, assists, gold, cs, damage, vision, keystone_id, spell1_id, spell2_id) VALUES (${Array(17).fill("?").join(",")})`);
const insRunes = db.prepare(`INSERT OR IGNORE INTO game_player_runes (game_id, player_id, primary1_id, primary2_id, primary3_id, secondary1_id, secondary2_id, shard1_id, shard2_id, shard3_id) VALUES (${Array(10).fill("?").join(",")})`);
const insItem = db.prepare("INSERT OR IGNORE INTO game_player_items (game_id, player_id, slot, item_id) VALUES (?,?,?,?)");
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
const insAlias = db.prepare("INSERT OR IGNORE INTO player_aliases (alias, raw, player_id) VALUES (?,?,?)");

const alias = (raw: Field, pid: number) => {
  if (!raw) return;
  const n = normalizeAlias(String(raw));

  if (n.length >= 2) insAlias.run(n, String(raw), pid);
};

const updPlayer = db.prepare("UPDATE players SET ign=?, real_name=?, native_name=? WHERE id=?");

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
const insImage = db.prepare("INSERT OR IGNORE INTO player_images (player_id, taken_at, file) VALUES (?,?,?)");
const photoCounts = { kept: 0, other_players: 0, undated: 0, wide_shot: 0 };

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
  else if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) photoCounts.undated++;
  else {
    insImage.run(pid, Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 1000, file);
    photoCounts.kept++;
  }
}

if (!existsSync(imagesFile)) console.warn(`  ${imagesFile} is missing: no player photo (run \`bun run data:fetch\`)`);

// Data Dragon -------------------------------------------------------------------
const DdragonData = z.object({
  version: z.string(),
  champion: z.object({
    data: z.record(z.string(), z.object({ id: z.string(), key: z.string(), name: z.string(), image: z.object({ full: z.string() }) })),
  }),
  item: z.object({ data: z.record(z.string(), z.looseObject({ name: z.string() })) }),
  runes: z.array(z.object({ name: z.string(), slots: z.array(z.object({ runes: z.array(z.object({ name: z.string(), icon: z.string() })) })) })),
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

const updChampion = db.prepare("UPDATE champions SET icon_url=? WHERE id=?");

for (const c of selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM champions")) {
  const d = championByName.get(normalizeAlias(c.name));
  updChampion.run(d ? `${cdn}/${dd.version}/img/champion/${d.image.full}` : null, c.id);
}

// Runes: tree and icon from Data Dragon, the tree of a retired rune from the lines. Stat shards have neither.
const ddRunes = new Map(dd.runes.flatMap((t) => t.slots.flatMap((s) => s.runes.map((r) => [normalizeAlias(r.name), { tree: t.name, icon: r.icon }] as const))));
const updRune = db.prepare("UPDATE runes SET tree=?, icon_url=? WHERE id=?");
const runeCounts = { ddragon: 0, tree_from_lines: 0, shard_or_unknown: 0 };

for (const r of selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM runes")) {
  const d = ddRunes.get(normalizeAlias(r.name));
  const voted = [...(treeVotes.get(r.name) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  updRune.run(d?.tree ?? voted, d ? `${cdn}/img/${d.icon}` : null, r.id);
  runeCounts[d ? "ddragon" : voted ? "tree_from_lines" : "shard_or_unknown"]++;
}

// Summoner spells: the Summoner's Rift entry when several modes share a name.
const ddSpells = new Map<string, string>();

for (const sp of Object.values(dd.summoner.data).sort((a, b) => Number(b.modes?.includes("CLASSIC") ?? false) - Number(a.modes?.includes("CLASSIC") ?? false)))
  if (!ddSpells.has(normalizeAlias(sp.name))) ddSpells.set(normalizeAlias(sp.name), sp.image.full);

const updSpell = db.prepare("UPDATE summoner_spells SET icon_url=? WHERE id=?");

for (const sp of selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM summoner_spells")) {
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

const insItemRow = db.prepare("INSERT INTO items (id, name, icon_url, kind) VALUES (?, ?, ?, ?)");
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
  selectAll(db, z.object({ id: z.number(), name: z.string() }), "SELECT id, name FROM champions").map((c) => [normalizeAlias(c.name), c.id]),
);

for (const c of Object.values(dd.champion.data)) {
  const id = championIdByName.get(normalizeAlias(c.name)) ?? championIdByName.get(normalizeAlias(c.id));

  if (id != null) championIdByKey.set(Number(c.key), id);
}

const insRiot = db.prepare("INSERT INTO game_riot (game_id, riot_key, stats_page, json_version, has_timeline, side_swapped) VALUES (?,?,?,?,?,?)");
const PLAYER_STATS = 36;
const insPlayerStats = db.prepare(`INSERT OR IGNORE INTO game_player_stats (game_id, player_id, gold_10, gold_15, gold_20, xp_10, xp_15, xp_20, cs_10, cs_15, cs_20, gold_diff_10, gold_diff_15, gold_diff_20, xp_diff_10, xp_diff_15, xp_diff_20, cs_diff_10, cs_diff_15, cs_diff_20, kills_10, deaths_10, assists_10, solo_kills, first_blood_kill, first_blood_assist, first_blood_victim, double_kills, triple_kills, quadra_kills, penta_kills, wards_placed, wards_killed, control_wards, plates, damage_taken) VALUES (${Array(PLAYER_STATS).fill("?").join(",")})`);
const insTeamStats = db.prepare(`INSERT OR IGNORE INTO game_team_stats (game_id, side, first_blood, first_tower, first_dragon, first_herald, first_baron, first_inhibitor, plates, gold_10, gold_15, gold_20, gold_diff_10, gold_diff_15, gold_diff_20, kills_10, kills_15, kills_20, towers_15, elder_dragons, dragon_soul, soul) VALUES (${Array(22).fill("?").join(",")})`);
const insDragon = db.prepare("INSERT INTO game_dragons (game_id, seq, team_seq, side, kind, time_s) VALUES (?,?,?,?,?,?)");
const ingameCounts = { games: 0, skipped_unknown_game: 0, skipped_mapping: 0, participants_by_position: 0, kills_mismatch: 0, missing: 0, invalid: 0, duplicates: 0, stale_derive: 0, older_derive: 0 };
const diff = (a: number | null, b: number | null | undefined) => (a == null || b == null ? null : a - b);
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

// Indexes and views -------------------------------------------------------------
createQuerySchema(db);

// Ingest metadata ---------------------------------------------------------------
const TABLES = SCHEMA_TABLES.filter((name) => name !== "ingest_runs");

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
  JSON.stringify({ derive_version: DERIVE_VERSION, ddragon_version: dd.version, skipped_games: skippedGames, skipped_lines: skippedLines, item_icons: itemIcons, item_kinds: kindCounts, rune_sources: runeCounts, odd_rune_pages: oddRunePages, ingame: ingameCounts, identity, player_images: photoCounts }),
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

console.log("item kinds:", kindCounts);

console.log("runes:", runeCounts);

console.log(`rune pages of an unexpected length, left out: ${oddRunePages}`);

console.log("in-game:", ingameCounts);

console.log("player links:", identity);

console.table(byLeague);
