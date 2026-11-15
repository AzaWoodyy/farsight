/**
 * data:fetch: Leaguepedia Cargo + Riot Data Dragon into the raw cache (data/raw).
 *
 *   bun run data:fetch                     full scope, reuses cached responses
 *   bun run data:fetch --refresh           full scope, ignores the cache (monthly rebuild)
 *   bun run data:fetch --incremental       only recent or ongoing tournaments
 *   bun run data:fetch --incremental --days=30
 *   bun run data:fetch --riot-budget=90    stop downloading Riot JSON after 90 min
 *   bun run data:fetch --no-riot           Cargo and Data Dragon only
 *   bun run data:fetch --rederive          recompute every in-game summary from the cached Riot JSON
 *
 * Riot game JSON (stats + timeline, one wiki request per game) is downloaded
 * for every game listed in `PostgameJsonMetadata` that has no summary yet:
 * read from R2 first when R2_* is set (parallel, outside --riot-budget), else
 * downloaded from the wiki and uploaded to R2; cached as one object per game
 * under data/raw/riot, summarized into data/raw/ingame.jsonl. The first catch-up is
 * about 15 000 games (8-9 h at 2 s per request) and resumes where it stopped.
 *
 * Leaguepedia is queried one request at a time, ≥ 2 s apart, with backoff, by
 * league with 5000-row pages. Every raw response is kept under data/raw/cargo,
 * and the merged datasets under data/raw/*.json feed `data:build`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../src/lib/fs-atomic";
import { type Json, JsonSchema } from "../../src/lib/json";
import { ItemMeta, itemMeta } from "../../src/lib/domain/items";
import { DDRAGON_BASE } from "../../src/lib/sources/ddragon";
import {
  type CargoOptions,
  type CargoQuery,
  type CargoRow,
  type CargoValue,
  StoredCargoRow,
  cargoIn,
  cargoQuery,
  cargoStats,
  cargoString,
} from "../../src/lib/sources/leaguepedia";
import { remoteStoreFromEnv } from "../../src/lib/storage";
import { fetchRiotGameList, fetchRiotGames } from "./riot";
import {
  CARGO_CACHE_DIR,
  DDRAGON_CACHE_DIR,
  type Dataset,
  IngestRun,
  LEAGUES,
  RAW_DIR,
  classifyTournament,
  datasetFile,
} from "./scope";

const args = process.argv.slice(2);
const incremental = args.includes("--incremental");
const refresh = args.includes("--refresh");
const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7) ?? 14);
const noRiot = args.includes("--no-riot");
const rederive = args.includes("--rederive");
const budgetArg = args.find((a) => a.startsWith("--riot-budget="))?.slice(14);
const riotBudget = budgetArg ? Number(budgetArg) : null;

const startedAt = new Date();
const cached: CargoOptions = { cacheDir: CARGO_CACHE_DIR, refresh };
const fresh: CargoOptions = { cacheDir: CARGO_CACHE_DIR, refresh: true };
const elapsed = () => `${((Date.now() - startedAt.getTime()) / 60000).toFixed(1)} min`;
const progress = () => `${cargoStats.requests} requests, ${cargoStats.cached} cached, ${elapsed()}`;

if (riotBudget != null && !(riotBudget > 0)) throw new Error("--riot-budget expects a number of minutes");

const chunks = <T>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

// --- Cargo queries ------------------------------------------------------------

const TOURNAMENT_FIELDS = [
  "Tournaments.OverviewPage=Page",
  "Tournaments.Name=Name",
  "Tournaments.League=League",
  "Tournaments.Year=Year",
  "Tournaments.DateStart=DateStart",
  "Tournaments.Date=DateEnd",
  "Tournaments.Region=Region",
  "Tournaments.Split=Split",
  "Tournaments.IsQualifier=IsQualifier",
  "Tournaments.IsPlayoffs=IsPlayoffs",
  "Tournaments.TournamentLevel=Level",
];

const RESULT_FIELDS = [
  "TR.OverviewPage=Page",
  "TR.Team=Team",
  "TR.Place=Place",
  "TR.Place_Number=PlaceNumber",
  "TR.Prize_USD=PrizeUSD",
];

const GAME_FIELDS = [
  "SG.GameId=GameId", "SG.OverviewPage=Page", "SG.Team1=Team1", "SG.Team2=Team2", "SG.Winner=Winner",
  "SG.Gamelength=Len", "SG.Patch=Patch", "SG.DateTime_UTC=Date",
  "SG.Team1Bans=B1", "SG.Team2Bans=B2", "SG.Team1Picks=P1", "SG.Team2Picks=P2",
  "SG.Team1Dragons=D1", "SG.Team2Dragons=D2", "SG.Team1Barons=Ba1", "SG.Team2Barons=Ba2",
  "SG.Team1Towers=To1", "SG.Team2Towers=To2", "SG.Team1Gold=G1", "SG.Team2Gold=G2",
  "SG.Team1Kills=K1", "SG.Team2Kills=K2", "SG.Team1RiftHeralds=H1", "SG.Team2RiftHeralds=H2",
  "SG.Team1VoidGrubs=V1", "SG.Team2VoidGrubs=V2", "SG.Team1Atakhans=A1", "SG.Team2Atakhans=A2",
  "SG.Team1Inhibitors=I1", "SG.Team2Inhibitors=I2",
];

const LINE_FIELDS = [
  "SP.GameId=GameId", "SP.OverviewPage=Page", "SP.Link=Link", "SP.Name=Name", "SP.Champion=Champion",
  "SP.Role=Role", "SP.Team=Team", "SP.Side=Side", "SP.PlayerWin=Win",
  "SP.Kills=K", "SP.Deaths=D", "SP.Assists=A", "SP.Gold=Gold", "SP.CS=CS",
  "SP.DamageToChampions=Dmg", "SP.VisionScore=Vision", "SP.Items=Items", "SP.Trinket=Trinket",
  "SP.KeystoneRune=Keystone", "SP.PrimaryTree=Primary", "SP.SecondaryTree=Secondary",
  "SP.Runes=Runes", "SP.SummonerSpells=Spells",
];

const leagueIn = (field: string) => cargoIn(field, LEAGUES.map((l) => l.name));

const tournamentsQuery: CargoQuery = {
  tables: "Tournaments",
  fields: TOURNAMENT_FIELDS,
  where: leagueIn("Tournaments.League"),
  orderBy: "Tournaments.OverviewPage",
};

function gamesQuery(where: string, joinTournaments: boolean): CargoQuery {
  return {
    tables: joinTournaments ? "ScoreboardGames=SG,Tournaments=T" : "ScoreboardGames=SG",
    joinOn: joinTournaments ? "SG.OverviewPage=T.OverviewPage" : undefined,
    fields: GAME_FIELDS,
    where,
    orderBy: "SG.GameId",
  };
}

function linesQuery(where: string, joinTournaments: boolean): CargoQuery {
  return {
    tables: joinTournaments ? "ScoreboardPlayers=SP,Tournaments=T" : "ScoreboardPlayers=SP",
    joinOn: joinTournaments ? "SP.OverviewPage=T.OverviewPage" : undefined,
    fields: LINE_FIELDS,
    where,
    orderBy: "SP.GameId,SP.Link",
  };
}

/**
 * The player rows and redirects behind scoreboard links. A link is what the
 * scoreboard says, not always a player page: an older handle ("ZionSpartan"
 * for Darshan) only exists as a `PlayerRedirects.AllName`, so links are
 * resolved by name first, then the pages they lead to are fetched with the
 * links themselves. `data:build` merges on these rows (scripts/data/identity.ts).
 */
async function fetchPlayers(links: string[], opts: CargoOptions) {
  const players: CargoRow[] = [];
  const redirects: CargoRow[] = [];
  const resolved = new Set<string>();

  for (const batch of chunks(links, 150)) {
    const rows = await cargoQuery(
      {
        tables: "PlayerRedirects",
        fields: ["PlayerRedirects.AllName=AllName", "PlayerRedirects.OverviewPage=Page"],
        where: cargoIn("PlayerRedirects.AllName", batch),
      },
      opts,
    );

    for (const r of rows) resolved.add(String(r.Page));
  }

  // Links first: their batches (and cached responses) stay the same when a page is added.
  const known = new Set(links);
  const pages = [...links, ...[...resolved].filter((p) => !known.has(p))];
  console.log(`  players: ${links.length} links, ${pages.length - links.length} more pages found by name (${progress()})`);

  for (const [i, batch] of chunks(pages, 150).entries()) {
    players.push(
      ...(await cargoQuery(
        {
          tables: "Players",
          fields: [
            "Players.OverviewPage=Page", "Players.ID=ID", "Players.Name=Name",
            "Players.NativeName=NativeName", "Players.Country=Country",
            "Players.Role=Role", "Players.Team=Team",
          ],
          where: cargoIn("Players.OverviewPage", batch),
        },
        opts,
      )),
    );
    redirects.push(
      ...(await cargoQuery(
        {
          tables: "PlayerRedirects",
          fields: ["PlayerRedirects.AllName=AllName", "PlayerRedirects.OverviewPage=Page"],
          where: cargoIn("PlayerRedirects.OverviewPage", batch),
        },
        opts,
      )),
    );

    if (i % 10 === 9) console.log(`  players ${(i + 1) * 150}/${pages.length} (${progress()})`);
  }

  return { players, redirects };
}

const linkOf = (l: CargoRow) => String(l.Link ?? l.Name ?? "");
const asText = (v: CargoValue | undefined) => (v == null || v === "" ? null : String(v));

// --- Data Dragon --------------------------------------------------------------

async function ddragon(path: string, force: boolean): Promise<Json> {
  mkdirSync(DDRAGON_CACHE_DIR, { recursive: true });
  const file = resolve(DDRAGON_CACHE_DIR, `${createHash("sha1").update(path).digest("hex").slice(0, 20)}.json`);

  if (!force && existsSync(file)) {
    try {
      return JsonSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      console.warn(`  ddragon: unreadable cache file ${basename(file)}, fetching again`);
    }
  }

  const res = await fetch(`${DDRAGON_BASE}${path}`, { signal: AbortSignal.timeout(60_000) });

  if (!res.ok) throw new Error(`Data Dragon ${res.status}: ${path}`);
  const text = await res.text();
  const value = JsonSchema.parse(JSON.parse(text));
  writeFileAtomic(file, text);

  return value;
}

const ItemFile = z.object({ data: z.record(z.string(), z.looseObject({ name: z.string() })) });

/**
 * Latest champion/item/rune/spell data, plus item names and recipes from older
 * patches so retired items still get their original icon and kind. Three patches per season
 * (first, middle, last) are enough to catch nearly every retired item.
 */
async function fetchDdragon(force: boolean) {
  const versions = z.array(z.string()).parse(await ddragon("/api/versions.json", true)).filter((v) =>
    /^\d+\.\d+\.\d+$/.test(v),
  );

  const version = versions[0];
  const cdn = (f: string) => ddragon(`/cdn/${version}/data/en_US/${f}`, force);
  const bySeason = new Map<string, string[]>();

  for (const v of versions) {
    const major = v.split(".")[0];
    bySeason.set(major, [...(bySeason.get(major) ?? []), v]);
  }

  const legacyVersions = [...bySeason.values()]
    .flatMap((vs) => [...new Set([vs[0], vs[Math.floor(vs.length / 2)], vs[vs.length - 1]])])
    .filter((v) => v !== version);

  const legacyItems: { version: string; items: Record<string, string>; meta: Record<string, ItemMeta> }[] = [];

  for (const v of legacyVersions) {
    try {
      const file = ItemFile.parse(await ddragon(`/cdn/${v}/data/en_US/item.json`, false));
      legacyItems.push({
        version: v,
        items: Object.fromEntries(Object.entries(file.data).map(([id, it]) => [id, it.name])),
        // Recipe, tags and price: data:build classifies retired items (completed, component, consumable...).
        // An entry that does not parse only loses its kind, never its name and icon.
        meta: Object.fromEntries(Object.entries(file.data).flatMap(([id, it]) => {
          const meta = ItemMeta.safeParse(it);

          return meta.success ? [[id, itemMeta(meta.data)]] : [];
        })),
      });
    } catch (err) {
      console.warn(`  ddragon: skipped ${v} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return {
    version,
    champion: await cdn("champion.json"),
    item: await cdn("item.json"),
    runes: await cdn("runesReforged.json"),
    summoner: await cdn("summoner.json"),
    legacyItems,
  };
}

// --- Datasets -----------------------------------------------------------------

function load(name: Dataset): CargoRow[] {
  const file = datasetFile(name);

  if (!existsSync(file)) throw new Error(`${file} is missing: run a full \`bun run data:fetch\` first.`);

  return z.array(StoredCargoRow).parse(JSON.parse(readFileSync(file, "utf8")));
}

function save(name: Dataset, value: Json) {
  writeFileAtomic(datasetFile(name), JSON.stringify(value));
}

/** Replace the rows of the refreshed pages, keep everything else. */
function merge(previous: CargoRow[], next: CargoRow[], pages: Set<string>) {
  return [...previous.filter((r) => !pages.has(String(r.Page))), ...next];
}

// --- Riot game JSON -----------------------------------------------------------

/** The list of games with Riot JSON (refreshed in incremental mode), then the downloads. */
async function riot(opts: CargoOptions) {
  if (noRiot) return {};
  const list = await fetchRiotGameList(opts);
  save("riot_games", list);
  const remote = remoteStoreFromEnv();
  console.log(`riot: raw JSON cached locally${remote ? `, read from and uploaded to ${remote.label}` : " (R2 not configured: wiki only, no upload)"}`);
  const counts = await fetchRiotGames(list, { budgetMinutes: riotBudget, remote, rederive });

  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [`riot_${k}`, v]));
}

// --- Modes --------------------------------------------------------------------

async function full() {
  console.log(`full fetch${refresh ? " (refresh: cache ignored)" : ""}`);
  const tournaments = await cargoQuery(tournamentsQuery, cached);
  console.log(`tournaments: ${tournaments.length}`);

  const results = await cargoQuery(
    {
      tables: "TournamentResults=TR,Tournaments=T",
      joinOn: "TR.OverviewPage=T.OverviewPage",
      fields: RESULT_FIELDS,
      where: leagueIn("T.League"),
      orderBy: "TR.OverviewPage,TR.Team",
    },
    cached,
  );

  console.log(`results: ${results.length}`);

  const games: CargoRow[] = [];
  const lines: CargoRow[] = [];

  for (const league of LEAGUES) {
    const where = `T.League=${cargoString(league.name)}`;
    const g = await cargoQuery(gamesQuery(where, true), cached);
    const l = await cargoQuery(linesQuery(where, true), cached);
    games.push(...g);
    lines.push(...l);
    console.log(`${league.name}: ${g.length} games, ${l.length} player lines (${progress()})`);
  }

  const links = [...new Set(lines.flatMap((l) => linkOf(l) || []))];
  const { players, redirects } = await fetchPlayers(links, cached);
  console.log(`players: ${players.length}, redirects: ${redirects.length}`);

  const dd = await fetchDdragon(refresh);
  console.log(`ddragon: ${dd.version} (+${dd.legacyItems.length} older patches for retired items)`);

  save("tournaments", tournaments);
  save("results", results);
  save("games", games);
  save("lines", lines);
  save("players", players);
  save("redirects", redirects);
  save("ddragon", dd);

  const riotCounts = await riot(cached);

  return {
    ...riotCounts,
    tournaments: tournaments.length,
    results: results.length,
    games: games.length,
    lines: lines.length,
    players: players.length,
    redirects: redirects.length,
  };
}

async function incrementalFetch() {
  const today = startedAt.toISOString().slice(0, 10);
  const cutoff = new Date(startedAt.getTime() - days * 86400_000).toISOString().slice(0, 10);
  console.log(`incremental fetch: tournaments running between ${cutoff} and ${today}`);

  const previous = {
    results: load("results"),
    games: load("games"),
    lines: load("lines"),
    players: load("players"),
    redirects: load("redirects"),
  };

  // The tournament list is one request: always refresh it.
  const tournaments = await cargoQuery(tournamentsQuery, fresh);
  const leagueByName = new Map<string, (typeof LEAGUES)[number]>(LEAGUES.map((l) => [l.name, l]));
  const recent: string[] = [];
  const eventPages = new Set<string>();

  for (const t of tournaments) {
    const league = leagueByName.get(String(t.League));
    const kind = league && classifyTournament(String(t.Page), league);
    const start = asText(t.DateStart) ?? asText(t.DateEnd);
    const end = asText(t.DateEnd) ?? today;

    if (!kind || !start || start > today || end < cutoff) continue;
    recent.push(String(t.Page));
    eventPages.add(kind.eventPage);
  }

  console.log(`recent or ongoing: ${recent.length}\n  ${recent.join("\n  ")}`);

  const pages = new Set(recent);
  const standingPages = new Set([...recent, ...eventPages]);
  const results: CargoRow[] = [];
  const games: CargoRow[] = [];
  const lines: CargoRow[] = [];

  for (const batch of chunks([...standingPages], 40)) {
    results.push(
      ...(await cargoQuery(
        {
          tables: "TournamentResults=TR",
          fields: RESULT_FIELDS,
          where: cargoIn("TR.OverviewPage", batch),
          orderBy: "TR.OverviewPage,TR.Team",
        },
        fresh,
      )),
    );
  }

  for (const batch of chunks(recent, 40)) {
    games.push(...(await cargoQuery(gamesQuery(cargoIn("SG.OverviewPage", batch), false), fresh)));
    lines.push(...(await cargoQuery(linesQuery(cargoIn("SP.OverviewPage", batch), false), fresh)));
  }

  console.log(`refetched: ${results.length} standings, ${games.length} games, ${lines.length} player lines`);

  // Links to look up: spellings never seen before, and older links that no
  // player page or redirect name covers (fetched before links were resolved by name).
  const known = new Set(previous.players.map((p) => String(p.Page)));
  const lineLinks = new Set(previous.lines.map(linkOf));

  const covered = new Set([
    ...previous.players.map((p) => String(p.Page).toLowerCase()),
    ...previous.redirects.map((r) => String(r.AllName).toLowerCase()),
  ]);

  const newLinks = [...new Set([
    ...lines.flatMap((line) => {
      const l = linkOf(line);

      return l && !known.has(l) && !lineLinks.has(l) ? [l] : [];
    }),
    ...[...lineLinks].filter((l) => l && !covered.has(l.toLowerCase())),
  ])];

  const { players, redirects } = await fetchPlayers(newLinks, fresh);
  console.log(`new players: ${newLinks.length} (${players.length} with a Players row)`);

  const dd = await fetchDdragon(false);

  const merged = {
    tournaments,
    results: merge(previous.results, results, standingPages),
    games: merge(previous.games, games, pages),
    lines: merge(previous.lines, lines, pages),
    players: [...previous.players, ...players],
    redirects: [...previous.redirects, ...redirects],
  };

  for (const name of ["tournaments", "results", "games", "lines", "players", "redirects"] as const) save(name, merged[name]);
  save("ddragon", dd);

  const riotCounts = await riot(fresh);

  return {
    ...riotCounts,
    refreshed_tournaments: recent.length,
    results: results.length,
    games: games.length,
    lines: lines.length,
    new_players: newLinks.length,
    total_games: merged.games.length,
  };
}

mkdirSync(RAW_DIR, { recursive: true });

const counts = incremental ? await incrementalFetch() : await full();

const runsFile = datasetFile("runs");
const runs = existsSync(runsFile) ? z.array(IngestRun).parse(JSON.parse(readFileSync(runsFile, "utf8"))) : [];

runs.push({
  kind: incremental ? "fetch_incremental" : refresh ? "fetch_refresh" : "fetch_full",
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  requests: cargoStats.requests,
  cached_responses: cargoStats.cached,
  row_counts: counts,
});

save("runs", runs);

console.log(`done in ${elapsed()}: ${cargoStats.requests} Leaguepedia requests, ${cargoStats.cached} from cache`);
