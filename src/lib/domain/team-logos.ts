import { z } from "zod";
import files from "./team-logos.json";
import { wikiImageUrl } from "./wiki-images";

/**
 * Team logos: Leaguepedia's logo file of each team name that played a game of the scope (Cargo `Teams.Image`,
 * or the wiki's "<name>logo square.png" for a name a team no longer plays under, so an old name keeps the logo
 * of its time). File names only, see wiki-images.ts.
 *
 * Prototype storage: a JSON file beside the code. The durable place is a column of `teams`, filled by
 * `data:fetch` / `data:build` like the player photos.
 */
const LOGOS = new Map(Object.entries(z.record(z.string(), z.string()).parse(files)));

/** The same team as the answers name it: without Leaguepedia's disambiguation ("Griffin (Korean Team)"). */
const display = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

const BY_DISPLAY = new Map([...LOGOS].map(([name, file]) => [display(name), file]));

/** Width served: twice the largest logo shown (32 px), for high-density screens. */
const WIDTH = 64;

/** The logo of a team name, as stored or as displayed; null when Leaguepedia has none. */
export function teamLogoUrl(team: string): string | null {
  const file = LOGOS.get(team) ?? BY_DISPLAY.get(team);

  return file ? wikiImageUrl(file, WIDTH) : null;
}
