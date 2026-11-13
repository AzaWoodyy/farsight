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

function append(line: IngameLine, index: Map<string, IngameLine>) {
  appendFileSync(INGAME_FILE, `${JSON.stringify(line)}\n`);
  index.set(line.key, line);
}

// --- Download -----------------------------------------------------------------

export type RiotFetchOptions = {
  /** Stop going to the wiki after this many minutes (null: no limit). */
  budgetMinutes: number | null;
  /** Also write each new raw game to this store (R2), when configured. */
  remote: ObjectStore | null;
  /** Recompute every summary from the raw JSON, even current ones. */
  rederive: boolean;
};

export type RiotFetchCounts = {
  listed: number;
  current: number;
  derived: number;
  downloaded: number;
  missing: number;
  invalid: number;
  uploaded: number;
  upload_errors: number;
  left: number;
};

const recent = (iso: string) => Date.now() - Date.parse(iso) < MISSING_RETRY_DAYS * 86400_000;

function summarize(raw: RawGame, index: Map<string, IngameLine>, counts: RiotFetchCounts) {
  try {
    append(summarizeGame(raw), index);

    return true;
  } catch (err) {
    counts.invalid++;
    append(
      { status: "invalid", key: raw.key, gameId: raw.gameId, checkedAt: new Date().toISOString(), reason: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      index,
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
async function download(rows: RiotGameRow[]): Promise<Downloaded[]> {
  const titles = rows.flatMap((r) => [r.StatsPage, ...(r.TimelinePage ? [r.TimelinePage] : [])]);
  const pages = await wikiPages(titles);

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

/**
 * Brings ingame.jsonl up to date with `rows`: cached raw JSON first (no
 * network), then R2 when configured, then the wiki, a few games per request,
 * until done or out of budget.
 */
export async function fetchRiotGames(rows: RiotGameRow[], opts: RiotFetchOptions): Promise<RiotFetchCounts> {
  const local = localRiotStore();
  const index = loadIngame();
  const counts: RiotFetchCounts = { listed: rows.length, current: 0, derived: 0, downloaded: 0, missing: 0, invalid: 0, uploaded: 0, upload_errors: 0, left: 0 };
  const deadline = opts.budgetMinutes == null ? Infinity : Date.now() + opts.budgetMinutes * 60_000;
  const cached = new Set(await local.list("games"));
  const todo: RiotGameRow[] = [];

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
        if (summarize(raw, index, counts)) counts.derived++;
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
    `riot: ${rows.length} games with Riot JSON in scope, ${counts.current} up to date, ${counts.derived} derived from the cache, ` +
      `${todo.length} to download (${GAMES_PER_REQUEST} per request)`,
  );

  // 2. R2, then the wiki.
  const started = Date.now();
  const total = todo.length;
  const retried = new Set<string>();
  let done = 0;
  let lastLog = 0;
  let failures = 0;

  const store = async (raw: RawGame, body: Uint8Array) => {
    const key = rawGameKey(raw.key);
    await local.put(key, body, RAW_GAME_CONTENT_TYPE);

    if (!opts.remote) return;

    try {
      await opts.remote.put(key, body, RAW_GAME_CONTENT_TYPE);
      counts.uploaded++;
    } catch (err) {
      counts.upload_errors++;
      console.warn(`  riot: upload of ${key} failed (${err instanceof Error ? err.message : String(err)}), \`bun run data:sync\` will retry`);
    }
  };

  while (todo.length) {
    if (Date.now() > deadline) {
      counts.left = todo.length;
      console.log(`riot: time budget reached, ${counts.left} games left for the next run`);
      break;
    }

    const batch: RiotGameRow[] = [];

    while (todo.length && batch.length < GAMES_PER_REQUEST) {
      const row = todo.shift()!;
      const remote = opts.remote ? readRaw(await opts.remote.get(rawGameKey(row.Key)).catch(() => null)) : null;

      if (remote) {
        await local.put(rawGameKey(row.Key), encodeRawGame(remote), RAW_GAME_CONTENT_TYPE);

        if (summarize(remote, index, counts)) counts.derived++;
        done++;
      } else batch.push(row);
    }

    if (!batch.length) continue;

    let downloaded: Downloaded[];

    try {
      downloaded = await download(batch);
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
        append({ status, key: row.Key, gameId: row.GameId, checkedAt: new Date().toISOString(), reason: "missing" in result ? result.missing : result.invalid }, index);
        continue;
      }

      await store(result, encodeRawGame(result));
      counts.downloaded++;
      summarize(result, index, counts);
    }

    if (done - lastLog >= 100 || !todo.length) {
      lastLog = done;
      const perGame = (Date.now() - started) / Math.max(1, done);
      const eta = (todo.length * perGame) / 3_600_000;
      console.log(
        `  riot ${done}/${total} (${batch[0].League}) · ${counts.downloaded} downloaded, ${counts.missing} missing, ${counts.invalid} invalid · ` +
          `${(perGame / 1000).toFixed(2)} s/game, about ${eta.toFixed(1)} h left · ${cargoStats.requests} requests · ${new Date().toISOString().slice(11, 16)} UTC`,
      );
    }
  }

  return counts;
}
