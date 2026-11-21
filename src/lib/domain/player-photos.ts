import { z } from "zod";
import type { PlayerPhoto } from "../agent/types";
import { type Db, selectOne } from "../db";
import { wikiImageUrl } from "./wiki-images";

const WIDTH = 112;

export const UNDATED_PHOTO = 0;

const Photo = z.object({ file: z.string(), taken_at: z.number() });

const PHOTOS = "SELECT i.file, i.taken_at FROM player_images i JOIN players p ON p.id = i.player_id WHERE p.page = :player";

export async function playerPhoto(db: Db, player: string, at: number | null): Promise<PlayerPhoto | null> {
  const row =
    (at == null ? null : await selectOne(db, Photo, `${PHOTOS} AND i.taken_at <= :at ORDER BY i.taken_at DESC, i.file LIMIT 1`, { player, at })) ??
    (await selectOne(db, Photo, `${PHOTOS} ORDER BY i.taken_at ${at == null ? "DESC" : "ASC"}, i.file LIMIT 1`, { player }));

  if (!row) return null;

  return {
    url: wikiImageUrl(row.file, WIDTH),
    year: row.taken_at === UNDATED_PHOTO ? null : new Date(row.taken_at * 1000).getUTCFullYear(),
    source: `https://lol.fandom.com/wiki/File:${encodeURIComponent(row.file.replace(/ /g, "_"))}`,
  };
}
