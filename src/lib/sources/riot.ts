import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { JsonSchema } from "../json";
import type { ObjectStore } from "../storage";

/**
 * Riot game JSON as Leaguepedia hosts it: for each game listed in the Cargo
 * table `PostgameJsonMetadata`, a stats page (`V5 data:LOLTMNT02 462538`,
 * match-v4 or match-v5 shape) and its timeline (`…/Timeline`, one frame per
 * minute plus every event).
 *
 * One object per game, gzip-compressed JSON, under `games/<RiotPlatformGameId>.json.gz`,
 * in the local cache (data/raw/riot) and in the R2 bucket alike.
 */

/** Version of the stored object's shape. */
export const RAW_GAME_FORMAT = 1;

export const RawGame = z.object({
  format: z.literal(RAW_GAME_FORMAT),
  /** RiotPlatformGameId, e.g. LOLTMNT02_462538. */
  key: z.string(),
  /** Leaguepedia ScoreboardGames.GameId. */
  gameId: z.string(),
  /** Riot API version of the JSON: 4 (match-v4) or 5 (match-v5). */
  version: z.number().int(),
  statsPage: z.string(),
  timelinePage: z.string().nullable(),
  statsRevid: z.number().int().nullable(),
  timelineRevid: z.number().int().nullable(),
  fetchedAt: z.string(),
  stats: JsonSchema,
  /** Null when the wiki has no timeline page for the game. */
  timeline: JsonSchema.nullable(),
});

export type RawGame = z.infer<typeof RawGame>;

const SAFE = /^[\w.-]+$/;

export function rawGameKey(key: string): string {
  if (!SAFE.test(key)) throw new Error(`Unexpected Riot game key: ${key}`);

  return `games/${key}.json.gz`;
}

export const RAW_GAME_CONTENT_TYPE = "application/gzip";

export function encodeRawGame(game: RawGame): Uint8Array {
  return gzipSync(JSON.stringify(game), { level: 9 });
}

export function decodeRawGame(body: Uint8Array): RawGame {
  return RawGame.parse(JSON.parse(gunzipSync(body).toString("utf8")));
}

/** One game's Riot JSON from a store (local cache or R2), or null when the store does not have it. */
export async function loadRawGame(store: Pick<ObjectStore, "get">, key: string): Promise<RawGame | null> {
  const body = await store.get(rawGameKey(key));

  return body ? decodeRawGame(body) : null;
}
