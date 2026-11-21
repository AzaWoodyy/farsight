# Finding the final and the semifinals of a competition from Leaguepedia tabs

The `series` tool finds a stage (final, semifinal, quarterfinal) from the tab of the games and the stage of their tournament page. Leaguepedia's pages do not make that as direct as it looks.

## Rules

- A qualifier can sit under the league of the event it qualifies for and have its own "Finals" tab: the LPL 2025 Regional Finals are a `qualifier` page under the World Championship league. The Worlds final is the main event's "Finals" (T1 3-2 KT Rolster in 2025, one Bo5), never the qualifier's; qualifiers are excluded.
- A double-elimination bracket has no "Semifinals" tab: MSI 2024 has "Bracket Round 3", "Bracket Round 4" and "Finals". Its semifinal is the last round before the final, and the answer says so in a note (`scripts/series.test.ts`).
