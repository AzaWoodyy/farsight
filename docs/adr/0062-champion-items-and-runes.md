# Reading items and rune pages from Leaguepedia's scoreboards

Items, summoner spells and runes come from the `ScoreboardPlayers` fields of Leaguepedia, which have gaps and inconsistencies the tools work around and report.

## Rules

- `BOT_BOOTS_SLOT_YEAR` in `src/lib/agent/tools.ts` is 2026: since that season a bot laner's boots sit in the role quest slot (Riot `roleBoundItem`), which Leaguepedia's Items field leaves out. `championItems` adds a note when the scope has such picks, so missing boots are not read as a build choice.
- In `scopeRunes`, a rune is counted with `COUNT(DISTINCT gp.game_id)`: a stat shard taken twice on one page counts once, as two copies of an item do.
- `scopePages` builds a page from slots 1 to 6 (the keystone, three primary and two secondary runes, no stat shards). The two secondary runes are folded to one slot (`LEAST(r.slot, 5)`) and read in name order, because the scoreboards list them either way round and both orders are the same page. A page whose keystone or second slot is not listed is not counted.
- `primaryTrees` counts the primary trees on the keystones: a keystone belongs to the primary path of its page.
