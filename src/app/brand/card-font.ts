import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The font of the generated images: Geist Mono, the one the whole site is set in. next/og reads TTF, OTF and
 * WOFF only, not the WOFF2 `next/font` serves to the pages, so the regular weight is kept here as a static
 * TTF (fonts/OFL.txt is its licence). Read once per instance.
 */
const FAMILY = "Geist Mono";

let regular: Promise<Buffer> | undefined;

export async function cardFonts() {
  regular ??= readFile(join(process.cwd(), "src/app/brand/fonts/GeistMono-Regular.ttf"));

  return [{ name: FAMILY, data: await regular, weight: 400, style: "normal" } as const];
}
