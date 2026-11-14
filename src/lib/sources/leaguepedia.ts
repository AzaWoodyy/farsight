import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Minimal Leaguepedia Cargo client.
 *
 * Uses Special:CargoExport (JSON), which serves the same data as the
 * `action=cargoquery` API. Anonymous `cargoquery` calls are rate-limited very
 * aggressively, so we stay polite: one request at a time, at least 2 s between
 * requests, exponential backoff on errors, and every response cached on disk
 * so re-running the ingestion never re-hits the wiki.
 *
 * Data: Leaguepedia (https://lol.fandom.com), CC BY-SA 3.0.
 */

export const LEAGUEPEDIA_BASE = "https://lol.fandom.com";
const EXPORT_URL = `${LEAGUEPEDIA_BASE}/wiki/Special:CargoExport`;

const API_URL = `${LEAGUEPEDIA_BASE}/api.php`;

/** Says who we are and how we behave, as the wiki's bot policy asks. */
export const USER_AGENT =
  process.env.LEAGUEPEDIA_USER_AGENT ||
  "farsight/0.4 (+https://farsight.enzoneault.dev; portfolio research project; batch ingestion, one request at a time, at least 2 s apart)";

const MIN_DELAY_MS = 2000;

const DELAY_MS = Math.max(
  MIN_DELAY_MS,
  Number(process.env.LEAGUEPEDIA_DELAY_MS || 2500),
);

const MAX_ATTEMPTS = 6;
export const PAGE_SIZE = 5000;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

const CargoText = z.string().transform(decodeEntities);

/** One Cargo field: text (HTML entities decoded), number, list field, or empty. */
export const CargoValue = z.union([CargoText, z.number(), z.boolean(), z.null(), z.array(z.union([CargoText, z.number()]))]);

export type CargoValue = z.output<typeof CargoValue>;

export const CargoRow = z.record(z.string(), CargoValue);

export type CargoRow = z.output<typeof CargoRow>;

const CargoRows = z.array(CargoRow);

/** Cached responses hold rows already decoded: same shape, no second decoding pass. */
const StoredValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]);

/** A Cargo row as stored on disk (cache, datasets): already decoded. */
export const StoredCargoRow = z.record(z.string(), StoredValue);
const CachedResponse = z.object({ rows: z.array(StoredCargoRow) });

export type CargoQuery = {
  tables: string;
  /** Fields as "Table.Field=Alias" so the JSON keys are stable. */
  fields: string[];
  where?: string;
  joinOn?: string;
  orderBy?: string;
};

export type CargoOptions = {
  /** Directory holding one JSON file per raw response. */
  cacheDir: string;
  /** Ignore cached responses and hit the network (responses are re-cached). */
  refresh?: boolean;
};

export const cargoStats = { requests: 0, cached: 0, bytes: 0 };

let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(
  q: CargoQuery,
  offset: number,
  opts: CargoOptions,
): Promise<CargoRow[]> {
  const params = new URLSearchParams({
    tables: q.tables,
    fields: q.fields.join(","),
    format: "json",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });

  if (q.where) params.set("where", q.where);

  if (q.joinOn) params.set("join on", q.joinOn);

  if (q.orderBy) params.set("order by", q.orderBy);
  const url = `${EXPORT_URL}?${params}`;

  mkdirSync(opts.cacheDir, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex").slice(0, 20);
  const cacheFile = resolve(opts.cacheDir, `${key}.json`);

  if (!opts.refresh && existsSync(cacheFile)) {
    cargoStats.cached++;

    return CachedResponse.parse(JSON.parse(readFileSync(cacheFile, "utf8"))).rows;
  }

  const rows = await politeGet(url, (text) => {
    if (text.trimStart().startsWith("[")) return CargoRows.parse(JSON.parse(text));

    // Cargo query errors (bad field, bad table, bad syntax) are not retryable.
    if (/^Error:|Error \d{4}|Unknown column/i.test(text.trimStart())) throw new CargoQueryError(text.slice(0, 300));

    return null;
  });

  writeFileSync(cacheFile, JSON.stringify({ url, fetchedAt: new Date().toISOString(), rows }));

  return rows;
}

/**
 * The one way this module reaches the wiki: one request at a time, at least
 * DELAY_MS between two request starts, exponential backoff on errors, and the
 * server's Retry-After (or MediaWiki `maxlag`) honoured when it sends one.
 * `parse` returns the value, null for a retryable answer, or throws to stop.
 */
async function politeGet<T>(url: string, parse: (text: string) => T | null): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastRequestAt + DELAY_MS - Date.now();

    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    cargoStats.requests++;

    let status = "network error";
    let retryAfter = 0;

    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      const text = await res.text();
      cargoStats.bytes += text.length;
      retryAfter = Number(res.headers.get("retry-after")) || 0;

      if (res.ok) {
        const value = parse(text);

        if (value !== null) return value;
        status = `unexpected answer (${text.slice(0, 120).replace(/\s+/g, " ")})`;
      } else status = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof CargoQueryError || err instanceof WikiApiError) throw err;
      status = `network error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const backoff = Math.max(DELAY_MS * 2 ** (attempt + 1), retryAfter * 1000);
    console.warn(`  leaguepedia: ${status}, retrying in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
  }

  throw new Error(`Leaguepedia request failed after retries: ${url}`);
}

class WikiApiError extends Error {
  constructor(message: string) {
    super(`MediaWiki API error: ${message}`);
  }
}

class CargoQueryError extends Error {
  constructor(message: string) {
    super(`Cargo error: ${message}`);
  }
}

const ApiPages = z.object({
  query: z
    .object({
      pages: z.array(
        z.object({
          title: z.string(),
          missing: z.boolean().optional(),
          invalid: z.boolean().optional(),
          revisions: z
            .array(z.object({ revid: z.number(), timestamp: z.string(), slots: z.object({ main: z.object({ content: z.string() }) }) }))
            .optional(),
        }),
      ),
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    })
    .optional(),
  error: z.object({ code: z.string(), info: z.string().optional() }).optional(),
});

export type WikiPage = { title: string; revid: number; timestamp: string; content: string } | { title: string; missing: true };

/**
 * Latest revision content of a few wiki pages (MediaWiki API, one request).
 * A title absent from the result was not served (size limit): request it again.
 * `maxlag=5` lets the wiki ask us to back off when its replicas lag; that
 * answer is retried like an HTTP error.
 */
export async function wikiPages(titles: string[]): Promise<Map<string, WikiPage>> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "revisions",
    rvprop: "ids|timestamp|content",
    rvslots: "main",
    maxlag: "5",
    titles: titles.join("|"),
  });

  const data = await politeGet(`${API_URL}?${params}`, (text) => {
    const parsed = ApiPages.safeParse(JSON.parse(text));

    if (!parsed.success) return null;

    if (parsed.data.error?.code === "maxlag") return null;

    if (parsed.data.error) throw new WikiApiError(`${parsed.data.error.code} ${parsed.data.error.info ?? ""}`);

    return parsed.data;
  });

  const renamed = new Map((data.query?.normalized ?? []).map((n) => [n.to, n.from]));
  const out = new Map<string, WikiPage>();

  for (const p of data.query?.pages ?? []) {
    const title = renamed.get(p.title) ?? p.title;
    const rev = p.revisions?.[0];

    if (rev) out.set(title, { title, revid: rev.revid, timestamp: rev.timestamp, content: rev.slots.main.content });
    // No content without `missing`: the answer hit the API size limit, ask again.
    else if (p.missing || p.invalid) out.set(title, { title, missing: true });
  }

  return out;
}

/** Runs a Cargo query and follows offset pagination until exhausted. */
export async function cargoQuery(
  q: CargoQuery,
  opts: CargoOptions,
): Promise<CargoRow[]> {
  const all: CargoRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(q, offset, opts);
    all.push(...page);

    if (page.length < PAGE_SIZE) break;
  }

  return all;
}

export function wikiUrl(page: string): string {
  return `${LEAGUEPEDIA_BASE}/wiki/${encodeURIComponent(page.replace(/ /g, "_")).replace(/%2F/g, "/")}`;
}

/** Quote a value for a Cargo WHERE clause. */
export function cargoString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `field IN ("a","b",...)` for a Cargo WHERE clause. */
export function cargoIn(field: string, values: string[]): string {
  return `${field} IN (${values.map(cargoString).join(",")})`;
}
