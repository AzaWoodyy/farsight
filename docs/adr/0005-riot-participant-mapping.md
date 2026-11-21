# Mapping Riot participants onto Leaguepedia lines

The Riot JSON of a game identifies participants by number, team (100 / 200) and champion key, never by Leaguepedia player. `deriveDataset` (`scripts/data/derive.ts`) attaches each participant's in-game stats to a scoreboard line, and uses the Riot values to fill what the scoreboard lacks.

## Rules

- Participants are matched by champion first: a champion is unique in a game, except in the odd blind-pick game where both teams played it.
- The Riot side of each team is not assumed. Every participant whose champion matches exactly one line votes for "same" or "swapped" (team 100 is blue or not), and the majority decides (`side_swapped` in `game_riot`). A champion present on both sides is then resolved by that side.
- A participant whose champion matches no line (a rare naming mismatch) falls back to its side and its position: participants are in role order, so `ROLE_ORDER[(pid - 1) % 5]` gives the role. These are counted in `participants_by_position`.
- A game where a participant stays unmatched, or two participants land on one line, is skipped (`skipped_mapping`) rather than stored partially.
- Since derive version 4 the Riot JSON fills what the scoreboard lacks (damage, vision score, heralds, patch, keystone and rune page) through `Store.fill`, which only writes a NULL cell: Leaguepedia's value always wins when both exist. The counts are reported in `from_riot`.
