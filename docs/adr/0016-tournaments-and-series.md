# Tournament year, event pages and which schedule matches are kept

Leaguepedia's `Tournaments` and `MatchSchedule` rows are not usable as they are: the year field follows the league calendar, an international event exists both as a page and as its stages, and the schedule lists matches the scoreboards already cover. `scripts/data/derive.ts` applies the rules below.

## Rules

- `yearOf`: a page named after its edition (`^\d{4} `) is that year, before the `Year` field is read. Leaguepedia files the December KeSPA Cup ("2025 LoL KeSPA Cup") under the next LCK season, so its `Year` says 2026. Only then come `Year`, a year or "Season N" elsewhere in the page name (2010 + N), and the start date.
- An international page whose stages exist as separate pages only holds standings: its `stage` is set to `event`, so its games are counted once, under the stages.
- Series without a scoreboard: every match of the scope is passed to `scheduleOnly` so that it claims its scoreboard games, an undecided one (a draw) included; only the decided matches are then kept. Filtering to decided matches first would leave a draw's scoreboard games unclaimed and let another match of the same teams be taken for covered or uncovered wrongly.
