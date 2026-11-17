import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RAW_GAME_FORMAT, type RawGame } from "../../src/lib/sources/riot";
import corpus from "./fixtures/dragons.json";
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

describe("summaries of an older derive version", () => {
  test("a line without the dragon fields still parses, and is the oldest version the build keeps", () => {
    const { dragons: _dragons, ...old } = summarizeGame(raw("LOLTMNT05_84144"));
    const line = IngameLine.parse({ ...old, derive: DERIVE_COMPATIBLE, teams: old.teams.map(({ elder_dragons: _e, dragon_soul: _d, soul: _s, ...t }) => t) });

    expect(line.status === "ok" && line.dragons).toBeUndefined();
    expect(DERIVE_COMPATIBLE).toBeLessThan(DERIVE_VERSION);
  });
});
