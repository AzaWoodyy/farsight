import { createHash } from "node:crypto";
import { z } from "zod";
import type { PlayerPhoto } from "../agent/types";
import { type Db, selectOne } from "../db";

/**
 * Leaguepedia headshots (table player_images), dated by the tournament they were taken for. The images are
 * fair use (Riot Games and the leagues), not CC BY-SA: the database keeps their file names only, and the page
 * shows them from Fandom's CDN at the width it needs.
 */
const CDN = "https://static.wikia.nocookie.net/lolesports_gamepedia_en/images";

/** Width served: twice the largest avatar (56 px, the player header), for high-density screens. */
const WIDTH = 112;

/** MediaWiki stores a file under the first one and two hex digits of the md5 of its name. */
export function photoUrl(file: string, width = WIDTH): string {
  const name = file.replace(/ /g, "_");
  const md5 = createHash("md5").update(name).digest("hex");

  return `${CDN}/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(name)}/revision/latest/scale-to-width-down/${width}`;
}

const Photo = z.object({ file: z.string(), taken_at: z.number() });

const PHOTOS = "SELECT i.file, i.taken_at FROM player_images i JOIN players p ON p.id = i.player_id WHERE p.page = :player";

/**
 * The player's photo of the period: the latest one taken on or before `at` (unix seconds), the earliest when
 * every photo is later, the latest when `at` is null. Null when Leaguepedia has none.
 */
export async function playerPhoto(db: Db, player: string, at: number | null): Promise<PlayerPhoto | null> {
  const row =
    (at == null ? null : await selectOne(db, Photo, `${PHOTOS} AND i.taken_at <= :at ORDER BY i.taken_at DESC, i.file LIMIT 1`, { player, at })) ??
    (await selectOne(db, Photo, `${PHOTOS} ORDER BY i.taken_at ${at == null ? "DESC" : "ASC"}, i.file LIMIT 1`, { player }));

  if (!row) return null;

  return {
    url: photoUrl(row.file),
    year: new Date(row.taken_at * 1000).getUTCFullYear(),
    source: `https://lol.fandom.com/wiki/File:${encodeURIComponent(row.file.replace(/ /g, "_"))}`,
  };
}
