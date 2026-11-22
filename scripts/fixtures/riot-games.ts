import { RAW_GAME_FORMAT, type RawGame } from "../../src/lib/sources/riot";
import type { RiotGameRow } from "../data/riot";

export function riotGame(key: string): RawGame {
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

export const riotRow = (key: string): RiotGameRow => ({
  Key: key,
  GameId: `Test/2026 Season_${key}`,
  StatsPage: `V5 data:${key.replace("_", " ")}`,
  TimelinePage: `V5 data:${key.replace("_", " ")}/Timeline`,
  Version: 5,
  Page: "Test/2026 Season",
  League: "Test",
});
