export const RUNE_TREES = new Map([
  [8000, "Precision"],
  [8100, "Domination"],
  [8200, "Sorcery"],
  [8300, "Inspiration"],
  [8400, "Resolve"],
]);

const STAT_SHARDS = new Map([
  [5001, "Health Scaling"],
  [5002, "Armor"],
  [5003, "Magic Resistance"],
  [5005, "Attack Speed"],
  [5007, "Ability Haste"],
  [5008, "Adaptive Force"],
  [5010, "Move Speed"],
  [5011, "Health"],
  [5013, "Tenacity and Slow Resist"],
]);

export const RETIRED_RUNES = new Map([
  [8120, { name: "Ghost Poro", tree: "Domination" }],
  [8124, { name: "Predator", tree: "Domination" }],
  [8134, { name: "Ingenious Hunter", tree: "Domination" }],
  [8136, { name: "Zombie Ward", tree: "Domination" }],
  [8138, { name: "Eyeball Collection", tree: "Domination" }],
  [8243, { name: "The Ultimate Hat", tree: "Sorcery" }],
  [8326, { name: "Unsealed Spellbook", tree: "Inspiration" }],
  [8339, { name: "Celestial Body", tree: "Inspiration" }],
  [8358, { name: "Prototype: Omnistone", tree: "Inspiration" }],
  [8359, { name: "Kleptomancy", tree: "Inspiration" }],
  [8430, { name: "Iron Skin", tree: "Resolve" }],
  [8435, { name: "Mirror Shell", tree: "Resolve" }],
  [8472, { name: "Chrysalis", tree: "Resolve" }],
]);

const FORMER_NAMES: { id: number; name: string; until: [number, number] }[] = [
  { id: 8135, name: "Ravenous Hunter", until: [12, 6] },
  { id: 8313, name: "Perfect Timing", until: [14, 1] },
  { id: 8321, name: "Future's Market", until: [14, 10] },
  { id: 8316, name: "Minion Dematerializer", until: [14, 10] },
  { id: 9101, name: "Overheal", until: [14, 10] },
  { id: 9105, name: "Legend: Tenacity", until: [14, 10] },
  { id: 8224, name: "Nullifying Orb", until: [15, 1] },
  { id: 8230, name: "Phase Rush", until: [16, 9] },
];

const patch = (version: string | null | undefined): [number, number] | null => {
  const m = /^(\d+)\.(\d+)\./.exec(version ?? "");

  return m ? [Number(m[1]), Number(m[2])] : null;
};

const before = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export function runeName(id: number, gameVersion: string | null | undefined, current: ReadonlyMap<number, string>): string | null {
  const former = FORMER_NAMES.find((f) => f.id === id);

  if (former) {
    const v = patch(gameVersion);

    if (!v) return null;

    if (before(v, former.until)) return former.name;
  }

  return STAT_SHARDS.get(id) ?? current.get(id) ?? RETIRED_RUNES.get(id)?.name ?? null;
}
