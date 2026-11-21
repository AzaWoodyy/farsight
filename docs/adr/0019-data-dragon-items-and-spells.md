# Item kinds, item icons and summoner spells from Data Dragon

Leaguepedia names items and spells by display name; Data Dragon gives their icon and, for items, the recipe data the kind (`complete`, `component`, `starter`, `consumable`, `boots`) is computed from (`itemKinds`, `src/lib/domain/items.ts`). Pro games span every season, so one patch is not enough, and several names exist more than once in Data Dragon.

## Rules

- `fetchDdragon` (`scripts/data/fetch.ts`) keeps, besides the latest patch, the item names and recipes of three patches per season (first, middle, last): that is enough to catch nearly every retired item, which then keeps its original icon and kind.
- For those older patches only the recipe, the tags and the price of each item are kept (`itemMeta`), which is what the derivation classifies retired items from. An entry that does not parse as `ItemMeta` only loses its kind, never its name and icon.
- Icon of an item (`scripts/data/derive.ts`): the latest patch first, then the older patches newest first, so a current item never gets a retired icon.
- Kind of an item: from the newest patch that has the item, taking the Summoner's Rift entries (`maps["11"]`) of every patch first and the other maps' entries only for names the Rift never had. ARAM and Arena variants share their name with an item of another recipe.
- Summoner spells: when several game modes share a spell name, the Summoner's Rift entry (`modes` includes `CLASSIC`) gives the icon.
- The `items` table has a NOT NULL icon, so the derivation collects item names while it reads the player lines and inserts the rows at the end, once Data Dragon has been read (an item no patch knows gets `/icons/item-fallback.svg`).
- Shapes `itemKinds` must keep classifying, taken from `item.json` 16.22.1 and 13.24.1 and pinned in `scripts/champion-items.test.ts`:
  - an Ornn upgrade: Luden's Tempest (6655) builds only into its Ornn upgrade (7013, `requiredAlly`), and both are `complete`;
  - a transformation: Muramana (3042) has no recipe depth and is not purchasable, and is `complete`;
  - Watchful Wardstone (4638): Data Dragon marks it as consumed, but it is a `component` of the Vigilant Wardstone (4643), not a consumable;
  - the support quest chain of 13.24.1, Relic Shield (3858) → Targon's Buckler (3859) → Bulwark of the Mountain (3860), linked by `specialRecipe`: only the last stage is `complete`, the first two are `starter`;
  - recipe entries that are null in older files must not break the parse.
