import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { JsonSchema } from "../json";
import type { ObjectStore } from "../storage";

export const RAW_GAME_FORMAT = 1;

export const RawGame = z.object({
  format: z.literal(RAW_GAME_FORMAT),
  key: z.string(),
  gameId: z.string(),
  version: z.number().int(),
  statsPage: z.string(),
  timelinePage: z.string().nullable(),
  statsRevid: z.number().int().nullable(),
  timelineRevid: z.number().int().nullable(),
  fetchedAt: z.string(),
  stats: JsonSchema,
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

export async function loadRawGame(store: Pick<ObjectStore, "get">, key: string): Promise<RawGame | null> {
  const body = await store.get(rawGameKey(key));

  return body ? decodeRawGame(body) : null;
}
