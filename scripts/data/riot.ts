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

const MISSING_RETRY_DAYS = 30;

export const localRiotStore = () => new FsStore(RIOT_CACHE_DIR);

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

  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.Key) && seen.add(r.Key));

  if (skipped) console.log(`  riot: ${skipped} PostgameJsonMetadata rows without a key or stats page skipped`);

  return unique;
}

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

export const SUMMARIES_KEY = "derived/ingame.jsonl.zst";

const SUMMARIES_CONTENT_TYPE = "application/zstd";

const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

const LineHead = z.object({ key: z.string(), status: z.string(), derive: z.number().optional() });

function latestLines(text: string): Map<string, { raw: string; current: boolean }> {
  const out = new Map<string, { raw: string; current: boolean }>();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;

    try {
      const line = LineHead.parse(JSON.parse(raw));
      out.set(line.key, { raw, current: line.status === "ok" && line.derive === DERIVE_VERSION });
    } catch {
    }
  }

  return out;
}

export type PulledSummaries = {
  stored: number;
  taken: number;
  sha256: string | null;
};

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
    appendFileSync(file, `\n${taken.join("\n")}\n`);
  }

  return { stored: theirs.size, taken: taken.length, sha256: sha256(text) };
}

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

export type RiotFetchOptions = {
  budgetMinutes: number | null;
  remote: ObjectStore | null;
  rederive: boolean;
  local?: ObjectStore;
  ingameFile?: string;
  fetchPages?: typeof wikiPages;
  now?: () => number;
};

export type RiotFetchCounts = {
  listed: number;
  current: number;
  from_cache: number;
  from_r2: number;
  from_wiki: number;
  missing: number;
  invalid: number;
  r2_errors: number;
  uploaded: number;
  upload_errors: number;
  left: number;
};

export type SummaryState = { kind: "current" } | { kind: "checked"; status: "missing" | "invalid" } | { kind: "stale" };

export function summaryState(line: IngameLine | undefined, rederive: boolean, now = Date.now()): SummaryState {
  if (!line) return { kind: "stale" };

  if (line.status === "ok") return line.derive === DERIVE_VERSION && !rederive ? { kind: "current" } : { kind: "stale" };

  return now - Date.parse(line.checkedAt) < MISSING_RETRY_DAYS * 86400_000 ? { kind: "checked", status: line.status } : { kind: "stale" };
}

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

function readRaw(body: Uint8Array | null): RawGame | null {
  if (!body) return null;

  try {
    return decodeRawGame(body);
  } catch {
    return null;
  }
}

const GAMES_PER_REQUEST = Math.min(4, Math.max(1, Number(process.env.RIOT_GAMES_PER_REQUEST || 2)));

const OUTAGE_PAUSE_MS = 5 * 60_000;
const MAX_OUTAGE_PAUSES = 6;

type Downloaded = { row: RiotGameRow; result: RawGame | { missing: string } | { invalid: string } | null };

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

  for (const row of rows) {
    const state = summaryState(index.get(row.Key), opts.rederive);

    if (state.kind === "current") {
      counts.current++;
      continue;
    }

    const key = rawGameKey(row.Key);
    const raw = cached.has(key) ? readRaw(await local.get(key)) : null;

    if (raw) {
      if (summarize(raw, summaries, counts)) counts.from_cache++;
      continue;
    }

    if (state.kind === "checked") counts[state.status]++;
    else todo.push(row);
  }

  console.log(
    `riot: ${rows.length} games with Riot JSON in scope, ${counts.current} up to date, ${counts.from_cache} derived from the local cache, ` +
      `${todo.length} to fetch${opts.remote ? ` (${opts.remote.label} first)` : ""}`,
  );

  if (opts.remote && todo.length) todo = await readFromR2(todo, opts.remote, local, summaries, counts);

  if (todo.length) console.log(`riot: ${todo.length} games to download from the wiki (${GAMES_PER_REQUEST} per request)`);

  const now = opts.now ?? Date.now;
  const deadline = opts.budgetMinutes == null ? Infinity : now() + opts.budgetMinutes * 60_000;
  const started = Date.now();
  const total = todo.length;
  const retries: RiotGameRow[] = [];
  const retried = new Set<string>();
  let done = 0;
  let lastLog = 0;
  let failures = 0;

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

    const single = retries.length > 0;
    const batch = single ? retries.splice(0, 1) : todo.splice(0, GAMES_PER_REQUEST);
    let downloaded: Downloaded[];

    try {
      downloaded = await download(batch, fetchPages);
      failures = 0;
    } catch (err) {
      (single ? retries : todo).unshift(...batch);

      if (++failures >= MAX_OUTAGE_PAUSES) throw err;
      console.warn(`  riot: ${err instanceof Error ? err.message : String(err)}; pausing ${OUTAGE_PAUSE_MS / 60_000} min (${failures}/${MAX_OUTAGE_PAUSES})`);
      await new Promise((r) => setTimeout(r, OUTAGE_PAUSE_MS));
      continue;
    }

    for (const { row, result } of downloaded) {
      if (result === null) {
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
