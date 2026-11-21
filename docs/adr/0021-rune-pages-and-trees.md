# Rune pages are stored only when complete, and a rune's tree is voted

Rune pages come from Leaguepedia's `ScoreboardPlayers.Runes` and, when the scoreboard has none, from the Riot JSON. Data Dragon only knows the runes of its current patch, so names, trees and icons of older runes need other sources (`scripts/data/derive.ts`, `scripts/data/runes.ts`).

## Rules

- A Leaguepedia rune page is read in order: the keystone, three primary runes, two secondary ones, then three stat shards, which some pages lack. Only a list of 9 or 6 names is trusted slot by slot (`runePage`); a list of another length is not stored and is counted in `odd_rune_pages`.
- The tree of a rune comes from Data Dragon when it lists the rune, else from `RETIRED_RUNES` (`runes.ts`), else from the lines themselves: each line votes its `PrimaryTree` for its keystone and primary runes and its `SecondaryTree` for its secondary runes, and the tree most lines agree on wins. Stat shards have neither a tree nor an icon.
- A scoreboard without a rune page gets the Riot one, its ids turned into names with the table of the game's patch (`runeName`), and its two trees are added to the votes. A page with an id no table names is left out entirely (`rune_pages_unknown_id`), never stored with a hole.
- The `runes` table is completed (tree, icon) after the in-game stats are processed, because the Riot pages can add runes and votes; moving that block earlier would leave those runes without a tree.
