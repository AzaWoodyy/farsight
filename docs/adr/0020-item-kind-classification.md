# Classifying items from Data Dragon: completed, boots, component, starter, consumable

An inventory at the end of a game mixes completed items with components and consumables. `src/lib/domain/items.ts` gives every item of a patch a kind from its Data Dragon entry (`item.json`), so that a champion's most built items can show completed items apart from the rest. Data Dragon has no such field; the kind is inferred, and each test below answers a real item that an obvious rule misfiled.

## Rules

- `Ids`: older patches have null entries in the `into` / `from` recipes; they are dropped while parsing.
- `ItemMeta.specialRecipe` marks a transformation (Muramana, a support item's next stage) and holds the id of the item it comes from.
- `ItemMeta.requiredAlly` marks Ornn's upgrades: built by an ally, never bought.
- `ItemMeta.maps`: only Summoner's Rift (map 11) entries are kept, because the same name can have an ARAM or Arena entry with another recipe.
- Order of the tests in `itemKinds`: consumables and trinkets first, then boots (every tier), then completed items, then starters, the rest being components.
- An item is completed when nothing buyable builds from it (`buyable`): an Ornn upgrade or an unpurchasable transformation does not count as something it builds into. A recipe target missing from the patch's catalogue still counts: the item builds into something.
- Among the items nothing buyable builds from, completed means a recipe depth of 2 or more, or a price of at least `COMPLETE_MIN_GOLD = 1000` (for a completed item without a recipe depth: Muramana, Ornn upgrades, older patches), or the last stage of a transformation chain whatever its price (Bulwark of the Mountain after Relic Shield and Targon's Buckler). The first and middle stages of a chain are not completed.
- `STARTER_MAX_GOLD = 500`: a starter costs at most this much and has no recipe (Doran's items, Cull, Dark Seal, jungle pets, support items). The "Lane" tag alone is not enough, since Long Sword carries it too: a lane starter builds into one item at most (Dark Seal into Mejai's), a component into several.
- `enchantedKind`: a Leaguepedia item name Data Dragon does not hold as such, an enchanted jungle item or pair of boots ("Mercury's Treads - Homeguard"), takes the kind of its base item: boots stay boots, anything else is completed.
