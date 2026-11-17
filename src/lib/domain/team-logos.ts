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
/**
 * `tone`: a logo that is nearly black ("dark") or nearly white ("light") all over, measured once on its opaque
 * pixels. Drawn on a page of the same tone it disappears, so the view puts a contrasting plate behind it.
 */
const Logo = z.object({ file: z.string(), tone: z.enum(["dark", "light"]).optional() });

export type LogoTone = NonNullable<z.infer<typeof Logo>["tone"]>;

const LOGOS = new Map(Object.entries(z.record(z.string(), Logo).parse(files)));

/** The same team as the answers name it: without Leaguepedia's disambiguation ("Griffin (Korean Team)"). */
const display = (team: string) => team.replace(/\s*\(.*?\)\s*$/, "");

const BY_DISPLAY = new Map([...LOGOS].map(([name, logo]) => [display(name), logo]));

/** Width served: twice the largest logo shown (32 px), for high-density screens. */
const WIDTH = 64;

/** The logo of a team name, as stored or as displayed; null when Leaguepedia has none. */
export function teamLogo(team: string): { url: string; tone: LogoTone | null } | null {
  const logo = LOGOS.get(team) ?? BY_DISPLAY.get(team);

  return logo ? { url: wikiImageUrl(logo.file, WIDTH), tone: logo.tone ?? null } : null;
}
