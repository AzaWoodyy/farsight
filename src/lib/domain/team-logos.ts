import { z } from "zod";
import tones from "./team-logo-tones.json";
import { wikiImageUrl } from "./wiki-images";

/**
 * Team logos: the square logo file of each team on Leaguepedia, held by the database (`teams.logo`, filled by
 * `data:fetch` / `data:build`, scripts/data/team-logos.ts) under the exact name the wiki stores it. File names only,
 * see wiki-images.ts.
 */

/**
 * `tone`: a logo that is nearly black ("dark") or nearly white ("light") all over. Drawn on a page of the same tone it
 * disappears, so the view puts a contrasting plate behind it. A hand-kept list of logo files (team-logo-tones.json),
 * never measured at ingestion: a new logo that needs a plate is added there by its file name.
 */
const Tones = z.object({ dark: z.array(z.string()), light: z.array(z.string()) }).strict();

export type LogoTone = keyof z.infer<typeof Tones>;

/** The key of a file name: the wiki reads a space and an underscore alike. */
const key = (file: string) => file.replace(/_/g, " ");

const listed = Tones.parse(tones);

const TONES = new Map<string, LogoTone>([...listed.dark.map((f) => [key(f), "dark"] as const), ...listed.light.map((f) => [key(f), "light"] as const)]);

/** Width served: twice the largest logo shown (32 px), for high-density screens. */
const WIDTH = 64;

/** The image and the tone of a logo file. */
export function teamLogo(file: string) {
  return { url: wikiImageUrl(file, WIDTH), tone: TONES.get(key(file)) ?? null };
}
