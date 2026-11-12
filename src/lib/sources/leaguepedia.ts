import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal Leaguepedia Cargo client.
 *
 * Uses Special:CargoExport (JSON), which serves the same data as the
 * `action=cargoquery` API. Anonymous `cargoquery` calls are rate-limited very
 * aggressively, so we stay polite: one request at a time, a fixed delay
 * between requests, exponential backoff on errors, and every response cached
 * on disk so re-running the ingestion never re-hits the wiki.
 *
 * Data: Leaguepedia (https://lol.fandom.com), CC BY-SA 3.0.
 */

export const LEAGUEPEDIA_BASE = "https://lol.fandom.com";
const EXPORT_URL = `${LEAGUEPEDIA_BASE}/wiki/Special:CargoExport`;
const USER_AGENT =
  process.env.LEAGUEPEDIA_USER_AGENT ??
  "lol-esports-agent/0.1 (open-source portfolio project; polite batch ingestion)";
const DELAY_MS = Number(process.env.LEAGUEPEDIA_DELAY_MS ?? 2000);
const RAW_DIR = resolve(process.cwd(), "data/raw");

export type CargoQuery = {
  tables: string;
  /** Fields as "Table.Field=Alias" so the JSON keys are stable. */
  fields: string[];
  where?: string;
  joinOn?: string;
  orderBy?: string;
  limit?: number;
};

let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchPage(
  q: CargoQuery,
  offset: number,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    tables: q.tables,
    fields: q.fields.join(","),
    format: "json",
    limit: String(q.limit ?? 5000),
    offset: String(offset),
  });
  if (q.where) params.set("where", q.where);
  if (q.joinOn) params.set("join on", q.joinOn);
  if (q.orderBy) params.set("order by", q.orderBy);
  const url = `${EXPORT_URL}?${params}`;

  mkdirSync(RAW_DIR, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const cacheFile = resolve(RAW_DIR, `${key}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8")).rows;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastRequestAt + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith("[")) {
      const rows = (JSON.parse(text) as Record<string, unknown>[]).map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, decodeEntities(v)]),
        ),
      );
      writeFileSync(
        cacheFile,
        JSON.stringify({ url, fetchedAt: new Date().toISOString(), rows }),
      );
      return rows;
    }
    if (text.startsWith("Error:")) {
      // Cargo query errors (bad field, bad table) are not retryable.
      throw new Error(`Cargo error: ${text.slice(0, 300)}`);
    }
    const backoff = DELAY_MS * 2 ** (attempt + 1);
    console.warn(
      `  leaguepedia: HTTP ${res.status}, retrying in ${backoff / 1000}s`,
    );
    await sleep(backoff);
  }
  throw new Error(`Leaguepedia request failed after retries: ${url}`);
}

/** Runs a Cargo query and follows offset pagination until exhausted. */
export async function cargoQuery(
  q: CargoQuery,
): Promise<Record<string, unknown>[]> {
  const limit = q.limit ?? 5000;
  const all: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage({ ...q, limit }, offset);
    all.push(...page);
    if (page.length < limit) break;
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
