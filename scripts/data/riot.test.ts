import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { RAW_GAME_FORMAT, type RawGame, encodeRawGame, rawGameKey } from "../../src/lib/sources/riot";
import { FsStore, type ObjectStore, R2Store } from "../../src/lib/storage";
import { DERIVE_VERSION, IngameLine, summarizeGame } from "./ingame";
import { type RiotGameRow, SUMMARIES_KEY, fetchRiotGames, loadIngame, pullSummaries, pushSummaries } from "./riot";

/** A minimal S3-compatible server: GET, HEAD, PUT and ListObjectsV2 on one bucket. */
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

/** One game, 2 players, 11 one-minute frames: enough for summarizeGame. */
function game(key: string): RawGame {
  const frame = (m: number) => ({
    timestamp: m * 60_000,
    participantFrames: {
      1: { participantId: 1, totalGold: 500 + 300 * m, xp: 100 * m, minionsKilled: 8 * m, jungleMinionsKilled: 0 },
      2: { participantId: 2, totalGold: 500 + 250 * m, xp: 90 * m, minionsKilled: 7 * m, jungleMinionsKilled: 0 },
    },
    events: m === 4 ? [{ type: "CHAMPION_KILL", timestamp: 4 * 60_000 + 5_000, killerId: 1, victimId: 2, assistingParticipantIds: [] }] : [],
  });

  return {
    format: RAW_GAME_FORMAT,
    key,
    gameId: `Test/2026 Season_${key}`,
    version: 5,
    statsPage: `V5 data:${key.replace("_", " ")}`,
    timelinePage: `V5 data:${key.replace("_", " ")}/Timeline`,
    statsRevid: 1,
    timelineRevid: 2,
    fetchedAt: "2026-11-14T00:00:00.000Z",
    stats: {
      gameDuration: 660,
      gameVersion: "16.20.1",
      participants: [
        { participantId: 1, teamId: 100, championId: 103, championName: "Ahri", kills: 1, deaths: 0, assists: 0, firstBloodKill: true, pentaKills: 0 },
        { participantId: 2, teamId: 200, championId: 1, championName: "Annie", kills: 0, deaths: 1, assists: 0, firstBloodKill: false, pentaKills: 0 },
      ],
      teams: [
        { teamId: 100, objectives: { champion: { first: true, kills: 1 } } },
        { teamId: 200, objectives: { champion: { first: false, kills: 0 } } },
      ],
    },
    timeline: { frames: Array.from({ length: 11 }, (_, m) => frame(m)) },
  };
}

const row = (key: string): RiotGameRow => ({
  Key: key,
  GameId: `Test/2026 Season_${key}`,
  StatsPage: `V5 data:${key.replace("_", " ")}`,
  TimelinePage: `V5 data:${key.replace("_", " ")}/Timeline`,
  Version: 5,
  Page: "Test/2026 Season",
  League: "Test",
});

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
    // Cached locally, byte for byte, and summarized.
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

test("a game whose upload to R2 fails is left for the next run", async () => {
  const failing: ObjectStore = {
    label: "r2:failing",
    get: async () => null,
    put: async () => {
      throw new Error("R2 PUT: HTTP 500");
    },
    has: async () => false,
    list: async () => [],
  };

  const raw = game("TEST_3");
  const local = new FsStore(join(dir, "riot3"));
  const ingameFile = join(dir, "ingame3.jsonl");

  const counts = await fetchRiotGames([row("TEST_3")], {
    budgetMinutes: 1,
    remote: failing,
    rederive: false,
    local,
    ingameFile,
    fetchPages: async (titles) =>
      new Map(titles.map((t) => [t, { title: t, revid: 1, timestamp: "2026-11-14T00:00:00Z", content: JSON.stringify(t.endsWith("/Timeline") ? raw.timeline : raw.stats) }])),
  });

  expect(counts).toMatchObject({ upload_errors: 1, uploaded: 0, from_wiki: 0, left: 1 });
  // No summary line, so the next run looks at the game again; the raw JSON stays in the local cache.
  expect(loadIngame(ingameFile).get("TEST_3")).toBeUndefined();
  expect(await local.get(rawGameKey("TEST_3"))).not.toBeNull();

  // A machine that keeps the local cache summarizes it without the wiki (and `data:sync` uploads it).
  const r2 = fakeR2(new Map());

  try {
    const again = await fetchRiotGames([row("TEST_3")], {
      budgetMinutes: 1,
      remote: r2.store,
      rederive: false,
      local,
      ingameFile,
      fetchPages: async () => {
        throw new Error("the wiki must not be called");
      },
    });

    expect(again).toMatchObject({ from_cache: 1, from_wiki: 0, left: 0 });
    expect(loadIngame(ingameFile).get("TEST_3")?.status).toBe("ok");
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

/** The game a page title belongs to: "V5 data:TEST 10/Timeline" → "TEST_10". */
const gameOf = (title: string) => title.replace(/^V5 data:/, "").replace(/\/Timeline$/, "").replace(" ", "_");

/**
 * A wiki that leaves the games of `omitted` out of every multi-game response (no
 * entry at all, not a missing-page marker) and serves them only when asked alone;
 * the games of `never` are left out of every response. Records the games of each request.
 */
function omittingWiki(omitted: string[], never: string[] = []) {
  const calls: string[][] = [];

  const fetchPages = async (titles: string[]) => {
    const games = [...new Set(titles.map(gameOf))];
    calls.push(games);
    const served = titles.filter((t) => !never.includes(gameOf(t)) && (games.length === 1 || !omitted.includes(gameOf(t))));

    return new Map(
      served.map((t) => {
        const raw = game(gameOf(t));

        return [t, { title: t, revid: 1, timestamp: "2026-11-14T00:00:00Z", content: JSON.stringify(t.endsWith("/Timeline") ? raw.timeline : raw.stats) }];
      }),
    );
  };

  return { calls, fetchPages };
}

const okLines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => IngameLine.parse(JSON.parse(l)));

test("two games left out of a grouped response are each asked again alone, and stored once", async () => {
  const wiki = omittingWiki(["TEST_10", "TEST_11"]);
  const local = new FsStore(join(dir, "riot10"));
  const ingameFile = join(dir, "ingame10.jsonl");
  const opts = { budgetMinutes: 1, remote: null, rederive: false, local, ingameFile, fetchPages: wiki.fetchPages };

  const counts = await fetchRiotGames([row("TEST_10"), row("TEST_11")], opts);

  expect(wiki.calls).toEqual([["TEST_10", "TEST_11"], ["TEST_10"], ["TEST_11"]]);
  expect(counts).toMatchObject({ from_wiki: 2, left: 0, missing: 0, invalid: 0 });
  expect(okLines(ingameFile).map((l) => `${l.key}:${l.status}`)).toEqual(["TEST_10:ok", "TEST_11:ok"]);
  expect(await local.get(rawGameKey("TEST_11"))).not.toBeNull();

  // The next run skips them.
  wiki.calls.length = 0;
  const again = await fetchRiotGames([row("TEST_10"), row("TEST_11")], opts);
  expect(wiki.calls).toEqual([]);
  expect(again).toMatchObject({ current: 2, from_wiki: 0, left: 0 });
});

test("in a mixed response, only the game left out is asked again, before the next batch", async () => {
  const wiki = omittingWiki(["TEST_21"]);
  const ingameFile = join(dir, "ingame20.jsonl");

  const counts = await fetchRiotGames([row("TEST_20"), row("TEST_21"), row("TEST_22")], {
    budgetMinutes: 1,
    remote: null,
    rederive: false,
    local: new FsStore(join(dir, "riot20")),
    ingameFile,
    fetchPages: wiki.fetchPages,
  });

  expect(wiki.calls).toEqual([["TEST_20", "TEST_21"], ["TEST_21"], ["TEST_22"]]);
  expect(counts).toMatchObject({ from_wiki: 3, left: 0 });
  expect(okLines(ingameFile).map((l) => l.key)).toEqual(["TEST_20", "TEST_21", "TEST_22"]);
});

test("a game left out again when asked alone is left for the next run, with no summary", async () => {
  const wiki = omittingWiki([], ["TEST_30"]);
  const ingameFile = join(dir, "ingame30.jsonl");
  const opts = { budgetMinutes: 1, remote: null, rederive: false, local: new FsStore(join(dir, "riot30")), ingameFile, fetchPages: wiki.fetchPages };

  const counts = await fetchRiotGames([row("TEST_30")], opts);

  expect(wiki.calls).toEqual([["TEST_30"], ["TEST_30"]]);
  expect(counts).toMatchObject({ from_wiki: 0, left: 1, missing: 0, invalid: 0 });
  expect(loadIngame(ingameFile).get("TEST_30")).toBeUndefined();

  // The next run looks at it again.
  wiki.calls.length = 0;
  expect(await fetchRiotGames([row("TEST_30")], opts)).toMatchObject({ left: 1 });
  expect(wiki.calls).toEqual([["TEST_30"], ["TEST_30"]]);
});

test("the games waiting for a retry count as left when the time budget runs out", async () => {
  let clock = 0;
  const wiki = omittingWiki(["TEST_40", "TEST_41"]);

  const counts = await fetchRiotGames([row("TEST_40"), row("TEST_41"), row("TEST_42")], {
    budgetMinutes: 1,
    remote: null,
    rederive: false,
    local: new FsStore(join(dir, "riot40")),
    ingameFile: join(dir, "ingame40.jsonl"),
    now: () => clock,
    fetchPages: async (titles) => {
      clock += 2 * 60_000;

      return wiki.fetchPages(titles);
    },
  });

  expect(wiki.calls).toEqual([["TEST_40", "TEST_41"]]);
  expect(counts).toMatchObject({ from_wiki: 0, left: 3 });
});

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

test("the summaries of a run are written to R2 with the ones it started from, sorted by game", async () => {
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
    expect(stored.map((l) => [l.key, l.status])).toEqual([["SUM_A", "ok"], ["SUM_B", "ok"], ["SUM_C", "ok"]]);
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
    // The local file ends on a line an interrupted append left open.
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
