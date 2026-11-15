import { z } from "zod";

/**
 * What an item is in a build, from its Riot Data Dragon entry (`item.json`), so that a champion's
 * most built items can show completed items apart from the components and consumables left in an
 * inventory when the game ended.
 */
export const ITEM_KINDS = ["complete", "boots", "component", "starter", "consumable"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  complete: "complets",
  boots: "bottes",
  component: "composants",
  starter: "départ",
  consumable: "consommables",
};

/** Older patches have null entries in recipes. */
const Ids = z.array(z.string().nullable()).transform((ids) => ids.filter((id): id is string => id != null));

/** The fields of a Data Dragon item the classification reads (data:fetch keeps them for older patches too). */
export const ItemMeta = z.object({
  tags: z.array(z.string()).optional(),
  into: Ids.optional(),
  from: Ids.optional(),
  depth: z.number().optional(),
  gold: z.object({ total: z.number().optional(), purchasable: z.boolean().optional() }).optional(),
  /** Ornn's upgrades: built by an ally, never bought. */
  requiredAlly: z.string().nullable().optional(),
  /** Summoner's Rift (map 11): the same name can have an ARAM or Arena entry with another recipe. */
  maps: z.record(z.string(), z.boolean()).optional(),
});

export type ItemMeta = z.infer<typeof ItemMeta>;

/** The subset of an `item.json` entry stored for older patches. */
export function itemMeta(item: ItemMeta): ItemMeta {
  const { tags, into, from, depth, gold, requiredAlly, maps } = item;

  return { tags, into, from, depth, gold: gold && { total: gold.total, purchasable: gold.purchasable }, requiredAlly, maps: maps && { 11: maps["11"] === true } };
}

/** Starter items cost at most this much (Doran's items, Cull, Dark Seal, jungle pets, support items). */
const STARTER_MAX_GOLD = 500;

/** A completed item without a recipe depth (Muramana, Ornn upgrades, older patches) costs at least this much. */
const COMPLETE_MIN_GOLD = 1000;

/**
 * The kind of every item of one patch's `item.json`. Consumables and trinkets first, then boots
 * (every tier), then the items nothing buyable builds from (completed: an Ornn upgrade or an
 * unpurchasable transformation does not count), then cheap items bought at the start, the rest
 * being components.
 */
export function itemKinds(catalog: Record<string, ItemMeta>): Record<string, ItemKind> {
  const buyable = (id: string) => {
    const target = catalog[id];

    // A target missing from the patch still counts: the item builds into something.
    return !target || (target.gold?.purchasable !== false && !target.requiredAlly);
  };

  return Object.fromEntries(
    Object.entries(catalog).map(([id, item]) => {
      const tags = new Set(item.tags ?? []);
      const total = item.gold?.total ?? 0;
      const builds = (item.into ?? []).filter(buyable).length;
      let kind: ItemKind;

      if (tags.has("Consumable") || tags.has("Trinket")) kind = "consumable";
      else if (tags.has("Boots")) kind = "boots";
      else if (builds === 0 && ((item.depth ?? 1) >= 2 || total >= COMPLETE_MIN_GOLD)) kind = "complete";
      // Long Sword is a "Lane" item too: a lane starter builds into one item at most (Dark Seal into Mejai's).
      else if (!item.from?.length && total <= STARTER_MAX_GOLD && (tags.has("Jungle") || tags.has("GoldPer") || (tags.has("Lane") && builds <= 1))) kind = "starter";
      else kind = "component";

      return [id, kind];
    }),
  );
}

/**
 * The kind of a Leaguepedia item name that Data Dragon does not hold as such: an enchanted jungle
 * item or pair of boots ("Mercury's Treads - Homeguard") is its base item, completed.
 */
export function enchantedKind(name: string, kindOf: (base: string) => ItemKind | undefined): ItemKind | undefined {
  const m = /^(.+?) - [^-]+$/.exec(name);
  const base = m ? kindOf(m[1]) : undefined;

  return base == null ? undefined : base === "boots" ? "boots" : "complete";
}
