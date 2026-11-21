# Facts about Riot, Data Dragon and Leaguepedia assets the code depends on

A few constants in `src/lib/domain` encode how the external sources behave. They look arbitrary without the fact behind them.

## Rules

- `dragonKind` (`dragons.ts`) returns null for a dragon without an element: games before patch 6.9, when elemental dragons did not exist, or a Riot sub-type the map does not know. Null is a valid stored kind ("no element"), not missing data.
- `WIDTH = 112` (`player-photos.ts`): Fandom's CDN is asked for twice the largest avatar width shown (56 px), for high-density screens. The photos are fair use, not CC BY-SA: the database keeps file names only and the browser loads the image from the CDN.
- `UNDATED_PHOTO = 0` is the `taken_at` of a headshot Leaguepedia does not date. Being the oldest possible date, `playerPhoto` picks it only for a player who has no dated photo on or before the period, and such a photo is shown without a year.
- `rune-icons.ts` holds icons the current Data Dragon no longer lists: the runes Riot removed since 2018 (Zombie Ward, Predator, Kleptomancy…) and the stat shards, which `runesReforged.json` never listed. Their images are still served under Data Dragon's unversioned `cdn/img/`, at the paths older versions gave. `runeIcon` falls back to them when the database has no icon for a rune, so an old game's rune page shows every rune as an icon.
- `TREES`: the five rune trees are served from the same unversioned `cdn/img/` under Riot's internal file names; Inspiration is "7203_Whimsy.png" there.
