# In-game metrics: how questions name them and how they aggregate

`src/lib/agent/metrics.ts` maps what questions call an in-game statistic to a column of `v_game_player_stats` / `v_game_team_stats`, and says how each one aggregates. The routing and the tools rely on conventions this file sets.

## Rules

- `Aggregate`: `sum` is a count, ranked by its total; `avg` is ranked by the per-game average; `rate` is a 0/1 flag, ranked by the share of games. A new metric must pick the one its column really is, since rankings and the empty-result explanation (which only treats `sum` columns as counts) branch on it.
- `dragon_soul` is a rate over the games where a soul could be taken and the timeline says who took it: the column is NULL otherwise, so those games are out of the denominator, not counted as losses.
- `CUES` is ordered most specific first and the first match wins (`detectMetric`): "wards détruites" must come before "wards", "control wards" before both, "cs diff" before "cs à 15". `player` / `team` give the metric each subject maps to; team-only cues such as "premier dragon" have no player metric.
- `MINUTE` reads "à 15 min", "at 10", "15 minutes", "@20", "10'". Its edges are Unicode lookarounds (`(?<![\p{L}\p{N}])`), not `\b`: `\b` is ASCII-only in JavaScript, so "à 10" and "@20" never matched with it. The same holds for `word()`.
- Any minute is read, held by the data or not: `detectMinute` returns it and the caller says when the data has none at that minute. For the same reason `AT_MINUTE` accepts any one- or two-digit minute as soon as the text says "min" ("à 25 min"), so a minute the data does not hold is still read as a minute and answered as missing, rather than not understood.
- `MetricCue.askedMinute` is the minute the question names (null when it names none); `minute` is the same value only when the data has snapshots at it (10, 15 or 20), else null. A null `minute` with a non-null `askedMinute` means the data has no figure at that minute; a null `minute` alone means the default (15).
- `DRAGON_ELEMENT`: an element named in the question ("âme infernale", "dragons des océans") matches the `dragon_soul` cue, but a ranking on an element is not the soul rate: the router must check it and not answer with the soul-rate ranking.
