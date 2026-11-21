# Rune names from Riot ids for games without a scoreboard rune page

For the games whose Leaguepedia scoreboard has no rune page, the derivation names the Riot rune ids (the `perk*` of the game's JSON) the way Leaguepedia writes them. The current Data Dragon `runesReforged.json` names most ids; `scripts/data/runes.ts` holds what it does not. Its tables were read from the `runesReforged.json` of every patch from 7.22 to 16.23, one per patch; extend them the same way when Riot changes a rune.

## Rules

- `STAT_SHARDS`: Data Dragon never listed the stat shards. They carry Leaguepedia's names, whatever the patch: 5007 is "Ability Haste" even for games played before the cooldown reduction shard was renamed.
- `RETIRED_RUNES`: the runes Riot removed, with their tree, since the current Data Dragon no longer lists them.
- `FORMER_NAMES`: ids Riot later gave to another rune keep their former name up to the patch of the change (major, minor of Riot's game version), for example 8135 is "Ravenous Hunter" before 12.6 and 8230 is "Phase Rush" before 16.9.
- `runeName` returns null when the id is unknown, and also when the id changed names and the game has no version: the name is not guessed. Other ids do not need a version.
