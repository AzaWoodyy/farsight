# Matching schedule matches to scoreboard series

`scheduleOnly` (`scripts/data/schedule.ts`) keeps the decided `MatchSchedule` matches that no scoreboard series covers. The matching is deliberately ordered and each scoreboard series covers one match at most, so that a series is never counted twice (once from its scoreboards, once from the schedule).

## Rules

- First pass: the same tab and match number on the same page. The scoreboard GameId "<page>_<tab>_<match>_<game>" mirrors the schedule's MatchId.
- Second pass: the same two teams on the same page within two days (`SAME_DAY_S`). Two days because a scoreboard's date and the schedule's can differ by the time zone or a late start. The same teams a week later are another series.
- Third pass, only on a page whose scoreboards name their tabs otherwise ("Scoreboards" for the schedule's "Quarterfinals"): there a team can also be named otherwise ("ALTERNATE aTTaX" for "Team ALTERNATE"), so a scoreboard series no match claimed covers a match of that tab with one team in common within two days. Where the scoreboard tabs match the schedule's, the slot alone decides and this pass does not apply.
- A scoreboard series already claimed by a match covers nothing else. The case that requires it: LVP SuperLiga Orange 2018 Spring, where Penguins played eMonkeyz the day before its tiebreaker against KIYF; without the `taken` flag the Week 14 scoreboards would also cover the tiebreaker.
- A draw (a best-of-two at 1-1, such as the Week 14 match of MAD Lions against KIYF on that page) and a match not played yet have no winner. They still claim their scoreboards, but are never kept: a series without a winner is no result.
- Without a date on either side, a series of the same page counts as close (`near`).
