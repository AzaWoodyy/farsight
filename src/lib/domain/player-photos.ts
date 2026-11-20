import { z } from "zod";
import type { PlayerPhoto } from "../agent/types";
import { type Db, selectOne } from "../db";
import { wikiImageUrl } from "./wiki-images";

/**
 * Leaguepedia headshots (table player_images), dated by the tournament they were taken for. The images are
 * fair use (Riot Games and the leagues), not CC BY-SA: the database keeps their file names only, and the page
 * shows them from Fandom's CDN at the width it needs.
 * The CDN serves twice the largest avatar width (56 px).
 */
const WIDTH = 112;

/** `taken_at` of a headshot Leaguepedia does not date: the oldest date, kept only for a player who has no other. */
export const UNDATED_PHOTO = 0;

const Photo = z.object({ file: z.string(), taken_at: z.number() });

const PHOTOS = "SELECT i.file, i.taken_at FROM player_images i JOIN players p ON p.id = i.player_id WHERE p.page = :player";

/**
 * The player's photo of the period: the latest one taken on or before `at` (unix seconds), the earliest when
 * every photo is later, the latest when `at` is null. Null when Leaguepedia has none. An undated photo has no year.
 */
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
