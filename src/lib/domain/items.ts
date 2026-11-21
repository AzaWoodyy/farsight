import { z } from "zod";
import type { Locale } from "../locale";

export const ITEM_KINDS = ["complete", "boots", "component", "starter", "consumable"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABEL: Record<Locale, Record<ItemKind, string>> = {
  fr: { complete: "complets", boots: "bottes", component: "composants", starter: "départ", consumable: "consommables" },
  en: { complete: "completed", boots: "boots", component: "components", starter: "starter", consumable: "consumables" },
};

const Ids = z.array(z.string().nullable()).transform((ids) => ids.filter((id): id is string => id != null));

export const ItemMeta = z.object({
  tags: z.array(z.string()).optional(),
  into: Ids.optional(),
  from: Ids.optional(),
  depth: z.number().optional(),
  gold: z.object({ total: z.number().optional(), purchasable: z.boolean().optional() }).optional(),
  specialRecipe: z.union([z.number(), z.string()]).optional(),
  requiredAlly: z.string().nullable().optional(),
  maps: z.record(z.string(), z.boolean()).optional(),
});

export type ItemMeta = z.infer<typeof ItemMeta>;

export function itemMeta(item: ItemMeta): ItemMeta {
  const { tags, into, from, depth, gold, specialRecipe, requiredAlly, maps } = item;

  return { tags, into, from, depth, gold: gold && { total: gold.total, purchasable: gold.purchasable }, specialRecipe, requiredAlly, maps: maps && { 11: maps["11"] === true } };
}

const STARTER_MAX_GOLD = 500;

const COMPLETE_MIN_GOLD = 1000;

export function itemKinds(catalog: Record<string, ItemMeta>): Record<string, ItemKind> {
  const buyable = (id: string) => {
    const target = catalog[id];

    return !target || (target.gold?.purchasable !== false && !target.requiredAlly);
  };

  const transformed = new Set(Object.values(catalog).flatMap((item) => (item.specialRecipe == null ? [] : [String(item.specialRecipe)])));

  return Object.fromEntries(
    Object.entries(catalog).map(([id, item]) => {
      const tags = new Set(item.tags ?? []);
      const total = item.gold?.total ?? 0;
      const builds = (item.into ?? []).filter(buyable).length;
      let kind: ItemKind;

      if (tags.has("Consumable") || tags.has("Trinket")) kind = "consumable";
      else if (tags.has("Boots")) kind = "boots";
      else if (builds === 0 && ((item.depth ?? 1) >= 2 || total >= COMPLETE_MIN_GOLD || (item.specialRecipe != null && !transformed.has(id)))) kind = "complete";
      else if (!item.from?.length && total <= STARTER_MAX_GOLD && (tags.has("Jungle") || tags.has("GoldPer") || (tags.has("Lane") && builds <= 1))) kind = "starter";
      else kind = "component";

      return [id, kind];
    }),
  );
}

export function enchantedKind(name: string, kindOf: (base: string) => ItemKind | undefined): ItemKind | undefined {
  const m = /^(.+?) - [^-]+$/.exec(name);
  const base = m ? kindOf(m[1]) : undefined;

  return base == null ? undefined : base === "boots" ? "boots" : "complete";
}
