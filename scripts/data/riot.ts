/**
 * Riot game JSON hosted by Leaguepedia: which games have one (Cargo
 * `PostgameJsonMetadata`), downloading them into the object store, and the
 * in-game summaries (data/raw/ingame.jsonl) that `data:build` turns into SQL.
 *
 * Resumable by construction:
 * - every downloaded game is one object in data/raw/riot, written atomically;
 * - every summary is one appended line of ingame.jsonl;
 * - a run skips games that already have a current summary, re-derives games
 *   whose raw JSON is cached, and only then goes to the wiki.
 * Stopping the process (Ctrl-C, timeout, budget) loses at most the game in flight.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { type CargoOptions, type CargoRow, cargoQuery, cargoStats, cargoString, wikiPages } from "../../src/lib/sources/leaguepedia";
import { RAW_GAME_CONTENT_TYPE, RAW_GAME_FORMAT, type RawGame, decodeRawGame, encodeRawGame, rawGameKey } from "../../src/lib/sources/riot";
import { FsStore, type ObjectStore } from "../../src/lib/storage";
import { DERIVE_VERSION, IngameLine, summarizeGame } from "./ingame";
import { INGAME_FILE, LEAGUES, RIOT_CACHE_DIR } from "./scope";

/** Retry pages the wiki did not have after this long. */
const MISSING_RETRY_DAYS = 30;

export const localRiotStore = () => new FsStore(RIOT_CACHE_DIR);

// --- Which games have Riot JSON -----------------------------------------------

const RIOT_FIELDS = [
  "P.RiotPlatformGameId=Key",
  "P.GameId=GameId",
  "P.StatsPage=StatsPage",
  "P.TimelinePage=TimelinePage",
  "P.RiotVersion=Version",
  "P.OverviewPage=Page",
];

export const RiotGameRow = z.object({
  Key: z.string().min(1),
  GameId: z.string().min(1),
  StatsPage: z.string().min(1),
  TimelinePage: z.string().nullable(),
  Version: z.number().int(),
  Page: z.string(),
  League: z.string(),
});

export type RiotGameRow = z.infer<typeof RiotGameRow>;

const text = (v: CargoRow[string] | undefined) => (v == null || v === "" ? null : String(v));

/** `PostgameJsonMetadata` rows of the scope, one query per league (paginated). */
export async function fetchRiotGameList(opts: CargoOptions): Promise<RiotGameRow[]> {
  const rows: RiotGameRow[] = [];
  let skipped = 0;

  for (const league of LEAGUES) {
    const raw = await cargoQuery(
      {
        tables: "PostgameJsonMetadata=P,Tournaments=T",
        joinOn: "P.OverviewPage=T.OverviewPage",
        fields: RIOT_FIELDS,
        where: `T.League=${cargoString(league.name)}`,
        orderBy: "P.GameId",
      },
      opts,
    );

    for (const r of raw) {
      const parsed = RiotGameRow.safeParse({
        Key: text(r.Key) ?? text(r.StatsPage)?.replace(/^V\d data:/, "").replace(/ /g, "_"),
        GameId: text(r.GameId),
        StatsPage: text(r.StatsPage),
        TimelinePage: text(r.TimelinePage),
        Version: Number(r.Version) || 0,
        Page: text(r.Page) ?? "",
        League: league.name,
      });

      if (parsed.success) rows.push(parsed.data);
      else skipped++;
    }
  }

  // A game listed twice keeps its first row.
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.Key) && seen.add(r.Key));

  if (skipped) console.log(`  riot: ${skipped} PostgameJsonMetadata rows without a key or stats page skipped`);

  return unique;
}

// --- Summaries file -----------------------------------------------------------

/** Latest line per game key. A truncated last line (interrupted append) is ignored. */
export function loadIngame(file = INGAME_FILE): Map<string, IngameLine> {
  const out = new Map<string, IngameLine>();

  if (!existsSync(file)) return out;
  let broken = 0;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed = IngameLine.parse(JSON.parse(line));
      out.set(parsed.key, parsed);
    } catch {
      broken++;
    }
  }

  if (broken) console.warn(`  ingame: ${broken} unreadable line(s) in ${file} ignored`);

  return out;
}

// --- Download -----------------------------------------------------------------

export type RiotFetchOptions = {
  /** Stop going to the wiki after this many minutes (null: no limit). Reads from R2 do not count. */
  budgetMinutes: number | null;
  /** The R2 store, when configured: read before the wiki, and written with each game downloaded from the wiki. */
  remote: ObjectStore | null;
  /** Recompute every summary from the raw JSON, even current ones. */
  rederive: boolean;
  /** Overrides for tests: the local cache, the summaries file and the wiki client. */
  local?: ObjectStore;
  ingameFile?: string;
  fetchPages?: typeof wikiPages;
};

export type RiotFetchCounts = {
  listed: number;
  current: number;
  /** Summaries computed from the raw JSON already in the local cache. */
  from_cache: number;
  /** Games read from R2 (no wiki request). */
  from_r2: number;
  /** Games downloaded from the wiki. */
  from_wiki: number;
  missing: number;
  invalid: number;
  r2_errors: number;
  uploaded: number;
  upload_errors: number;
  left: number;
};

const recent = (iso: string) => Date.now() - Date.parse(iso) < MISSING_RETRY_DAYS * 86400_000;

/** Parallel reads from R2: no wiki involved, so no throttle; enough to hide the latency, few enough to stay polite. */
const R2_CONCURRENCY = 16;

type Summaries = { file: string; index: Map<string, IngameLine> };

function append(line: IngameLine, summaries: Summaries) {
  appendFileSync(summaries.file, `${JSON.stringify(line)}\n`);
  summaries.index.set(line.key, line);
}

function summarize(raw: RawGame, summaries: Summaries, counts: RiotFetchCounts) {
  try {
    append(summarizeGame(raw), summaries);

    return true;
  } catch (err) {
    counts.invalid++;
    append(
      { status: "invalid", key: raw.key, gameId: raw.gameId, checkedAt: new Date().toISOString(), reason: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      summaries,
    );

    return false;
  }
}

/** A stored object, or null when it is absent or unreadable (then downloaded again). */
function readRaw(body: Uint8Array | null): RawGame | null {
  if (!body) return null;

  try {
    return decodeRawGame(body);
  } catch {
    return null;
  }
}

/** Games per wiki request: the MediaWiki API serves several pages at once, which halves the request count. */
const GAMES_PER_REQUEST = Math.min(4, Math.max(1, Number(process.env.RIOT_GAMES_PER_REQUEST || 2)));

const OUTAGE_PAUSE_MS = 5 * 60_000;
const MAX_OUTAGE_PAUSES = 6;

type Downloaded = { row: RiotGameRow; result: RawGame | { missing: string } | { invalid: string } | null };

/** Stats + timeline pages of a few games in one request; `null` for a game the wiki did not serve this time. */
async function download(rows: RiotGameRow[], fetchPages: typeof wikiPages): Promise<Downloaded[]> {
  const titles = rows.flatMap((r) => [r.StatsPage, ...(r.TimelinePage ? [r.TimelinePage] : [])]);
  const pages = await fetchPages(titles);

  return rows.map((row): Downloaded => {
    const stats = pages.get(row.StatsPage);
    const tl = row.TimelinePage ? pages.get(row.TimelinePage) : undefined;

    if (!stats || (row.TimelinePage && !tl)) return { row, result: null };

    if ("missing" in stats) return { row, result: { missing: `no page ${row.StatsPage}` } };
    const timeline = tl && !("missing" in tl) ? tl : null;

    try {
      const parse = (s: string) => z.json().parse(JSON.parse(s));

      return {
        row,
        result: {
          format: RAW_GAME_FORMAT,
          key: row.Key,
          gameId: row.GameId,
          version: row.Version,
          statsPage: row.StatsPage,
          timelinePage: timeline?.title ?? null,
          statsRevid: stats.revid,
          timelineRevid: timeline?.revid ?? null,
          fetchedAt: new Date().toISOString(),
          stats: parse(stats.content),
          timeline: timeline ? parse(timeline.content) : null,
        },
      };
    } catch (err) {
      return { row, result: { invalid: `unreadable JSON: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` } };
    }
  });
}

/** Reads the games of `todo` from R2, in parallel. Returns the ones R2 does not have, in their original order. */
async function readFromR2(todo: RiotGameRow[], remote: ObjectStore, local: ObjectStore, summaries: Summaries, counts: RiotFetchCounts): Promise<RiotGameRow[]> {
  const queue = [...todo];
  const absent = new Set<string>();
  const started = Date.now();
  let seen = 0;

  async function worker() {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const key = rawGameKey(row.Key);
      let body: Uint8Array | null = null;

      try {
        body = await remote.get(key);
      } catch (err) {
        counts.r2_errors++;

        if (counts.r2_errors <= 5) console.warn(`  riot: R2 read of ${key} failed (${err instanceof Error ? err.message : String(err)}), falling back to the wiki`);
      }

      const raw = readRaw(body);

      if (body && raw) {
        await local.put(key, body, RAW_GAME_CONTENT_TYPE);

        if (summarize(raw, summaries, counts)) counts.from_r2++;
      } else absent.add(row.Key);

      if (++seen % 2000 === 0) console.log(`  riot R2 ${seen}/${todo.length} · ${counts.from_r2} read · ${((Date.now() - started) / 60_000).toFixed(1)} min`);
    }
  }

  await Promise.all(Array.from({ length: R2_CONCURRENCY }, worker));
  console.log(
    `riot: ${counts.from_r2} games read from ${remote.label} in ${((Date.now() - started) / 60_000).toFixed(1)} min, ${absent.size} not there` +
      (counts.r2_errors ? `, ${counts.r2_errors} read errors` : ""),
  );

  return todo.filter((r) => absent.has(r.Key));
}

/**
 * Brings ingame.jsonl up to date with `rows`: cached raw JSON first (no
 * network), then R2 when configured (parallel, before the wiki budget starts),
 * then the wiki, a few games per request, until done or out of budget.
 */
export async function fetchRiotGames(rows: RiotGameRow[], opts: RiotFetchOptions): Promise<RiotFetchCounts> {
  const local = opts.local ?? localRiotStore();
  const fetchPages = opts.fetchPages ?? wikiPages;
  const file = opts.ingameFile ?? INGAME_FILE;
  const summaries: Summaries = { file, index: loadIngame(file) };
  const index = summaries.index;

  const counts: RiotFetchCounts = {
    listed: rows.length, current: 0, from_cache: 0, from_r2: 0, from_wiki: 0, missing: 0, invalid: 0, r2_errors: 0, uploaded: 0, upload_errors: 0, left: 0,
  };

  const cached = new Set(await local.list("games"));
  let todo: RiotGameRow[] = [];

  // 1. No network: current summaries, and raw JSON already in the local cache.
  for (const row of rows) {
    const line = index.get(row.Key);

    if (line?.status === "ok" && line.derive === DERIVE_VERSION && !opts.rederive) {
      counts.current++;
      continue;
    }

    const key = rawGameKey(row.Key);

    if (cached.has(key)) {
      const raw = readRaw(await local.get(key));

      if (raw) {
        if (summarize(raw, summaries, counts)) counts.from_cache++;
        continue;
      }
    }

    if (line && line.status !== "ok" && recent(line.checkedAt)) {
      counts[line.status]++;
      continue;
    }

    todo.push(row);
  }

  console.log(
    `riot: ${rows.length} games with Riot JSON in scope, ${counts.current} up to date, ${counts.from_cache} derived from the local cache, ` +
      `${todo.length} to fetch${opts.remote ? ` (${opts.remote.label} first)` : ""}`,
  );

  // 2. R2: parallel reads, no wiki request, outside the wiki budget.
  if (opts.remote && todo.length) todo = await readFromR2(todo, opts.remote, local, summaries, counts);

  // 3. The wiki, throttled and time-boxed.
  if (todo.length) console.log(`riot: ${todo.length} games to download from the wiki (${GAMES_PER_REQUEST} per request)`);

  const deadline = opts.budgetMinutes == null ? Infinity : Date.now() + opts.budgetMinutes * 60_000;
  const started = Date.now();
  const total = todo.length;
  const retried = new Set<string>();
  let done = 0;
  let lastLog = 0;
  let failures = 0;

  /** Caches the game locally and uploads it; false when the upload failed (the game is then left for the next run). */
  const store = async (raw: RawGame, body: Uint8Array): Promise<boolean> => {
    const key = rawGameKey(raw.key);
    await local.put(key, body, RAW_GAME_CONTENT_TYPE);

    if (!opts.remote) return true;

    try {
      await opts.remote.put(key, body, RAW_GAME_CONTENT_TYPE);
      counts.uploaded++;

      return true;
    } catch (err) {
      counts.upload_errors++;
      console.warn(
        `  riot: upload of ${key} failed (${err instanceof Error ? err.message : String(err)}), left for the next run ` +
          "(on a machine that keeps data/raw/riot, `bun run data:sync` uploads it)",
      );

      return false;
    }
  };

  while (todo.length) {
    if (Date.now() > deadline) {
      counts.left += todo.length;
      console.log(`riot: time budget reached, ${todo.length} games left for the next run`);
      break;
    }

    const batch = todo.splice(0, GAMES_PER_REQUEST);
    let downloaded: Downloaded[];

    try {
      downloaded = await download(batch, fetchPages);
      failures = 0;
    } catch (err) {
      // The wiki is down or refusing us: pause, then try again; give up after a long outage.
      todo.unshift(...batch);

      if (++failures >= MAX_OUTAGE_PAUSES) throw err;
      console.warn(`  riot: ${err instanceof Error ? err.message : String(err)}; pausing ${OUTAGE_PAUSE_MS / 60_000} min (${failures}/${MAX_OUTAGE_PAUSES})`);
      await new Promise((r) => setTimeout(r, OUTAGE_PAUSE_MS));
      continue;
    }

    for (const { row, result } of downloaded) {
      if (result === null) {
        // Not served (API size limit): once more on its own, then give up for this run.
        if (retried.has(row.Key)) counts.left++;
        else {
          retried.add(row.Key);
          todo.unshift(row);
        }

        continue;
      }

      done++;

      if ("missing" in result || "invalid" in result) {
        const status = "missing" in result ? "missing" : "invalid";
        counts[status]++;
        append({ status, key: row.Key, gameId: row.GameId, checkedAt: new Date().toISOString(), reason: "missing" in result ? result.missing : result.invalid }, summaries);
        continue;
      }

      // No summary without the object on R2: an `ok` line would make every later run skip the game.
      if (!(await store(result, encodeRawGame(result)))) {
        counts.left++;
        continue;
      }

      counts.from_wiki++;
      summarize(result, summaries, counts);
    }

    if (done - lastLog >= 100 || !todo.length) {
      lastLog = done;
      const perGame = (Date.now() - started) / Math.max(1, done);
      const eta = (todo.length * perGame) / 3_600_000;
      console.log(
        `  riot wiki ${done}/${total} (${batch[0].League}) · ${counts.from_wiki} downloaded, ${counts.missing} missing, ${counts.invalid} invalid · ` +
          `${(perGame / 1000).toFixed(2)} s/game, about ${eta.toFixed(1)} h left · ${cargoStats.requests} requests · ${new Date().toISOString().slice(11, 16)} UTC`,
      );
    }
  }

  console.log(
    `riot: done · ${counts.current} up to date, ${counts.from_cache} from the local cache, ${counts.from_r2} from R2, ${counts.from_wiki} from the wiki ` +
      `(${counts.missing} missing, ${counts.invalid} invalid, ${counts.left} left for the next run)`,
  );

  return counts;
}
