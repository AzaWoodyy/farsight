# Riot game JSON: two shapes, and what their events really say

The Riot JSON Leaguepedia hosts comes in two generations, match-v4 and match-v5, and neither is regular. `parseTimeline` (`src/lib/sources/timeline.ts`), `firstBlood` (`src/lib/sources/first-blood.ts`) and `summarizeGame` (`scripts/data/ingame.ts`) read both; the fixtures of `scripts/timeline.test.ts` (`v4Game`, `v5Game`, `firstBloodGame`) reproduce each irregularity on purpose, so a fixture must not be "normalized".

## Rules

- match-v4 timeline frames carry no `participantId` inside `participantFrames` in some games: the key of the entry is the participant id. `parseTimeline` reads `pf.participantId ?? Number(id)`, and the v4 fixture frames omit the field for that reason.
- match-v5 JSON may come wrapped as `{ metadata, info }`, for the stats and for the timeline, like some Leaguepedia pages; the parser unwraps `info` when it is there.
- match-v4 differs from match-v5 on three points the parser must keep handling: a team's `win` is the string `"Win"` / `"Fail"` (a boolean in v5), `gameDuration` is in milliseconds (seconds in v5), and an `ELITE_MONSTER_KILL` has no `killerTeamId`, so the monster goes to the team of the killer's participant. A monster kill with no champion killer (`killerId` 0) cannot be given a team and is left out.
- `BUILDING_KILL.teamId` names the team that LOST the building. The tower or inhibitor event goes to the other team, whoever last hit it (minions included): a tower event with `teamId: 200` is a tower for team 100.
- Riot's end-of-game first-blood flags (`firstBloodKill` on a participant, `firstBlood` / `objectives.champion.first` on a team) are absent altogether in some old match-v4 games. An absent flag says nothing, unlike a flag present and false: without flags the first readable champion kill still counts as first blood; with every flag present and false, there is none.
- Real games behind the first-blood rules, kept cut down to their first three kills in `scripts/data/fixtures/first-blood.json`:
  - `ESPORTSTMNT02_3048494` (Worlds 2022, match-v5): player 8 (red) is executed at 3:24; Riot sets `objectives.champion.first` for blue and no player has `firstBloodKill`. The execution itself is the first blood, credited to the team, with no killer.
  - `LOLTMNT02_486481` (Worlds 2026, match-v5): player 5 (blue) is executed at 3:24 and the first blood goes to red; every `first_blood_kill` of the summary is 0.
  - `TRKR1_610063` (2015 Summer Promotion, match-v4): player 1 is executed at 2:14 and Riot credits player 3's kill at 9:46. match-v4 never credits an execution: the next champion kill is the first blood.
