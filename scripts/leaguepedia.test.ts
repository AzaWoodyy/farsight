import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type CargoQuery, type CargoRow, PAGE_SIZE, USER_AGENT, cargoQuery, cargoStats, resetThrottle, transport, wikiPages } from "../src/lib/sources/leaguepedia";

const MIN_DELAY_MS = 2000;

type Scripted = Response | Error;

const saved = { ...transport };
const savedWarn = console.warn;

let clock = 0;
let sleeps: number[] = [];
let requests: { url: URL; at: number }[] = [];
let queue: Scripted[] = [];
let cacheDir = "";

function script(...answers: Scripted[]): void {
  queue.push(...answers);
}

type ApiAnswer = {
  query?: {
    pages: { title: string; missing?: boolean; revisions?: { revid: number; timestamp: string; slots: { main: { content: string } } }[] }[];
    normalized?: { from: string; to: string }[];
  };
  error?: { code: string; info?: string };
};

const json = (body: CargoRow[] | ApiAnswer, init?: ResponseInit) => new Response(JSON.stringify(body), init);

const query = (tables: string): CargoQuery => ({ tables, fields: [`${tables}.N=N`] });

function quiet(): void {
  console.warn = () => {};
}

beforeEach(() => {
  resetThrottle();
  clock = 1_000_000;
  sleeps = [];
  requests = [];
  queue = [];
  cacheDir = mkdtempSync(join(tmpdir(), "farsight-leaguepedia-"));

  transport.now = () => clock;

  transport.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };

  transport.fetch = async (url, init) => {
    expect(new Headers(init.headers).get("User-Agent")).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    requests.push({ url: new URL(url), at: clock });
    const next = queue.shift();

    if (!next) throw new Error(`unscripted request: ${url}`);

    if (next instanceof Error) throw next;

    return next;
  };
});

afterEach(() => {
  Object.assign(transport, saved);
  console.warn = savedWarn;
  resetThrottle();
  const left = queue.length;
  queue = [];
  rmSync(cacheDir, { recursive: true, force: true });
  expect(left).toBe(0);
});

test("the cache directory of every test is a temp directory", () => {
  expect(relative(tmpdir(), cacheDir).startsWith("..")).toBe(false);
});

test("a full page asks for the next offset, an empty page ends the query", async () => {
  script(json(Array.from({ length: PAGE_SIZE }, (_, i) => ({ N: i }))), json([]));

  const rows = await cargoQuery(query("Full"), { cacheDir });

  expect(rows).toHaveLength(PAGE_SIZE);
  expect(requests.map((r) => r.url.searchParams.get("offset"))).toEqual(["0", String(PAGE_SIZE)]);
  expect(requests.map((r) => r.url.searchParams.get("limit"))).toEqual([String(PAGE_SIZE), String(PAGE_SIZE)]);
});

test("a short page ends the query after one request", async () => {
  script(json([{ N: 1 }, { N: 2 }, { N: 3 }]));

  expect(await cargoQuery(query("Short"), { cacheDir })).toEqual([{ N: 1 }, { N: 2 }, { N: 3 }]);
  expect(requests).toHaveLength(1);
});

test("a cached query makes no request, refresh asks the wiki again", async () => {
  script(json([{ N: 1 }]));
  const first = await cargoQuery(query("Cached"), { cacheDir });

  const cached = await cargoQuery(query("Cached"), { cacheDir });
  expect(cached).toEqual(first);
  expect(requests).toHaveLength(1);
  expect(cargoStats.cached).toBe(1);

  script(json([{ N: 2 }]));
  expect(await cargoQuery(query("Cached"), { cacheDir, refresh: true })).toEqual([{ N: 2 }]);
  expect(requests).toHaveLength(2);
  expect(await cargoQuery(query("Cached"), { cacheDir })).toEqual([{ N: 2 }]);
});

test("HTML entities are decoded once, and the cached copy is not decoded again", async () => {
  script(json([{ Name: "A &amp; B &lt;x&gt; &quot;q&quot; &#39;s&#039;", Double: "&amp;amp;", List: ["x &amp; y", 3] }]));

  const [fresh] = await cargoQuery(query("Entities"), { cacheDir });
  expect(fresh).toEqual({ Name: `A & B <x> "q" 's'`, Double: "&amp;", List: ["x & y", 3] });

  const [cached] = await cargoQuery(query("Entities"), { cacheDir });
  expect(cached).toEqual(fresh);
  expect(requests).toHaveLength(1);
});

test("a Cargo query error is fatal: no retry", async () => {
  script(new Response("Error: Table Nope not found."));

  await expect(cargoQuery(query("Nope"), { cacheDir })).rejects.toThrow(/Cargo error: Error: Table Nope/);
  expect(requests).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("an unexpected 200 answer is retried after a backoff of twice the delay", async () => {
  quiet();
  script(new Response("<!DOCTYPE html><html>maintenance</html>"), json([{ N: 1 }]));

  expect(await cargoQuery(query("Html"), { cacheDir })).toEqual([{ N: 1 }]);
  expect(requests).toHaveLength(2);
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(2 * MIN_DELAY_MS);
  expect(requests[1].at - requests[0].at).toBe(sleeps[0]);
});

test("an HTTP error honours Retry-After", async () => {
  quiet();
  script(new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }), json([{ N: 1 }]));

  expect(await cargoQuery(query("Limited"), { cacheDir })).toEqual([{ N: 1 }]);
  expect(requests).toHaveLength(2);
  expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(120_000);
});

test("a network error is retried", async () => {
  quiet();
  script(new TypeError("fetch failed"), json([{ N: 1 }]));

  expect(await cargoQuery(query("Network"), { cacheDir })).toEqual([{ N: 1 }]);
  expect(requests).toHaveLength(2);
});

test("six failed attempts give up, with a growing backoff", async () => {
  quiet();
  script(...Array.from({ length: 6 }, () => new Response("oops", { status: 503 })));

  await expect(cargoQuery(query("Down"), { cacheDir })).rejects.toThrow(/failed after retries/);
  expect(requests).toHaveLength(6);
  expect(sleeps).toHaveLength(6);

  for (let i = 1; i < sleeps.length; i++) expect(sleeps[i]).toBe(sleeps[i - 1] * 2);
});

test("two requests start at least 2 s apart", async () => {
  script(json([{ N: 1 }]), json([{ N: 2 }]));

  await cargoQuery(query("First"), { cacheDir });
  await cargoQuery(query("Second"), { cacheDir });

  expect(requests).toHaveLength(2);
  expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(MIN_DELAY_MS);
  expect(cargoStats.requests).toBe(2);
});

test("wikiPages maps content, missing pages and normalized titles; an unserved page is absent", async () => {
  script(
    json({
      query: {
        normalized: [{ from: "V5 data:ESPORTSTMNT01_1", to: "V5 data:ESPORTSTMNT01 1" }],
        pages: [
          { title: "V5 data:ESPORTSTMNT01 1", revisions: [{ revid: 7, timestamp: "2026-01-01T00:00:00Z", slots: { main: { content: "{}" } } }] },
          { title: "Gone", missing: true },
          { title: "Too big" },
        ],
      },
    }),
  );

  const pages = await wikiPages(["V5 data:ESPORTSTMNT01_1", "Gone", "Too big"]);

  expect(requests).toHaveLength(1);
  expect(requests[0].url.searchParams.get("titles")).toBe("V5 data:ESPORTSTMNT01_1|Gone|Too big");
  expect(requests[0].url.searchParams.get("maxlag")).toBe("5");
  expect(pages.get("V5 data:ESPORTSTMNT01_1")).toEqual({
    title: "V5 data:ESPORTSTMNT01_1",
    revid: 7,
    timestamp: "2026-01-01T00:00:00Z",
    content: "{}",
  });
  expect(pages.get("Gone")).toEqual({ title: "Gone", missing: true });
  expect(pages.has("Too big")).toBe(false);
  expect(pages.size).toBe(2);
});

test("wikiPages retries maxlag and stops on another API error", async () => {
  quiet();
  script(json({ error: { code: "maxlag", info: "Waiting for a replica" } }), json({ query: { pages: [{ title: "P", missing: true }] } }));

  expect((await wikiPages(["P"])).get("P")).toEqual({ title: "P", missing: true });
  expect(requests).toHaveLength(2);

  requests = [];
  script(json({ error: { code: "badtoken", info: "Invalid token" } }));

  await expect(wikiPages(["P"])).rejects.toThrow(/MediaWiki API error: badtoken/);
  expect(requests).toHaveLength(1);
});

test("a damaged cache file is fetched again and replaced by a valid one", async () => {
  quiet();
  script(json([{ N: 1 }]));
  await cargoQuery(query("Damaged"), { cacheDir });
  const [file] = readdirSync(cacheDir);
  writeFileSync(join(cacheDir, file), '{"rows":[{"A":');
  resetThrottle();

  script(json([{ N: 2 }]));
  expect(await cargoQuery(query("Damaged"), { cacheDir })).toEqual([{ N: 2 }]);
  expect(requests).toHaveLength(2);
  expect(cargoStats.cached).toBe(0);
  expect(JSON.parse(readFileSync(join(cacheDir, file), "utf8")).rows).toEqual([{ N: 2 }]);
});

test("a cached query leaves no temporary file behind", async () => {
  script(json([{ N: 1 }]), json([]));
  await cargoQuery(query("Atomic"), { cacheDir });
  script(json(Array.from({ length: PAGE_SIZE }, (_, i) => ({ N: i }))), json([]));
  await cargoQuery(query("AtomicPaged"), { cacheDir });
  queue = [];

  const files = readdirSync(cacheDir);
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("a timed-out request is retried, not fatal", async () => {
  quiet();
  script(new DOMException("timed out", "TimeoutError"), json([{ N: 1 }]));

  expect(await cargoQuery(query("Stalled"), { cacheDir })).toEqual([{ N: 1 }]);
  expect(requests).toHaveLength(2);
});
