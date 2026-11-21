import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { getCache } from "@vercel/functions";
import { summarizeGame } from "./data/ingame";
import { TIMELINE_FORMAT } from "../src/lib/sources/timeline";
import { gameNumberOf, phaseOf, routeQuestion } from "../src/lib/agent/query";
import type { Entities } from "../src/lib/agent/types";
import type { Json } from "../src/lib/json";
import { RAW_GAME_FORMAT, type RawGame, encodeRawGame, rawGameKey } from "../src/lib/sources/riot";
import { parseTimeline } from "../src/lib/sources/timeline";
import { loadTimeline, resetTimelineStore } from "../src/lib/storage/timelines";

const PIDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const teamOf = (pid: number) => (pid <= 5 ? 100 : 200);

/** A frame at minute m: team 100 gets `lead` more gold per player than team 200. */
function frame(m: number, lead: number, events: Json[], v4: boolean, level = 1) {
  const participantFrames: { [pid: string]: Json } = {};

  for (const pid of PIDS) {
    const stats = { totalGold: 500 + 300 * m + (teamOf(pid) === 100 ? lead : 0), level, xp: 0, minionsKilled: 0 };

    // match-v4 frames carry no participantId in some games: the key is the id.
    participantFrames[String(pid)] = v4 ? stats : { participantId: pid, ...stats };
  }

  return { timestamp: m * 60_000, participantFrames, events } satisfies Json;
}

function rawGame(version: 4 | 5, stats: Json, timeline: Json): RawGame {
  return {
    format: RAW_GAME_FORMAT,
    key: `TEST_V${version}`,
    gameId: `Test/2026 Season_Finals_1_${version}`,
    version,
    statsPage: `V${version} data:TEST V${version}`,
    timelinePage: timeline ? `V${version} data:TEST V${version}/Timeline` : null,
    statsRevid: 1,
    timelineRevid: 2,
    fetchedAt: "2026-11-14T00:00:00.000Z",
    stats,
    timeline,
  };
}

const kill = (s: number, killerId: number, victimId: number): Json => ({ type: "CHAMPION_KILL", timestamp: s * 1000, killerId, victimId, assistingParticipantIds: [] });

/** match-v5, wrapped as { metadata, info } like some Leaguepedia pages. */
function v5Game(): RawGame {
  const stats = {
    metadata: { matchId: "TEST_V5" },
    info: {
      gameDuration: 1500,
      participants: PIDS.map((pid) => ({ participantId: pid, teamId: teamOf(pid), championId: pid, championName: `C${pid}` })),
      teams: [
        { teamId: 100, win: true },
        { teamId: 200, win: false },
      ],
    },
  };

  const timeline = {
    metadata: { matchId: "TEST_V5" },
    info: {
      frameInterval: 60_000,
      frames: [
        frame(0, 0, [], false),
        frame(1, 100, [kill(65, 0, 7), { type: "SOME_FUTURE_EVENT", timestamp: 70_000 }, { type: "CHAMPION_KILL" }], false),
        frame(2, 200, [
          { type: "ELITE_MONSTER_KILL", timestamp: 125_000, killerId: 8, killerTeamId: 200, monsterType: "HORDE" },
          { type: "ELITE_MONSTER_KILL", timestamp: 150_000, killerId: 8, killerTeamId: 200, monsterType: "HORDE" },
          { type: "ELITE_MONSTER_KILL", timestamp: 170_000, killerId: 9, killerTeamId: 200, monsterType: "HORDE" },
          { type: "ELITE_MONSTER_KILL", timestamp: 175_000, killerId: 2, killerTeamId: 100, monsterType: "DRAGON", monsterSubType: "FIRE_DRAGON" },
        ], false),
        // Team 200 wiped in 8 s at level 1 (10 s respawn): an ace for team 100.
        frame(3, -400, [kill(181, 1, 6), kill(183, 2, 7), kill(185, 3, 8), kill(187, 4, 9), kill(189, 5, 10)], false),
        frame(4, 900, [
          { type: "BUILDING_KILL", timestamp: 245_000, killerId: 0, teamId: 200, buildingType: "TOWER_BUILDING", laneType: "BOT_LANE", towerType: "OUTER_TURRET" },
          { type: "BUILDING_KILL", timestamp: 250_000, killerId: 3, teamId: 200, buildingType: "INHIBITOR_BUILDING", laneType: "MID_LANE", towerType: "UNDEFINED_TURRET" },
          { type: "ELITE_MONSTER_KILL", timestamp: 255_000, killerId: 1, killerTeamId: 100, monsterType: "RIFTHERALD" },
          { type: "ELITE_MONSTER_KILL", timestamp: 256_000, killerId: 1, killerTeamId: 100, monsterType: "BARON_NASHOR" },
          { type: "ELITE_MONSTER_KILL", timestamp: 257_000, killerId: 6, killerTeamId: 200, monsterType: "DRAGON", monsterSubType: "ELDER_DRAGON" },
          { type: "ELITE_MONSTER_KILL", timestamp: 258_000, killerId: 7, killerTeamId: 200, monsterType: "ATAKHAN" },
          { type: "BUILDING_KILL", timestamp: 259_000, killerId: 7, teamId: 100, buildingType: "TOWER_BUILDING", laneType: "MID_LANE", towerType: "NEXUS_TURRET" },
        ], false),
        { ...frame(4, 1000, [{ type: "GAME_END", timestamp: 262_000, winningTeam: 100 }], false), timestamp: 262_000 },
      ],
    },
  };

  return rawGame(5, stats, timeline);
}

/**
 * match-v4: teams win "Win"/"Fail", monsters credited through the killer, gameDuration in ms.
 * Minute 2 holds five deaths of team 100 (overridable), at champion level `level2`.
 */
function v4Game(level2 = 1, deaths2 = [kill(121, 6, 1), kill(150, 6, 2), kill(160, 6, 3), kill(170, 6, 4), kill(175, 7, 5)]): RawGame {
  const stats = {
    gameDuration: 1_830_000,
    participants: PIDS.map((pid) => ({ participantId: pid, teamId: teamOf(pid), championId: pid, stats: { kills: 0, deaths: 0, assists: 0 } })),
    participantIdentities: PIDS.map((pid) => ({ participantId: pid, player: { summonerName: `P${pid}` } })),
    teams: [
      { teamId: 100, win: "Fail" },
      { teamId: 200, win: "Win" },
    ],
  };

  const timeline = {
    frameInterval: 60_000,
    frames: [
      frame(0, 0, [], true),
      frame(1, -50, [
        kill(70, 8, 2),
        { type: "ELITE_MONSTER_KILL", timestamp: 80_000, killerId: 9, monsterType: "DRAGON", monsterSubType: "WATER_DRAGON" },
        // No champion killer: left out.
        { type: "ELITE_MONSTER_KILL", timestamp: 85_000, killerId: 0, monsterType: "DRAGON", monsterSubType: "AIR_DRAGON" },
        { type: "ELITE_MONSTER_KILL", timestamp: 95_000, killerId: 4, monsterType: "RIFTHERALD" },
      ], true),
      frame(2, -300, deaths2, true, level2),
      frame(3, -800, [
        { type: "BUILDING_KILL", timestamp: 190_000, killerId: 10, teamId: 100, buildingType: "TOWER_BUILDING", laneType: "TOP_LANE", towerType: "INNER_TURRET" },
      ], true),
    ],
  };

  return rawGame(4, stats, timeline);
}

test("match-v5: gold difference per frame and every key event, with its team", () => {
  const t = parseTimeline(v5Game())!;

  expect(t.version).toBe(5);
  expect(t.durationS).toBe(1500);
  expect(t.winner).toBe(100);
  // 5 players × the per-player lead, team 100 minus team 200; the last frame is the end of the game.
  expect(t.gold).toEqual([
    { s: 0, diff: 0 },
    { s: 60, diff: 500 },
    { s: 120, diff: 1000 },
    { s: 180, diff: -2000 },
    { s: 240, diff: 4500 },
    { s: 262, diff: 5000 },
  ]);
  expect(t.events.map((e) => [e.s, e.kind, e.team, e.detail])).toEqual([
    // An execution (killer 0) at 65 s is no first blood: the first kill by a champion is.
    [125, "grubs", 200, "3 larves"],
    [175, "dragon", 100, "infernal"],
    [181, "first_blood", 100, null],
    [189, "ace", 100, null],
    // BUILDING_KILL names the team that lost the building.
    [245, "tower", 100, "extérieure bot"],
    [250, "inhibitor", 100, "mid"],
    [255, "herald", 100, null],
    [256, "baron", 100, null],
    [257, "elder", 200, null],
    [258, "atakhan", 200, null],
    [259, "tower", 200, "du Nexus"],
  ]);
});

test("match-v4: monsters through the killer's team, milliseconds duration, no ace when deaths do not overlap", () => {
  // Level 18 at minute 2: respawn 52.5 s, so player 1 (dead at 2:01) is back at 2:53, before the fifth death at 2:55.
  const t = parseTimeline(v4Game(18))!;

  expect(t.version).toBe(4);
  expect(t.durationS).toBe(1830);
  expect(t.winner).toBe(200);
  expect(t.gold.map((g) => g.diff)).toEqual([0, -250, -1500, -4000]);
  expect(t.events.map((e) => [e.s, e.kind, e.team, e.detail])).toEqual([
    [70, "first_blood", 200, null],
    [80, "dragon", 200, "océan"],
    [95, "herald", 100, null],
    [190, "tower", 200, "intérieure top"],
  ]);
});

test("match-v4: the same five deaths at level 1 are an ace", () => {
  const t = parseTimeline(v4Game())!;

  // Level 1 (10 s): the deaths at 2:01 … 2:55 never overlap either.
  expect(t.events.some((e) => e.kind === "ace")).toBe(false);

  const wipe = [kill(121, 6, 1), kill(122, 6, 2), kill(124, 6, 3), kill(126, 6, 4), kill(128, 7, 5), kill(129, 7, 5)];
  const aces = parseTimeline(v4Game(1, wipe))!.events.filter((e) => e.kind === "ace");

  // One ace per wipe, even if the event list repeats a death.
  expect(aces).toEqual([{ s: 128, kind: "ace", team: 200, detail: null }]);
});

// --- First blood: one credited event for the timeline and the in-game summary ------------------

type FirstBloodCase = { kills: Json[]; killer?: number; team?: 100 | 200; killers?: number[]; denied?: boolean };

/** A game with only `kills` in its timeline and Riot's first-blood flags, match-v5 fields or match-v4 nested stats. */
function firstBloodGame(version: 4 | 5, { kills, killer, team, killers = killer == null ? [] : [killer], denied = false }: FirstBloodCase): RawGame {
  const participants = PIDS.map((pid) => {
    const base = { participantId: pid, teamId: teamOf(pid), championId: pid };

    // Without flags the fields are absent, as in some old match-v4 games.
    if (!killers.length && !denied) return base;
    const flag = { firstBloodKill: killers.includes(pid) };

    return version === 5 ? { ...base, ...flag } : { ...base, stats: flag };
  });

  const teams = [100, 200].map((teamId): Json =>
    team == null && !denied
      ? { teamId, win: teamId === 100 }
      : version === 5
        ? { teamId, win: teamId === 100, objectives: { champion: { first: teamId === team, kills: 0 } } }
        : { teamId, win: teamId === 100 ? "Win" : "Fail", firstBlood: teamId === team },
  );

  return rawGame(version, { gameDuration: version === 5 ? 1500 : 1_500_000, participants, teams }, { frames: [frame(0, 0, [], version === 4), frame(1, 0, kills, version === 4), frame(2, 0, [], version === 4)] });
}

/** First blood as the timeline and the summary see it: [second, team] of the event, and the victim's pid. */
function firstBloodOf(game: RawGame) {
  const event = parseTimeline(game)!.events.find((e) => e.kind === "first_blood");
  const summary = summarizeGame(game);
  const victims = summary.players.filter((p) => p.first_blood_victim === 1).map((p) => p.pid);

  return {
    event: event ? [event.s, event.team] : null,
    victim: summary.players.every((p) => p.first_blood_victim == null) ? null : victims,
  };
}

const execution = (s: number, victimId: number) => kill(s, 0, victimId);

for (const version of [4, 5] as const) {
  test(`match-v${version}: an execution before the credited kill, both consumers agree on the kill Riot credits`, () => {
    // TRKR1_610063 (Worlds 2016): player 1 executed at 2:13, first blood for player 3 at 9:46, Riot flags agree.
    const game = firstBloodGame(version, { kills: [execution(70, 1), kill(100, 3, 8), kill(110, 8, 3)], killer: 3, team: 100 });

    expect(firstBloodOf(game)).toEqual({ event: [100, 100], victim: [8] });
  });

  test(`match-v${version}: an ordinary first kill; without Riot flags it still counts`, () => {
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(70, 7, 2), kill(80, 1, 6)], killer: 7, team: 200 }))).toEqual({ event: [70, 200], victim: [2] });
    expect(firstBloodOf(firstBloodGame(version, { kills: [execution(60, 4), kill(70, 7, 2)] }))).toEqual({ event: [70, 200], victim: [2] });
  });

  test(`match-v${version}: only executions, or flags that name another kill: no first blood, no victim`, () => {
    expect(firstBloodOf(firstBloodGame(version, { kills: [execution(70, 1), execution(80, 6)] }))).toEqual({ event: null, victim: null });
    // Riot credits player 9, the first readable kill is player 3's: unknown, never the later plausible kill.
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(70, 3, 8), kill(80, 9, 2)], killer: 9, team: 200 }))).toEqual({ event: null, victim: null });
    // Killer flag and team flag disagree with each other.
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(70, 3, 8)], killer: 3, team: 200 }))).toEqual({ event: null, victim: null });
    // Two players flagged.
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(70, 3, 8)], killers: [3, 4] }))).toEqual({ event: null, victim: null });
    // Every player and both teams explicitly denied first blood (flags present, all false).
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(70, 3, 8)], killers: [], denied: true }))).toEqual({ event: null, victim: null });
  });

  test(`match-v${version}: an unreadable kill before the first readable one makes first blood unknown`, () => {
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(60, 3, 0), kill(70, 3, 8)], killer: 3, team: 100 }))).toEqual({ event: null, victim: null });
    expect(firstBloodOf(firstBloodGame(version, { kills: [kill(60, 3, 4), kill(70, 3, 8)], killer: 3, team: 100 }))).toEqual({ event: null, victim: null });
    // A kill without a killer id is unreadable, not an execution.
    expect(firstBloodOf(firstBloodGame(version, { kills: [{ type: "CHAMPION_KILL", timestamp: 60_000, victimId: 2, assistingParticipantIds: [] }, kill(70, 7, 3)] }))).toEqual({ event: null, victim: null });
  });
}

test("an execution still counts as a death for an ace", () => {
  // Team 100 dies in 8 s at level 1, the first death an execution: the ace is still team 200's.
  const kills = [execution(121, 1), kill(123, 6, 2), kill(125, 6, 3), kill(127, 6, 4), kill(129, 7, 5)];
  const events = parseTimeline(firstBloodGame(5, { kills, killer: 6, team: 200 }))!.events;

  expect(events.map((e) => [e.s, e.kind, e.team])).toEqual([[123, "first_blood", 200], [129, "ace", 200]]);
});

test("a game without timeline parses to null, a timeline without frames throws", () => {
  expect(parseTimeline({ ...v5Game(), timeline: null })).toBeNull();
  expect(() => parseTimeline({ ...v5Game(), timeline: { frames: [] } })).toThrow();
});

// --- Loading: read-only R2 credentials, then the cache ---------------------------------------

const objects = new Map([[rawGameKey("TEST_V5"), encodeRawGame(v5Game())]]);
const seen: { method: string; key: string; credential: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
const envKeys = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_READ_ACCESS_KEY_ID", "R2_READ_SECRET_ACCESS_KEY"] as const;
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
      seen.push({ method: req.method, key, credential: /Credential=([^/]+)/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "" });
      const body = objects.get(key);

      return body ? new Response(new Uint8Array(body)) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    },
  });

  Object.assign(process.env, {
    R2_ACCOUNT_ID: "test",
    R2_BUCKET: "bucket",
    R2_ENDPOINT: `http://localhost:${server.port}`,
    // The ingestion write key must never be used by the app.
    R2_ACCESS_KEY_ID: "WRITE_KEY",
    R2_SECRET_ACCESS_KEY: "write-secret",
    R2_READ_ACCESS_KEY_ID: "READ_KEY",
    R2_READ_SECRET_ACCESS_KEY: "read-secret",
  });
  resetTimelineStore();
});

afterAll(() => {
  server.stop(true);

  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  resetTimelineStore();
});

beforeEach(async () => {
  seen.length = 0;
  resetTimelineStore();
  const cache = getCache({ namespace: "lolesport" });
  await Promise.all(["TEST_V5", "TEST_ABSENT"].map(key => cache.delete(`timeline:v${TIMELINE_FORMAT}:${key}`)));
});

test("a timeline is read from R2 with the read-only key, then served from the cache", async () => {
  const first = await loadTimeline("TEST_V5");

  expect(first.status).toBe("ok");
  expect(first.status === "ok" && first.source).toBe("r2");
  expect(first.status === "ok" && first.timeline.events.length).toBe(11);
  expect(seen).toEqual([{ method: "GET", key: rawGameKey("TEST_V5"), credential: "READ_KEY" }]);

  const second = await loadTimeline("TEST_V5");

  if (first.status !== "ok" || second.status !== "ok") throw new Error("expected two timelines");

  expect(second.source).toBe("cache");
  expect(second.timeline).toEqual(first.timeline);
  expect(seen).toHaveLength(1);
});

test("a game missing from R2 is reported missing, and remembered", async () => {
  expect(await loadTimeline("TEST_ABSENT")).toMatchObject({ status: "missing", source: "r2" });
  expect(await loadTimeline("TEST_ABSENT")).toMatchObject({ status: "missing", source: "cache" });
  expect(seen.filter((s) => s.key === rawGameKey("TEST_ABSENT"))).toHaveLength(1);
});

// --- Routing ---------------------------------------------------------------------------------

test("game number and stage of the series are read from the question", () => {
  expect(gameNumberOf("timeline de T1 vs Gen.G finale Worlds 2024 game 3")).toBe(3);
  expect(gameNumberOf("courbe d'or de la game 5 de la finale MSI 2023")).toBe(5);
  expect(gameNumberOf("la 2e partie de la finale")).toBe(2);
  expect(gameNumberOf("troisième manche de T1 contre BLG")).toBe(3);
  // "G2" is a team, not game 2.
  expect(gameNumberOf("G2 contre Fnatic en LEC")).toBeNull();
  expect(gameNumberOf("Faker aux Worlds 2024")).toBeNull();
  expect(phaseOf("demi-finale des Worlds")).toBe("semifinal");
  expect(phaseOf("la finale du MSI")).toBe("final");
  expect(phaseOf("petite finale")).toBe("third_place");
  expect(phaseOf("quarts de finale")).toBe("quarterfinal");
  expect(phaseOf("T1 contre Gen.G")).toBeNull();
});

const entities = (over: Partial<Entities>): Entities => ({
  players: [],
  teams: [],
  champion: null,
  unresolved: [],
  league: null,
  leagueShort: null,
  leagueMention: null,
  yearFrom: null,
  yearTo: null,
  split: null,
  outOfScope: null,
  ...over,
});

const SCHEMA = { v_games: ["game_id", "game_n", "blue_dragons"], v_game_player_stats: ["penta_kills"] };
const NO_COVERAGE = { league: () => ({ games: 0, ingame: 0 }), player: () => ({ games: 0, ingame: 0 }), team: () => ({ games: 0, ingame: 0 }) };

test("timeline questions route to game_timeline before the in-game statistics", async () => {
  const worlds = { league: "World Championship" as const, leagueShort: "Worlds", yearFrom: 2024, yearTo: 2024 };

  const teams = [
    { mention: "T1", team: "T1", members: ["T1"] },
    { mention: "Gen.G", team: "Gen.G", members: ["Gen.G"] },
  ];

  expect(await routeQuestion("timeline de T1 vs Gen.G finale Worlds 2024 game 3", entities({ ...worlds, teams }), SCHEMA, NO_COVERAGE)).toMatchObject({
    kind: "tool",
    call: { tool: "game_timeline", input: { teamA: "T1", teamB: "Gen.G", league: "World Championship", year: 2024, phase: "final", game: 3 } },
  });

  const msi = entities({ league: "Mid-Season Invitational", leagueShort: "MSI", yearFrom: 2023, yearTo: 2023 });

  expect(await routeQuestion("courbe d'or de la game 5 de la finale MSI 2023", msi, SCHEMA, NO_COVERAGE)).toMatchObject({
    call: { tool: "game_timeline", input: { teamA: null, phase: "final", game: 5 } },
  });

  // Not a single game: the usual routes.
  expect(await routeQuestion("T1 contre Gen.G aux Worlds 2024", entities({ ...worlds, teams }), SCHEMA, NO_COVERAGE)).toMatchObject({ call: { tool: "head_to_head" } });
});
