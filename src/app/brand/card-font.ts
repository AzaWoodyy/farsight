import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FAMILY = "Geist Mono";

let regular: Promise<Buffer> | undefined;

export async function cardFonts() {
  regular ??= readFile(join(process.cwd(), "src/app/brand/fonts/GeistMono-Regular.ttf"));

  return [{ name: FAMILY, data: await regular, weight: 400, style: "normal" } as const];
}
