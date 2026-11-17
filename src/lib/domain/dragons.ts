/**
 * Dragon elements: the key stored in SQL (`game_dragons.kind`, `game_team_stats.soul`)
 * and read by the tools, the Riot names it comes from, and its French label.
 */
export const DRAGON_KINDS = ["infernal", "ocean", "mountain", "cloud", "hextech", "chemtech", "elder"] as const;

export type DragonKind = (typeof DRAGON_KINDS)[number];

/** The elements a soul can have: every dragon but the elder. */
export const SOUL_KINDS = DRAGON_KINDS.filter((k) => k !== "elder");

/** `monsterSubType` of an ELITE_MONSTER_KILL event. */
const RIOT_SUB_TYPES = new Map<string, DragonKind>([
  ["FIRE_DRAGON", "infernal"],
  ["WATER_DRAGON", "ocean"],
  ["EARTH_DRAGON", "mountain"],
  ["AIR_DRAGON", "cloud"],
  ["HEXTECH_DRAGON", "hextech"],
  ["CHEMTECH_DRAGON", "chemtech"],
  ["ELDER_DRAGON", "elder"],
]);

/** `name` of a DRAGON_SOUL_GIVEN event. */
const RIOT_SOUL_NAMES = new Map<string, DragonKind>([
  ["Infernal", "infernal"],
  ["Ocean", "ocean"],
  ["Mountain", "mountain"],
  ["Cloud", "cloud"],
  ["Hextech", "hextech"],
  ["Chemtech", "chemtech"],
]);

/** Null for a dragon without an element: before patch 6.9, or a sub-type we do not know. */
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

/** French label of a stored kind; "sans élément" for the dragons before the elements. */
export const dragonLabel = (kind: string | null | undefined): string => (isDragonKind(kind) ? DRAGON_LABELS[kind] : "sans élément");
