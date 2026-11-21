import { createHash } from "node:crypto";

const CDN = "https://static.wikia.nocookie.net/lolesports_gamepedia_en/images";

export function wikiImageUrl(file: string, width: number): string {
  const name = file.replace(/ /g, "_");
  const md5 = createHash("md5").update(name).digest("hex");

  return `${CDN}/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(name)}/revision/latest/scale-to-width-down/${width}`;
}
