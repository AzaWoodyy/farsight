import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RAW_GAME_FORMAT, type RawGame } from "../../src/lib/sources/riot";
import corpus from "./fixtures/dragons.json";
import fallbacks from "./fixtures/fallbacks.json";
import { DERIVE_COMPATIBLE, DERIVE_VERSION, IngameLine, summarizeGame } from "./ingame";

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

  test("a page without stat shards keeps its six runes; a page with an empty slot is not trusted", () => {
    const g = statsOnly("ESPORTSTMNT01_1130750");
    const stats = V4Game.parse(g.stats);
    const [a, b, ...rest] = stats.participants;
    const edited = [{ ...a, stats: { ...a.stats, statPerk0: 0, statPerk1: 0, statPerk2: 0 } }, { ...b, stats: { ...b.stats, perk3: 0 } }, ...rest];
    const s = summarizeGame({ ...g, stats: { ...stats, participants: edited } });

    expect(s.players[0]).toMatchObject({ runes: [8230, 8226, 8210, 8236, 8139, 8135], primary_tree: 8200, secondary_tree: 8100 });
    expect(s.players[1]).toMatchObject({ runes: null, primary_tree: null, secondary_tree: null });
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

describe("summaries of an older derive version", () => {
  test("a line without the dragon fields still parses, and is the oldest version the build keeps", () => {
    const { dragons: _dragons, ...old } = summarizeGame(raw("LOLTMNT05_84144"));
    const line = IngameLine.parse({ ...old, derive: DERIVE_COMPATIBLE, teams: old.teams.map(({ elder_dragons: _e, dragon_soul: _d, soul: _s, ...t }) => t) });

    expect(line.status === "ok" && line.dragons).toBeUndefined();
    expect(DERIVE_COMPATIBLE).toBeLessThan(DERIVE_VERSION);
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
