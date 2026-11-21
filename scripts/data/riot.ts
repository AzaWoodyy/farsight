/**
 * Riot game JSON hosted by Leaguepedia: which games have one (Cargo
 * `PostgameJsonMetadata`), downloading them into the object store, and the
 * in-game summaries (data/raw/ingame.jsonl) that `data:build` turns into SQL.
 *
 * Resumable by construction:
 * - every downloaded game is one object in data/raw/riot, written atomically;
 * - every summary is one appended line of ingame.jsonl;
 * - a run skips games that already have a current summary, re-derives games
 *   whose raw JSON is cached, and only then goes to the wiki;
 * - with R2, the summaries are one object beside the raw games, read before a
 *   run and written back after it, so a machine without data/raw starts from
 *   the last run's summaries.
 * Stopping the process (Ctrl-C, timeout, budget) loses at most the game in flight.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
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

// --- Summaries in R2 ----------------------------------------------------------

/** Every summary in one zstd object, beside the raw games it is computed from. */
export const SUMMARIES_KEY = "derived/ingame.jsonl.zst";

const SUMMARIES_CONTENT_TYPE = "application/zstd";

const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

const LineHead = z.object({ key: z.string(), status: z.string(), derive: z.number().optional() });

/**
 * Latest line per game, as written: the text and whether it is a current
 * summary. Read without the schema (`loadIngame` checks a line when it is
 * used), because parsing 40 000 summaries twice more costs gigabytes.
 */
function latestLines(text: string): Map<string, { raw: string; current: boolean }> {
  const out = new Map<string, { raw: string; current: boolean }>();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;

    try {
      const line = LineHead.parse(JSON.parse(raw));
      out.set(line.key, { raw, current: line.status === "ok" && line.derive === DERIVE_VERSION });
    } catch {
      // A line cut by an interrupted append.
    }
  }

  return out;
}

export type PulledSummaries = {
  /** Lines R2 holds, and how many of them the local file took. */
  stored: number;
  taken: number;
  /** Hash of the object's text, for `pushSummaries` to skip an upload that would change nothing. */
  sha256: string | null;
};

/**
 * Adds to the local file the summaries R2 holds and the file lacks: a game it
 * has no line for, or one whose local line is not a current summary while R2's
 * is. A read error throws (the run would otherwise recompute everything and
 * replace the object); an object that cannot be read back is ignored and
 * replaced by the next push.
 */
export async function pullSummaries(remote: ObjectStore, file = INGAME_FILE): Promise<PulledSummaries> {
  const body = await remote.get(SUMMARIES_KEY);

  if (!body) return { stored: 0, taken: 0, sha256: null };
  let text: Buffer;

  try {
    text = zstdDecompressSync(body);
  } catch (err) {
    console.warn(`  ingame: ${SUMMARIES_KEY} in ${remote.label} is unreadable (${err instanceof Error ? err.message : String(err)}), ignored`);

    return { stored: 0, taken: 0, sha256: null };
  }

  const theirs = latestLines(text.toString("utf8"));
  const mine = existsSync(file) ? latestLines(readFileSync(file, "utf8")) : new Map<string, { current: boolean }>();
  const taken: string[] = [];

  for (const [key, line] of theirs) {
    const local = mine.get(key);

    if (!local || (line.current && !local.current)) taken.push(line.raw);
  }

  if (taken.length) {
    mkdirSync(dirname(file), { recursive: true });
    // The leading newline closes a last line an interrupted append left open.
    appendFileSync(file, `\n${taken.join("\n")}\n`);
  }

  return { stored: theirs.size, taken: taken.length, sha256: sha256(text) };
}

/**
 * Writes the local summaries (latest line per game, in the order of the
 * file) to R2, unless they are what `pullSummaries` read. Returns whether R2 holds them
 * now: a failed upload only costs the next run the summaries of this one.
 */
export async function pushSummaries(remote: ObjectStore, pulled: PulledSummaries | null, file = INGAME_FILE): Promise<boolean> {
  const lines = existsSync(file) ? [...latestLines(readFileSync(file, "utf8")).values()] : [];
  const text = Buffer.from(lines.map((line) => `${line.raw}\n`).join(""));

  if (!lines.length || sha256(text) === pulled?.sha256) return true;

  try {
    await remote.put(SUMMARIES_KEY, zstdCompressSync(text, { params: { [constants.ZSTD_c_compressionLevel]: 10 } }), SUMMARIES_CONTENT_TYPE);
    console.log(`riot: ${lines.length} in-game summaries written to ${remote.label}`);

    return true;
  } catch (err) {
    console.warn(`  ingame: upload of ${SUMMARIES_KEY} failed (${err instanceof Error ? err.message : String(err)}), the next run recomputes what it lacks`);

    return false;
  }
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
  /** Clock of the wiki time budget, for tests. */
  now?: () => number;
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

  const now = opts.now ?? Date.now;
  const deadline = opts.budgetMinutes == null ? Infinity : now() + opts.budgetMinutes * 60_000;
  const started = Date.now();
  const total = todo.length;
  /** Games a response left out: each is asked once more, alone, before any fresh batch. */
  const retries: RiotGameRow[] = [];
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

  while (todo.length || retries.length) {
    if (now() > deadline) {
      const pending = todo.length + retries.length;
      counts.left += pending;
      console.log(`riot: time budget reached, ${pending} games left for the next run`);
      break;
    }

    // A retry is always a request of its own, whatever the batch size, so that the
    // game it gave up on is not left out again next to another one.
    const single = retries.length > 0;
    const batch = single ? retries.splice(0, 1) : todo.splice(0, GAMES_PER_REQUEST);
    let downloaded: Downloaded[];

    try {
      downloaded = await download(batch, fetchPages);
      failures = 0;
    } catch (err) {
      // The wiki is down or refusing us: pause, then try the same request again; give up after a long outage.
      (single ? retries : todo).unshift(...batch);

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
          retries.push(row);
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

    if (done - lastLog >= 100 || !(todo.length || retries.length)) {
      lastLog = done;
      const perGame = (Date.now() - started) / Math.max(1, done);
      const eta = ((todo.length + retries.length) * perGame) / 3_600_000;
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
