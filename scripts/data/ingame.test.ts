import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Json } from "../../src/lib/json";
import { RAW_GAME_FORMAT, type RawGame } from "../../src/lib/sources/riot";
import corpus from "./fixtures/dragons.json";
import fallbacks from "./fixtures/fallbacks.json";
import { DERIVE_COMPATIBLE, DERIVE_VERSION, IngameLine, leaguepediaPatch, summarizeGame } from "./ingame";

/**
 * Real games (Leaguepedia's Riot JSON, Worlds 2014 to 2026), cut down to what the dragons read: the patch, who is on
 * which side, Riot's own dragon count per team, and the dragon and soul events of the timeline.
 */
const Game = z.object({
  key: z.string(),
  event: z.string(),
  version: z.number(),
  stats: z.object({
    gameVersion: z.string(),
    gameDuration: z.number(),
    participants: z.array(z.object({ participantId: z.number(), teamId: z.number(), championId: z.number() })),
    teams: z.array(z.object({ teamId: z.number(), dragonKills: z.number() })),
  }),
  events: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
});

const games = new Map(z.array(Game).parse(corpus).map((g) => [g.key, g]));

function raw(key: string): RawGame {
  const g = games.get(key);

  if (!g) throw new Error(`no fixture game ${key}`);

  return {
    format: RAW_GAME_FORMAT,
    key: g.key,
    gameId: `${g.event}_${g.key}`,
    version: g.version,
    statsPage: `V${g.version} data:${g.key}`,
    timelinePage: `V${g.version} data:${g.key}/Timeline`,
    statsRevid: 1,
    timelineRevid: 2,
    fetchedAt: "2026-11-17T00:00:00.000Z",
    stats: { gameVersion: g.stats.gameVersion, gameDuration: g.stats.gameDuration, participants: g.stats.participants, teams: g.stats.teams.map((t) => ({ teamId: t.teamId })) },
    timeline: { frames: [{ timestamp: 0, participantFrames: {}, events: g.events }] },
  };
}

const read = (key: string) => {
  const s = summarizeGame(raw(key));
  const team = (id: number) => s.teams.find((t) => t.teamId === id)!;

  return {
    dragons: (s.dragons ?? []).map((d) => `${d.teamId}:${d.kind}`),
    blue: [team(100).elder_dragons, team(100).dragon_soul, team(100).soul],
    red: [team(200).elder_dragons, team(200).dragon_soul, team(200).soul],
  };
};

describe("dragons and souls of real games", () => {
  test("every game: as many dragons per team as Riot's end-of-game count", () => {
    for (const g of games.values()) {
      const s = summarizeGame(raw(g.key));

      for (const t of g.stats.teams) expect({ key: g.key, team: t.teamId, dragons: s.dragons?.filter((d) => d.teamId === t.teamId).length }).toEqual({ key: g.key, team: t.teamId, dragons: t.dragonKills });
    }
  });

  test("2014, before the elements: dragons without a kind, no soul to know", () => {
    expect(read("TRLH1_1000380097")).toEqual({ dragons: ["100:null", "100:null", "200:null", "100:null"], blue: [0, null, null], red: [0, null, null] });
  });

  test("2019, patch 9.19: four elemental dragons for one team give no soul before patch 9.23", () => {
    expect(read("ESPORTSTMNT06_1070624")).toEqual({ dragons: ["100:infernal", "100:mountain", "100:mountain", "100:ocean"], blue: [0, null, null], red: [0, null, null] });
  });

  test("2020, match-v4: no soul event, the soul goes to the team with its fourth elemental dragon", () => {
    expect(read("ESPORTSTMNT03_1531302")).toEqual({ dragons: ["100:cloud", "100:mountain", "200:ocean", "100:ocean", "100:ocean"], blue: [0, 1, "ocean"], red: [0, 0, null] });
  });

  test("2021, match-v4: the elder dragon after the soul is counted apart and is not a fifth elemental dragon", () => {
    expect(read("ESPORTSTMNT04_1970577")).toEqual({
      dragons: ["200:cloud", "200:mountain", "200:infernal", "100:infernal", "200:infernal", "100:elder"],
      blue: [1, 0, null],
      red: [0, 1, "infernal"],
    });
  });

  test("2024, match-v5: the soul event names the team and the element", () => {
    expect(read("LOLTMNT05_84144")).toEqual({ dragons: ["100:hextech", "100:infernal", "100:chemtech", "100:chemtech"], blue: [0, 1, "chemtech"], red: [0, 0, null] });
  });

  test("2026: a soul event with team 0 announces the element of the map and gives no soul", () => {
    expect(read("LOLTMNT02_480511")).toEqual({ dragons: ["100:cloud", "200:ocean", "200:mountain"], blue: [0, 0, null], red: [0, 0, null] });
  });

  test("2026: the soul to the fourth dragon of a team, however many the other took, then the elder", () => {
    expect(read("LOLTMNT02_487406")).toEqual({
      dragons: ["200:chemtech", "200:mountain", "100:cloud", "100:cloud", "100:cloud", "200:cloud", "200:cloud", "100:elder"],
      blue: [1, 0, null],
      red: [0, 1, "cloud"],
    });
  });

  test("without a timeline, nothing is known", () => {
    const s = summarizeGame({ ...raw("LOLTMNT05_84144"), timeline: null });

    expect(s.dragons).toBeNull();
    expect(s.teams.map((t) => [t.elder_dragons, t.dragon_soul, t.soul])).toEqual([[null, null, null], [null, null, null]]);
  });
});

/**
 * Two real games cut down to their end-of-game stats: LCK 2019 (match-v4, a game whose Leaguepedia scoreboard has no
 * damage, vision or runes) and Worlds 2024 (match-v5).
 */
const Fallback = z.object({ key: z.string(), version: z.number(), stats: z.record(z.string(), z.json()) });

/** What the tests edit in a match-v4 game, the rest kept as is. */
const V4Game = z.object({ participants: z.array(z.object({ stats: z.record(z.string(), z.number()) }).catchall(z.json())) }).catchall(z.json());

function statsOnly(key: string): RawGame {
  const g = z.array(Fallback).parse(fallbacks).find((x) => x.key === key);

  if (!g) throw new Error(`no fixture game ${key}`);

  return {
    format: RAW_GAME_FORMAT,
    key: g.key,
    gameId: `Test_${g.key}`,
    version: g.version,
    statsPage: `V${g.version} data:${g.key}`,
    timelinePage: null,
    statsRevid: 1,
    timelineRevid: null,
    fetchedAt: "2026-11-20T00:00:00.000Z",
    stats: g.stats,
    timeline: null,
  };
}

describe("what Leaguepedia's scoreboard may lack, from the Riot JSON", () => {
  test("match-v4 (LCK 2019): damage, vision, rune page in Leaguepedia's order, heralds and game version", () => {
    const s = summarizeGame(statsOnly("ESPORTSTMNT01_1130750"));
    const [first, second] = s.players;

    expect(s.gameVersion).toBe("9.11.276.3025");
    expect(first).toMatchObject({ damage: 12265, vision: 29, runes: [8230, 8226, 8210, 8236, 8139, 8135, 5008, 5008, 5002], primary_tree: 8200, secondary_tree: 8100 });
    expect(second).toMatchObject({ damage: 4923, vision: 57, runes: [8010, 9111, 9104, 8014, 8473, 8451, 5008, 5008, 5001], primary_tree: 8000, secondary_tree: 8400 });
    expect(s.teams.map((t) => [t.teamId, t.heralds])).toEqual([[100, 0], [200, 1]]);
    expect(s.players.every((p) => p.runes?.length === 9 && p.damage != null && p.vision != null)).toBe(true);
  });

  test("match-v5 (Worlds 2024): the same fields from `perks` and `objectives`", () => {
    const s = summarizeGame(statsOnly("LOLTMNT05_84144"));

    expect(s.gameVersion).toBe("14.18.617.4123");
    expect(s.players[0]).toMatchObject({ damage: 21994, vision: 45, runes: [8229, 8275, 8210, 8237, 9105, 8017, 5007, 5008, 5001], primary_tree: 8200, secondary_tree: 8000 });
    expect(s.teams.map((t) => [t.teamId, t.heralds])).toEqual([[100, 1], [200, 0]]);
    expect(s.players.every((p) => p.runes?.length === 9)).toBe(true);
  });

  test("six runes before the stat shards (patch 8.23); from 8.23 a missing shard or any empty slot is not trusted", () => {
    const g = statsOnly("ESPORTSTMNT01_1130750");
    const stats = V4Game.parse(g.stats);
    const [a, b, c, ...rest] = stats.participants;
    const noShard = { ...a, stats: { ...a.stats, statPerk0: 0, statPerk1: 0, statPerk2: 0 } };
    const edited = [noShard, { ...b, stats: { ...b.stats, perk3: 0 } }, { ...c, stats: { ...c.stats, statPerk2: 0 } }, ...rest];
    const at = (gameVersion: string) => summarizeGame({ ...g, stats: { ...stats, gameVersion, participants: edited } }).players;

    expect(at("8.22.1")[0]).toMatchObject({ runes: [8230, 8226, 8210, 8236, 8139, 8135], primary_tree: 8200, secondary_tree: 8100 });
    expect(at("8.22.1")[2].runes).toHaveLength(6);
    expect(at("8.23.1").slice(0, 3).map((p) => [p.runes, p.primary_tree, p.secondary_tree])).toEqual([[null, null, null], [null, null, null], [null, null, null]]);
    expect(at("8.23.1")[3].runes).toHaveLength(9);
  });

  test("without a game version, a page keeps its shards; a page without them is not trusted", () => {
    const g = statsOnly("ESPORTSTMNT01_1130750");
    const { gameVersion: _v, ...stats } = V4Game.parse(g.stats);
    const [a, ...rest] = stats.participants;
    const s = summarizeGame({ ...g, stats: { ...stats, participants: [{ ...a, stats: { ...a.stats, statPerk1: 0 } }, ...rest] } });

    expect(s.gameVersion).toBeNull();
    expect(s.players[0].runes).toBeNull();
    expect(s.players[1].runes).toEqual([8010, 9111, 9104, 8014, 8473, 8451, 5008, 5008, 5001]);

    // A version that does not read as major.minor counts as none.
    const odd = summarizeGame({ ...g, stats: { ...stats, gameVersion: "8.23x" } });

    expect(odd.players[1].runes).toHaveLength(9);
  });

  test("no Herald before patch 5.22: null, not 0", () => {
    const g = statsOnly("ESPORTSTMNT01_1130750");
    const s = summarizeGame({ ...g, stats: { ...V4Game.parse(g.stats), gameVersion: "4.20.0.315" } });

    expect(s.teams.map((t) => t.heralds)).toEqual([null, null]);
  });

  test("damage and vision that nobody in the game has are not tracked: null, not 0", () => {
    const g = statsOnly("ESPORTSTMNT01_1130750");
    const stats = V4Game.parse(g.stats);
    const zeroed = stats.participants.map((p) => ({ ...p, stats: { ...p.stats, totalDamageDealtToChampions: 0, visionScore: 0 } }));
    const s = summarizeGame({ ...g, stats: { ...stats, participants: zeroed } });

    expect(s.players.map((p) => [p.damage, p.vision])).toEqual(Array.from({ length: 10 }, () => [null, null]));
  });
});

test("Leaguepedia's patch of a Riot game version, up to season 14 only", () => {
  expect(["9.11.276.3025", "4.21.0.302", "10.1.304.5432", "14.18.617.4123", "15.9.678.2101", "", null].map(leaguepediaPatch)).toEqual(["9.11", "4.21", "10.1", "14.18", null, null, null]);
});

describe("summaries of an older derive version", () => {
  test("a line without the dragon fields still parses", () => {
    const { dragons: _dragons, ...old } = summarizeGame(raw("LOLTMNT05_84144"));
    const line = IngameLine.parse({ ...old, derive: 2, teams: old.teams.map(({ elder_dragons: _e, dragon_soul: _d, soul: _s, ...t }) => t) });

    expect(line.status === "ok" && line.dragons).toBeUndefined();
  });

  test("derive 5 changed existing numbers (minute statistics, first-blood victim): no older summary is kept", () => {
    expect([DERIVE_VERSION, DERIVE_COMPATIBLE]).toEqual([5, 5]);
  });

  test("a derive 3 line, without the Leaguepedia fallbacks of derive 4, still parses", () => {
    const { gameVersion: _v, ...old } = summarizeGame(raw("LOLTMNT05_84144"));

    const line = IngameLine.parse({
      ...old,
      derive: 3,
      players: old.players.map(({ damage: _d, vision: _vi, runes: _r, primary_tree: _p, secondary_tree: _s, ...p }) => p),
      teams: old.teams.map(({ heralds: _h, ...t }) => t),
    });

    expect(line.status === "ok" && [line.gameVersion, line.players[0].runes, line.teams[0].heralds]).toEqual([undefined, undefined, undefined]);
  });
});

// --- Minute statistics: only for a game that reached the minute ------------------------------

const PIDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const sideOf = (pid: number) => (pid <= 5 ? 100 : 200);

/** A frame at `ms`: every player has 1 000 gold, XP and CS per minute played, plus `extra`. */
function minuteFrame(ms: number, events: Json[] = [], extra = 0): Json {
  const value = Math.floor(ms / 60_000) * 1000 + extra;
  const participantFrames: { [pid: string]: Json } = {};

  for (const pid of PIDS) participantFrames[String(pid)] = { participantId: pid, totalGold: value, xp: value, minionsKilled: value, jungleMinionsKilled: 0 };

  return { timestamp: ms, participantFrames, events };
}

const championKill = (ms: number, killerId: number, victimId: number) => ({ type: "CHAMPION_KILL", timestamp: ms, killerId, victimId, assistingParticipantIds: [] });
const towerLost = (ms: number, teamId: number) => ({ type: "BUILDING_KILL", timestamp: ms, killerId: 1, teamId, buildingType: "TOWER_BUILDING" });

/**
 * A game with one frame per minute up to `fullMinutes` (`lateMs` after each minute, as in match-v5), then the last
 * frame at `lastMs` (the end of the game in match-v5), and the given duration (seconds, or milliseconds in legacy JSON).
 * Kills at 5:00, 14:00 and 19:30 by team 100, a tower lost by team 200 at 14:30.
 */
function minuteGame(opts: { version?: 4 | 5; duration?: number; fullMinutes: number; lateMs?: number; lastMs?: number | null; skip?: number[]; timeline?: boolean }): RawGame {
  const { version = 5, duration, fullMinutes, lateMs = 300, lastMs = null, skip = [], timeline = true } = opts;
  const events = [championKill(300_000, 1, 6), championKill(840_000, 2, 7), towerLost(870_000, 200), championKill(1_170_000, 3, 8)];
  const times = Array.from({ length: fullMinutes + 1 }, (_, m) => (m === 0 ? 0 : m * 60_000 + lateMs)).filter((_, m) => !skip.includes(m));

  if (lastMs != null) times.push(lastMs);

  // Each event in the first frame after it (the last frame for those after every frame).
  const frameOf = (e: { timestamp: number }) => {
    const i = times.findIndex((ms) => ms > e.timestamp);

    return i === -1 ? times.length - 1 : i;
  };

  const frames = times.map((ms, i) => minuteFrame(ms, events.filter((e) => frameOf(e) === i), ms === lastMs ? 500 : 0));

  const players = { participants: PIDS.map((pid) => ({ participantId: pid, teamId: sideOf(pid), championId: pid })), teams: [{ teamId: 100 }, { teamId: 200 }] };
  const stats = duration == null ? players : { ...players, gameDuration: duration };

  return {
    format: RAW_GAME_FORMAT,
    key: "TEST_MINUTES",
    gameId: "Test_minutes",
    version,
    statsPage: `V${version} data:TEST MINUTES`,
    timelinePage: timeline ? `V${version} data:TEST MINUTES/Timeline` : null,
    statsRevid: 1,
    timelineRevid: timeline ? 2 : null,
    fetchedAt: "2026-11-21T00:00:00.000Z",
    stats,
    timeline: timeline ? { frames } : null,
  };
}

const minutes = (g: RawGame) => {
  const s = summarizeGame(g);
  const [p] = s.players;
  const blue = s.teams.find((t) => t.teamId === 100)!;

  return {
    player: [p.gold_10, p.gold_15, p.gold_20, p.xp_20, p.cs_20],
    events: [p.kills_10, p.deaths_10],
    blue: [blue.gold_20, blue.kills_10, blue.kills_15, blue.kills_20, blue.towers_15],
  };
};

describe("minute statistics of a game that ended before the minute", () => {
  test("match-v5 over at 19:46 (G2–Gen.G, MSI 2023): its last frame, about 20:00, is no observation at 20:00", () => {
    expect(minutes(minuteGame({ duration: 1186, fullMinutes: 19, lastMs: 1_186_622 }))).toEqual({
      player: [10_000, 15_000, null, null, null],
      events: [1, 0],
      blue: [null, 1, 2, null, 1],
    });
  });

  test("a game over at exactly 20:00 keeps its 20:00 frame", () => {
    expect(minutes(minuteGame({ duration: 1200, fullMinutes: 19, lastMs: 1_200_400 })).player).toEqual([10_000, 15_000, 20_500, 20_500, 20_500]);
    // match-v4: legacy milliseconds duration, frames on the minute, the last one at 20:00.
    expect(minutes(minuteGame({ version: 4, duration: 1_200_000, fullMinutes: 20, lateMs: 0 })).blue).toEqual([100_000, 1, 2, 3, 1]);
  });

  test("after 20:00 the 20:00 frame is used, not the end of the game", () => {
    expect(minutes(minuteGame({ duration: 1250, fullMinutes: 20, lastMs: 1_250_500 }))).toEqual({
      player: [10_000, 15_000, 20_000, 20_000, 20_000],
      events: [1, 0],
      blue: [100_000, 1, 2, 3, 1],
    });
  });

  test("19:59.9 is not 20:00: the duration is compared in milliseconds, never rounded up", () => {
    expect(minutes(minuteGame({ version: 4, duration: 1_199_900, fullMinutes: 20, lateMs: 0 })).blue).toEqual([null, 1, 2, null, 1]);
  });

  test("over before 15:00: no snapshot, no count at 15 or 20, the 10-minute window still counted", () => {
    expect(minutes(minuteGame({ duration: 877, fullMinutes: 14, lastMs: 877_649 }))).toEqual({
      player: [10_000, null, null, null, null],
      events: [1, 0],
      blue: [null, 1, null, null, null],
    });
  });

  test("a missing frame inside the timeline: each minute is found by its time, a missing minute stays null", () => {
    expect(minutes(minuteGame({ duration: 1250, fullMinutes: 20, lastMs: 1_250_500, skip: [12] })).player).toEqual([10_000, 15_000, 20_000, 20_000, 20_000]);
    expect(minutes(minuteGame({ duration: 1250, fullMinutes: 20, lastMs: 1_250_500, skip: [15] })).player).toEqual([10_000, null, 20_000, 20_000, 20_000]);
  });

  test("without a duration, the timeline's last frame decides", () => {
    expect(minutes(minuteGame({ fullMinutes: 19, lastMs: 1_186_622 })).blue).toEqual([null, 1, 2, null, 1]);
    expect(minutes(minuteGame({ fullMinutes: 20, lastMs: 1_250_500 })).blue).toEqual([100_000, 1, 2, 3, 1]);
  });

  test("a duration past the minute does not make up a timeline that stopped before it", () => {
    expect(minutes(minuteGame({ duration: 1250, fullMinutes: 19, lastMs: 1_150_000 })).blue).toEqual([null, 1, 2, null, 1]);
  });

  test("a game without kills keeps true zeros; without a timeline everything is null", () => {
    const quiet = minuteGame({ duration: 1250, fullMinutes: 20, lastMs: 1_250_500 });
    const frames = z.object({ frames: z.array(z.object({}).catchall(z.json())) }).parse(quiet.timeline).frames.map((f) => ({ ...f, events: [] }));

    expect(minutes({ ...quiet, timeline: { frames } }).blue).toEqual([100_000, 0, 0, 0, 0]);
    expect(minutes(minuteGame({ duration: 1250, fullMinutes: 20, timeline: false }))).toEqual({
      player: [null, null, null, null, null],
      events: [null, null],
      blue: [null, null, null, null, null],
    });
  });
});
