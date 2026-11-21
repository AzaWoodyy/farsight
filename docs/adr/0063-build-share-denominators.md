# Denominators of item, spell and rune shares

Leaguepedia's scoreboards do not list inventories, summoner spells and runes for every game, and the coverage of each differs by period. Each share is therefore computed over the games that have that piece of data, not over the games played, and the answer carries each denominator separately (`ChampionItems`, `ChampionSetups`, `PlayerRunes`, `ChampionProfile`, `ChampionPool` in `src/lib/agent/types.ts`).

## Rules

- Items: `ChampionItems.games` counts the games on the champion that have an inventory; it is the share denominator and can be lower than the picks. `ChampionItem.games` counts a game once when the inventory holds two copies of the item.
- `ChampionItems.notes` says why the list is empty or incomplete for part of the scope: no inventory listed, and the boots of bot laners since 2026.
- Summoner spells: `ChampionSetups.spellGames` (games that list the spells) is the denominator of `spells`.
- Runes have two denominators, because the scoreboards list no rune before 2018 and only the keystone until part of 2020: `keystoneGames` (games with a keystone) for the keystones and the primary trees, `pageGames` (games with the whole page) for the other runes, the secondary trees and the pages. The `notes` of `ChampionSetups` and `PlayerRunes` state that gap.
- A rune is counted per part of the page: taken as primary in some games and as secondary in others, it is two `ChampionRune` lines.
- A `RunePage` is the page as the scoreboards give it without the stat shards: the keystone, three primary and two secondary runes. Shards never make two pages differ.
- `RuneTree`: a tree as the primary path is counted on the keystones (`keystoneGames`), as the secondary path on the full pages (`pageGames`).
- `ChampionProfile.games` is every game of the scope, the denominator of the presence (picks and bans), not the games on the champion. Each entry of `averages` carries `counted`, the number of games that have that figure, because an average covers only those.
- `ChampionPool.picks` is every pick of the scope: the games of a player, five per game for a team. `ChampionPoolLine.share` is the champion's games over `picks`, so a team's shares sum to 100 % over picks, not over games.
