# When the router answers that the data is missing

A question whose data the database does not hold is answered without a query (`Route` of kind `missing`, `src/lib/agent/query.ts`), never by a nearby figure. AGENTS.md records that in-game data is absent for the LPL and for any scope whose `v_ingame_coverage.ingame_games` is 0; the rules below are the finer cases.

## Rules

- `DATA_CONCEPTS` pairs each concept people ask about (summoner spells, MVP) with the view column that would hold it (`v_game_players.spell1`, `v_game_players.mvp`). `missingConcepts` reports a concept only while that column is absent from the live schema, so a rebuild that adds the column to the views switches the detection off by itself: do not hard-code the list as "missing".
- The snapshots of the Riot data exist at 10, 15 and 20 min only. "gold diff à 25 min" is answered as missing, naming the minutes that exist, rather than answered at 15 (`routeIngame`).
- For one team (`routeIngame`, and the same test for `dragon_stats`): the data is absent when the team has games but no Riot data in the scope asked, or no Riot data at all (an LPL team). A scope where the team did not play at all is not "missing": it stays with the tool, whose relaxations widen it.
- A figure of the Riot data in a scope that has none (the LPL) is absent, not zero: the champion totals ("champion avec le plus de morts aux Worlds", "quel champion a le plus de pentakills") check `ingameAbsent` before ranking.
- Dragon kills per champion do not exist: the dragon event of the timeline identifies its team, but has no killer champion (`CHAMPION_DRAGON_KILLS` answers missing). When the question speaks of teams, the team totals can be joined to the champions picked by that side, so it goes to generated SQL instead.
