import { say } from "../agent/messages";

export const DRAGON_KINDS = ["infernal", "ocean", "mountain", "cloud", "hextech", "chemtech", "elder"] as const;

export type DragonKind = (typeof DRAGON_KINDS)[number];

const RIOT_SUB_TYPES = new Map<string, DragonKind>([
  ["FIRE_DRAGON", "infernal"],
  ["WATER_DRAGON", "ocean"],
  ["EARTH_DRAGON", "mountain"],
  ["AIR_DRAGON", "cloud"],
  ["HEXTECH_DRAGON", "hextech"],
  ["CHEMTECH_DRAGON", "chemtech"],
  ["ELDER_DRAGON", "elder"],
]);

const RIOT_SOUL_NAMES = new Map<string, DragonKind>([
  ["Infernal", "infernal"],
  ["Ocean", "ocean"],
  ["Mountain", "mountain"],
  ["Cloud", "cloud"],
  ["Hextech", "hextech"],
  ["Chemtech", "chemtech"],
]);

export const dragonKind = (subType: string | undefined): DragonKind | null => (subType ? (RIOT_SUB_TYPES.get(subType) ?? null) : null);

export const soulKind = (name: string | undefined): DragonKind | null => (name ? (RIOT_SOUL_NAMES.get(name) ?? null) : null);

export const DRAGON_LABELS: Record<DragonKind, string> = {
  infernal: "infernal",
  ocean: "océan",
  mountain: "montagne",
  cloud: "nuage",
  hextech: "hextech",
  chemtech: "chemtech",
  elder: "ancestral",
};

export const isDragonKind = (value: string | null | undefined): value is DragonKind => DRAGON_KINDS.some((k) => k === value);

export const dragonLabel = (kind: string | null | undefined): string =>
  isDragonKind(kind) ? say(DRAGON_LABELS[kind], kind) : say("sans élément", "no element");

export const DRAGON_ICON_FILES: Record<DragonKind, string> = {
  infernal: "Drake Mini Icon - Infernal.png",
  ocean: "Drake Mini Icon - Ocean.png",
  mountain: "Drake Mini Icon - Mountain.png",
  cloud: "Drake Mini Icon - Cloud.png",
  hextech: "Drake Mini Icon - Hextech.png",
  chemtech: "Drake Mini Icon - Chemtech.png",
  elder: "Elder DragonSquare.png",
};

export const PLAIN_DRAGON_ICON_FILE = "DragonSquare.png";
