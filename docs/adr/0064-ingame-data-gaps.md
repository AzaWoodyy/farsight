# What the Riot game data does not hold, and how the tools count around it

In-game figures come from the Riot JSON Leaguepedia hosts, which is absent for some games and incomplete for older ones. The tools count each figure only over the games that have it and fall back to the scoreboard tables where they can.

## Rules

- A metric is n/d in `playerIngameStats` (`src/lib/agent/tools.ts`) when no game of the scope has it: the game has no timeline, or, for plates, the game predates match-v5, which has no plate events.
- In `ingameLeaderboard.format`, a rate is shown over `counted`, the games where the flag is known, not over all games: a dragon soul before patch 9.23 is unknown, not a miss.
- In `dragonStats.format`, the soul rate is over games where a soul could be taken and the timeline says who took it (`dragon_soul IS NOT NULL`). `v_game_team_stats` has one row per team, so the games are counted with `COUNT(DISTINCT s.game_id)`.
- `timelineFacts` counts elder dragons as dragons, as Leaguepedia's scoreboards do.
- `sideOf` maps Riot team 100 to blue (Leaguepedia's Team1) unless `game_riot.side_swapped` is set, the match the derivation made between the Riot teams and the scoreboard; the gold difference is negated the same way in `timelineView`.
- `gameScoreboard` is built from Leaguepedia's scoreboard tables only, with no Riot JSON, so it also covers the LPL and is shown whether or not a timeline exists. Only the dragon elements and the soul come from the Riot timeline; they are empty for the LPL and for games without one, whose dragon count still comes from the scoreboard.
