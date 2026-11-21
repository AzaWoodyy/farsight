import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../fs-atomic";

export const LEAGUEPEDIA_BASE = "https://lol.fandom.com";
const EXPORT_URL = `${LEAGUEPEDIA_BASE}/wiki/Special:CargoExport`;

const API_URL = `${LEAGUEPEDIA_BASE}/api.php`;

export const USER_AGENT =
  process.env.LEAGUEPEDIA_USER_AGENT ||
  "farsight/0.4 (+https://askfarsight.com; portfolio research project; batch ingestion, one request at a time, at least 2 s apart)";

const MIN_DELAY_MS = 2000;

const DELAY_MS = Math.max(
  MIN_DELAY_MS,
  Number(process.env.LEAGUEPEDIA_DELAY_MS || 2500),
);

const MAX_ATTEMPTS = 6;

const REQUEST_TIMEOUT_MS = 60_000;
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

export const CargoValue = z.union([CargoText, z.number(), z.boolean(), z.null(), z.array(z.union([CargoText, z.number()]))]);

export type CargoValue = z.output<typeof CargoValue>;

export const CargoRow = z.record(z.string(), CargoValue);

export type CargoRow = z.output<typeof CargoRow>;

const CargoRows = z.array(CargoRow);

const StoredValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]);

export const StoredCargoRow = z.record(z.string(), StoredValue);
const CachedResponse = z.object({ rows: z.array(StoredCargoRow) });

export type CargoQuery = {
  tables: string;
  fields: string[];
  where?: string;
  joinOn?: string;
  orderBy?: string;
};

export type CargoOptions = {
  cacheDir: string;
  refresh?: boolean;
};

export const cargoStats = { requests: 0, cached: 0, bytes: 0 };

let lastRequestAt = 0;

export const transport = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  now: (): number => Date.now(),
};

export function resetThrottle(): void {
  lastRequestAt = 0;
  cargoStats.requests = 0;
  cargoStats.cached = 0;
  cargoStats.bytes = 0;
}

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
    try {
      const { rows } = CachedResponse.parse(JSON.parse(readFileSync(cacheFile, "utf8")));
      cargoStats.cached++;

      return rows;
    } catch {
      console.warn(`  leaguepedia: unreadable cache file ${basename(cacheFile)}, fetching again`);
    }
  }

  const rows = await politeGet(url, (text) => {
    if (text.trimStart().startsWith("[")) return CargoRows.parse(JSON.parse(text));

    if (/^Error:|Error \d{4}|Unknown column/i.test(text.trimStart())) throw new CargoQueryError(text.slice(0, 300));

    return null;
  });

  writeFileAtomic(cacheFile, JSON.stringify({ url, fetchedAt: new Date().toISOString(), rows }));

  return rows;
}

async function politeGet<T>(url: string, parse: (text: string) => T | null): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastRequestAt + DELAY_MS - transport.now();

    if (wait > 0) await transport.sleep(wait);
    lastRequestAt = transport.now();
    cargoStats.requests++;

    let status = "network error";
    let retryAfter = 0;

    try {
      const res = await transport.fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
    await transport.sleep(backoff);
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
    else if (p.missing || p.invalid) out.set(title, { title, missing: true });
  }

  return out;
}

const ApiFiles = z.object({
  query: z
    .object({
      pages: z.array(z.object({ title: z.string(), imageinfo: z.array(z.object({ width: z.number() })).optional() })),
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    })
    .optional(),
  error: z.object({ code: z.string(), info: z.string().optional() }).optional(),
});

export const FILES_PER_REQUEST = 50;

export function parseWikiFiles(names: string[], data: z.infer<typeof ApiFiles>): Map<string, string | null> {
  const step = (moves: { from: string; to: string }[] | undefined) => new Map((moves ?? []).map((m) => [m.from, m.to]));
  const normalized = step(data.query?.normalized);
  const redirected = step(data.query?.redirects);
  const pages = new Map((data.query?.pages ?? []).map((p) => [p.title, p]));
  const out = new Map<string, string | null>();

  for (const name of names) {
    const asked = `File:${name}`;
    const title = normalized.get(asked) ?? asked;
    const target = redirected.get(title) ?? title;
    const page = pages.get(target);

    if (!page) continue;
    out.set(name, page.imageinfo?.length ? page.title.replace(/^File:/, "") : null);
  }

  return out;
}

export async function wikiFiles(names: string[]): Promise<Map<string, string | null>> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "imageinfo",
    iiprop: "size",
    maxlag: "5",
    titles: names.map((n) => `File:${n}`).join("|"),
  });

  const data = await politeGet(`${API_URL}?${params}`, (text) => {
    const parsed = ApiFiles.safeParse(JSON.parse(text));

    if (!parsed.success || parsed.data.error?.code === "maxlag") return null;

    if (parsed.data.error) throw new WikiApiError(`${parsed.data.error.code} ${parsed.data.error.info ?? ""}`);

    return parsed.data;
  });

  return parseWikiFiles(names, data);
}

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

export function cargoString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function cargoIn(field: string, values: string[]): string {
  return `${field} IN (${values.map(cargoString).join(",")})`;
}
