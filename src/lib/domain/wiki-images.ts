import { createHash } from "node:crypto";

/**
 * Images Leaguepedia hosts that are not CC BY-SA (team logos, Riot's dragon icons): fair use, so the code and
 * the database keep file names only, and the browser loads the image from Fandom's CDN at the width it needs.
 */
const CDN = "https://static.wikia.nocookie.net/lolesports_gamepedia_en/images";

/** MediaWiki stores a file under the first one and two hex digits of the md5 of its name. */
export function wikiImageUrl(file: string, width: number): string {
  const name = file.replace(/ /g, "_");
  const md5 = createHash("md5").update(name).digest("hex");

  return `${CDN}/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(name)}/revision/latest/scale-to-width-down/${width}`;
}
