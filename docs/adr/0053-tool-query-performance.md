# Query shapes the typed tools need to stay fast on Postgres

Several tool queries are written in a less obvious shape because the direct form made the Postgres planner compute far more than the answer needs. These shapes are load-bearing: rewriting them into the simpler join brings the slow plan back.

## Rules

- `championItems`, `scopeRunes` and `scopePages` in `src/lib/agent/tools.ts` read `v_player_items` and `v_player_runes` through `CROSS JOIN LATERAL (SELECT … OFFSET 0)` driven by the champion's or player's few games. `OFFSET 0` is there so the planner keeps the lateral subquery instead of flattening it; joined whole, the item and rune views are computed for every game first (2.8 million item rows, 4.6 million rune slots).
- `pairGames` reads player A's games of the scope and player B's games as two `MATERIALIZED` CTEs, each read once. Joined directly, the planner assumes a player has the average number of games and walks B's games again for every game of A.
- `comparisonSql` filters `v_game_player_stats` on the two players in its own CTE (`st`) before joining, so the view's own joins stay small.
- `championPool.plan` aggregates who played each champion once (`by_player`, `pool_players`) and joins the result. The earlier correlated subquery rescanned every pick for each champion and took 10 s for T1.
