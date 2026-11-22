import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { RAW_GAME_CONTENT_TYPE, encodeRawGame, rawGameKey } from "../../src/lib/sources/riot";
import { FsStore, type ObjectStore, R2Store } from "../../src/lib/storage";
import { riotGame as game, riotRow as row } from "../fixtures/riot-games";
import { DERIVE_VERSION, IngameLine, summarizeGame } from "./ingame";
import { SUMMARIES_KEY, fetchRiotGames, loadIngame, pullSummaries, pushSummaries, summaryState } from "./riot";

function fakeR2(objects: Map<string, Uint8Array>) {
  const requests: string[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
      requests.push(`${req.method} ${key}`);

      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));

        return new Response("");
      }

      if (url.searchParams.get("list-type") === "2") {
        const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? ""));

        return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      }

      const body = objects.get(key);

      if (req.method === "HEAD") return new Response(null, { status: body ? 200 : 404 });

      return body ? new Response(new Uint8Array(body)) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    },
  });

  const store = new R2Store({ accountId: "test", bucket: "bucket", accessKeyId: "AK", secretAccessKey: "SK", endpoint: `http://localhost:${server.port}` });

  return { store, requests, stop: () => server.stop(true) };
}

const dir = mkdtempSync(join(tmpdir(), "riot-test-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a game missing locally but present on R2 is read from R2, with no wiki request", async () => {
  const objects = new Map([[rawGameKey("TEST_1"), encodeRawGame(game("TEST_1"))]]);
  const r2 = fakeR2(objects);
  const local = new FsStore(join(dir, "riot"));
  const ingameFile = join(dir, "ingame.jsonl");
  const wikiCalls: string[][] = [];

  try {
    const counts = await fetchRiotGames([row("TEST_1")], {
      budgetMinutes: 1,
      remote: r2.store,
      rederive: false,
      local,
      ingameFile,
      fetchPages: async (titles) => {
        wikiCalls.push(titles);

        throw new Error("the wiki must not be called");
      },
    });

    expect(wikiCalls).toEqual([]);
    expect(counts).toMatchObject({ from_r2: 1, from_wiki: 0, from_cache: 0, r2_errors: 0, left: 0 });
    expect(r2.requests).toContain(`GET ${rawGameKey("TEST_1")}`);
    expect(Buffer.from((await local.get(rawGameKey("TEST_1")))!).equals(Buffer.from(objects.get(rawGameKey("TEST_1"))!))).toBe(true);
    const line = loadIngame(ingameFile).get("TEST_1");
    expect(line?.status).toBe("ok");
    expect(line?.status === "ok" && line.players.find((p) => p.pid === 1)).toMatchObject({ solo_kills: 1, kills_10: 1, gold_10: 3500, first_blood_kill: 1 });
    expect(readFileSync(ingameFile, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    r2.stop();
  }
});

test("a game absent from R2 goes to the wiki", async () => {
  const r2 = fakeR2(new Map());
  const wikiCalls: string[][] = [];

  try {
    const counts = await fetchRiotGames([row("TEST_2")], {
      budgetMinutes: 1,
      remote: r2.store,
      rederive: false,
      local: new FsStore(join(dir, "riot2")),
      ingameFile: join(dir, "ingame2.jsonl"),
      fetchPages: async (titles) => {
        wikiCalls.push(titles);

        return new Map(titles.map((t) => [t, { title: t, missing: true as const }]));
      },
    });

    expect(wikiCalls).toEqual([["V5 data:TEST 2", "V5 data:TEST 2/Timeline"]]);
    expect(counts).toMatchObject({ from_r2: 0, from_wiki: 0, missing: 1 });
  } finally {
    r2.stop();
  }
});

test("an R2 request that never gets an answer is aborted after the store's timeout", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });

  try {
    const store = new R2Store({
      accountId: "test",
      bucket: "bucket",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      endpoint: `http://localhost:${server.port}`,
      timeoutMs: 200,
    });

    const started = Date.now();
    await expect(store.get("games/x")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    server.stop(true);
  }
});

const gameOf = (title: string) => title.replace(/^V5 data:/, "").replace(/\/Timeline$/, "").replace(" ", "_");

function recordingWiki() {
  const calls: string[][] = [];

  const fetchPages = async (titles: string[]) => {
    calls.push([...new Set(titles.map(gameOf))]);

    return new Map(
      titles.map((t) => {
        const raw = game(gameOf(t));

        return [t, { title: t, revid: 1, timestamp: "2026-11-14T00:00:00Z", content: JSON.stringify(t.endsWith("/Timeline") ? raw.timeline : raw.stats) }];
      }),
    );
  };

  return { calls, fetchPages };
}

const noWiki = async () => {
  throw new Error("the wiki must not be called");
};

const jsonl = (lines: IngameLine[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

test("a machine without summaries takes them from R2, reads no game, and uploads nothing when nothing changed", async () => {
  const r2 = fakeR2(new Map());
  const seed = join(dir, "summaries-seed.jsonl");
  const ingameFile = join(dir, "summaries-empty", "ingame.jsonl");

  try {
    writeFileSync(seed, jsonl([summarizeGame(game("SUM_2")), summarizeGame(game("SUM_1"))]));
    expect(await pushSummaries(r2.store, null, seed)).toBe(true);
    r2.requests.length = 0;

    const pulled = await pullSummaries(r2.store, ingameFile);

    const counts = await fetchRiotGames([row("SUM_1"), row("SUM_2")], {
      budgetMinutes: 1, remote: r2.store, rederive: false, local: new FsStore(join(dir, "summaries-empty", "riot")), ingameFile, fetchPages: noWiki,
    });

    expect(pulled).toMatchObject({ stored: 2, taken: 2 });
    expect(counts).toMatchObject({ current: 2, from_r2: 0, from_wiki: 0, left: 0 });
    expect(await pushSummaries(r2.store, pulled, ingameFile)).toBe(true);
    expect(r2.requests).toEqual([`GET ${SUMMARIES_KEY}`]);
  } finally {
    r2.stop();
  }
});

test("the summaries of a run are written to R2 after the ones it started from, in the order of the file", async () => {
  const objects = new Map([[rawGameKey("SUM_B"), encodeRawGame(game("SUM_B"))]]);
  const r2 = fakeR2(objects);
  const seed = join(dir, "summaries-grow-seed.jsonl");
  const ingameFile = join(dir, "summaries-grow", "ingame.jsonl");

  try {
    writeFileSync(seed, jsonl([summarizeGame(game("SUM_C")), summarizeGame(game("SUM_A"))]));
    await pushSummaries(r2.store, null, seed);

    const pulled = await pullSummaries(r2.store, ingameFile);
    await fetchRiotGames([row("SUM_A"), row("SUM_B"), row("SUM_C")], {
      budgetMinutes: 1, remote: r2.store, rederive: false, local: new FsStore(join(dir, "summaries-grow", "riot")), ingameFile, fetchPages: noWiki,
    });

    expect(await pushSummaries(r2.store, pulled, ingameFile)).toBe(true);
    const stored = zstdDecompressSync(objects.get(SUMMARIES_KEY)!).toString("utf8").trim().split("\n").map((l) => IngameLine.parse(JSON.parse(l)));
    expect(stored.map((l) => [l.key, l.status])).toEqual([["SUM_C", "ok"], ["SUM_A", "ok"], ["SUM_B", "ok"]]);
    expect([...loadIngame(ingameFile).keys()]).toEqual(["SUM_C", "SUM_A", "SUM_B"]);
  } finally {
    r2.stop();
  }
});

test("a local line gives way to R2 only when R2 has a current summary and the local file does not", async () => {
  const r2 = fakeR2(new Map());
  const seed = join(dir, "summaries-merge-seed.jsonl");
  const ingameFile = join(dir, "summaries-merge.jsonl");
  const ok = (key: string) => summarizeGame(game(key));
  const old = (key: string) => ({ ...ok(key), derive: DERIVE_VERSION - 1 });
  const missing = (key: string, reason: string): IngameLine => ({ status: "missing", key, gameId: key, checkedAt: "2026-11-20T00:00:00.000Z", reason });

  try {
    writeFileSync(seed, jsonl([ok("M_OLD"), ok("M_MISSING"), missing("M_OK", "r2"), old("M_BOTH_OLD"), missing("M_BOTH_MISSING", "r2"), ok("M_NEW")]));
    await pushSummaries(r2.store, null, seed);
    writeFileSync(ingameFile, `${jsonl([old("M_OLD"), missing("M_MISSING", "local"), ok("M_OK"), { ...old("M_BOTH_OLD"), durationS: 1 }, missing("M_BOTH_MISSING", "local")])}{"status":"ok","key":"M_CUT`);

    expect(await pullSummaries(r2.store, ingameFile)).toMatchObject({ stored: 6, taken: 3 });
    const merged = loadIngame(ingameFile);

    expect([...merged.keys()].sort()).toEqual(["M_BOTH_MISSING", "M_BOTH_OLD", "M_MISSING", "M_NEW", "M_OK", "M_OLD"]);
    expect(merged.get("M_OLD")).toMatchObject({ status: "ok", derive: DERIVE_VERSION });
    expect(merged.get("M_MISSING")).toMatchObject({ status: "ok", derive: DERIVE_VERSION });
    expect(merged.get("M_NEW")).toMatchObject({ status: "ok" });
    expect(merged.get("M_OK")).toMatchObject({ status: "ok" });
    expect(merged.get("M_BOTH_OLD")).toMatchObject({ durationS: 1 });
    expect(merged.get("M_BOTH_MISSING")).toMatchObject({ reason: "local" });
  } finally {
    r2.stop();
  }
});

test("unreadable summaries on R2 are ignored and replaced; a failed read stops the run, a failed upload does not", async () => {
  const objects = new Map([[SUMMARIES_KEY, new TextEncoder().encode("not zstd")]]);
  const r2 = fakeR2(objects);
  const ingameFile = join(dir, "summaries-broken.jsonl");

  const failing: ObjectStore = {
    label: "failing",
    get: async () => {
      throw new Error("R2 GET: HTTP 500");
    },
    put: async () => {
      throw new Error("R2 PUT: HTTP 500");
    },
    has: async () => false,
    list: async () => [],
  };

  try {
    writeFileSync(ingameFile, jsonl([summarizeGame(game("SUM_X"))]));
    const pulled = await pullSummaries(r2.store, ingameFile);

    expect(pulled).toEqual({ stored: 0, taken: 0, sha256: null });
    expect(await pushSummaries(r2.store, pulled, ingameFile)).toBe(true);
    expect((await pullSummaries(r2.store, join(dir, "summaries-broken-2.jsonl"))).taken).toBe(1);

    await expect(pullSummaries(failing, ingameFile)).rejects.toThrow("HTTP 500");
    expect(await pushSummaries(failing, null, ingameFile)).toBe(false);
  } finally {
    r2.stop();
  }
});

const DAY_MS = 86_400_000;

const checkedLine = (key: string, status: "missing" | "invalid", daysAgo: number, now: number): IngameLine => ({
  status, key, gameId: `Test/2026 Season_${key}`, checkedAt: new Date(now - daysAgo * DAY_MS).toISOString(), reason: status,
});

test("where a game stands at the start of a run: current, checked within 30 days, or stale", () => {
  const now = Date.parse("2026-11-22T00:00:00Z");
  const ok = summarizeGame(game("STATE_1"));

  expect(summaryState(undefined, false, now)).toEqual({ kind: "stale" });
  expect(summaryState(ok, false, now)).toEqual({ kind: "current" });
  expect(summaryState(ok, true, now)).toEqual({ kind: "stale" });
  expect(summaryState({ ...ok, derive: DERIVE_VERSION - 1 }, false, now)).toEqual({ kind: "stale" });
  expect(summaryState(checkedLine("STATE_2", "missing", 29, now), false, now)).toEqual({ kind: "checked", status: "missing" });
  expect(summaryState(checkedLine("STATE_2", "invalid", 1, now), true, now)).toEqual({ kind: "checked", status: "invalid" });
  expect(summaryState(checkedLine("STATE_2", "missing", 31, now), false, now)).toEqual({ kind: "stale" });
});

test("a run skips current summaries and recent verdicts, reads the local cache first, and fetches the rest", async () => {
  const now = Date.now();
  const local = new FsStore(join(dir, "riot-start"));
  const ingameFile = join(dir, "ingame-start.jsonl");
  const wiki = recordingWiki();

  await local.put(rawGameKey("START_CACHED"), encodeRawGame(game("START_CACHED")), RAW_GAME_CONTENT_TYPE);
  writeFileSync(
    ingameFile,
    [summarizeGame(game("START_CURRENT")), checkedLine("START_RECENT", "missing", 2, now), checkedLine("START_OLD", "missing", 40, now), checkedLine("START_CACHED", "invalid", 2, now)]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(""),
  );

  const counts = await fetchRiotGames(["START_CURRENT", "START_RECENT", "START_OLD", "START_CACHED", "START_NEW"].map(row), {
    budgetMinutes: 1, remote: null, rederive: false, local, ingameFile, fetchPages: wiki.fetchPages,
  });

  expect(wiki.calls).toEqual([["START_OLD", "START_NEW"]]);
  expect(counts).toMatchObject({ current: 1, missing: 1, from_cache: 1, from_wiki: 2, left: 0 });
  expect(loadIngame(ingameFile).get("START_CACHED")?.status).toBe("ok");
});
