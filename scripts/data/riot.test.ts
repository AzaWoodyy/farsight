import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAW_GAME_FORMAT, type RawGame, encodeRawGame, rawGameKey } from "../../src/lib/sources/riot";
import { FsStore, type ObjectStore, R2Store } from "../../src/lib/storage";
import { type RiotGameRow, fetchRiotGames, loadIngame } from "./riot";

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
