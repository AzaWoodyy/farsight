# Ranking thresholds, totals and what the router's input is corrected to

Rankings need a minimum sample to mean something, and the router model fills some fields in ways that would defeat it. The thresholds and the corrections applied in each tool's `normalize` are decisions, not incidental values.

## Rules

- `DEFAULT_MIN_PICKS` in `src/lib/agent/tools.ts`: a champion's win rate and KDA need 2 % of the scope's games, at least 3 picks. `DEFAULT_MIN_PICKS_AVERAGE`: a per-game average swings more on a few games and needs at least 5 picks, the cut Riot's own Worlds stats page applies.
- A total needs no minimum of picks (`needsMinPicks`): more picks is what makes a total. A minimum the question sets explicitly still applies.
- The router model tends to set a minimum of 1 for "top 5". `championRanking.normalize`, `playerLeaderboard.normalize` and `teamLeaderboard.normalize` therefore discard a minimum below 3 and let the default threshold stand; "top 5 supports" or "top 5 équipes" is not a minimum of 1 game.
- Multikills (`CHAMPION_MULTIKILL_SORTS`) are rare enough that only their total over the scope means something: `championRanking.normalize` forces `total` to true for them, and to false for any sort that is not a count or a sum (`CHAMPION_TOTAL_SORTS`).
- In `championRanking.plan`, picks, wins, KDA and averages follow the role and side asked, while bans and presence follow the side only: a ban has no role. Presence is always over every game of the scope.
- `championEventStats.format` takes `scope_games`, every game of the scope including editions where the champion was neither picked nor banned, as the denominator of presence, so the figure matches the one `champion_ranking` gives.
- `teamLeaderboard.normalize` drops `side` when the criterion is `blue_winrate` or `red_winrate`: a side's win rate already names its side.
- `RankingSplitInput` is `.nullish()`, not `.nullable()`: tool calls written before the field existed carry no `split` key and must still parse, while the model sends null for the whole season.
- `MAX_VERSUS_GAMES` is 200 because the most frequent pair exceeds a small limit: Faker and Chovy met 146 times.
