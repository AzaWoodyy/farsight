# Finding the final, semifinal or play-in of an event from Leaguepedia tabs

A series is one match of one tab of one tournament page, and a phase ("final", "semifinal") is found by the tab's name. Tab names do not always exist for the phase asked, and the same word appears in stages that are not the event's.

## Rules

- In `phaseTabs` (`src/lib/agent/tools.ts`), play-in tabs only count for the play-in phase, so a play-in final is not the event's final.
- A double-elimination bracket (MSI since 2023, LCK playoffs) has no tab named "Semifinals". Its semifinal is taken as the last round that ended before the final started, the round that decides both finalists; the answer says so in a note naming the tab.
- Qualifier stages are outside `COMPETITION_STAGES`: "LPL Regional Finals" is not the Worlds final.
- In `series.format`, a series known only from the schedule is keyed by its `series_id` (`schedule|<id>`), not by `seriesKey` (page, tab, match number): it is always one row of its own, whatever its tab and number, and must never be merged with the games of a scoreboard series.
