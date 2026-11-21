import { z } from "zod";
import tones from "./team-logo-tones.json";
import { wikiImageUrl } from "./wiki-images";

const Tones = z.object({ dark: z.array(z.string()), light: z.array(z.string()) }).strict();

export type LogoTone = keyof z.infer<typeof Tones>;

const key = (file: string) => file.replace(/_/g, " ");

const listed = Tones.parse(tones);

const TONES = new Map<string, LogoTone>([...listed.dark.map((f) => [key(f), "dark"] as const), ...listed.light.map((f) => [key(f), "light"] as const)]);

const WIDTH = 64;

export function teamLogo(file: string) {
  return { url: wikiImageUrl(file, WIDTH), tone: TONES.get(key(file)) ?? null };
}
