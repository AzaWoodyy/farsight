# An empty result is explained from the question's scope, not from the SQL

When a query comes back empty, `explainEmpty` (`src/lib/agent/empty.ts`) decides whether that emptiness is itself the answer: no game at all in the scope, games only in regional qualifiers (excluded by default), no in-game data, or a count that is truly zero over the games that hold in-game data. A conclusive explanation stops the self-correction.

## Rules

- The probes read the scope from the resolved entities (`scopeFilter`), never from the generated SQL, so a wrong filter in that SQL cannot make an empty scope look like a real zero. The SQL is only read to find which count columns it sums (`countedColumns`).
- With several players or several teams, `explainEmpty` returns null: the question does not say whether it means their games together or each one's own, so nothing is concluded.
- A NULL in an in-game count column is a statistic the Riot data does not give (turret plates before 2020, for example), not a zero. Each column is a zero only over the games that measure it, so the probe counts, per column, the games where it is not NULL.
- The sample a "zero" answer states is the fewest games that measure any one of the summed columns (`measuredGames`, a `Math.min`): it is the only sample every zero of the answer holds on. The other games of the scope are reported as "without this data".
- `unrecognizedNote` drops the words that link two names ("Orianna vs Azir": `vs`, `versus`, `contre`, `against`, `face`, in `CONNECTORS`): no rule reads them, yet they are not names either, so they must not be reported as unrecognized players, teams or champions.
