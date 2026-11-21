# First blood: one definition, unknown rather than guessed

The first blood of a game is read from its Riot JSON by `firstBlood` in `src/lib/sources/first-blood.ts`, the one definition shared by the in-game summary (which keeps the victim) and the timeline (which keeps the event). match-v4 and match-v5 do not credit it the same way, and Riot's end-of-game flags are used to check the reading, not to replace it.

## Rules

- The credited first blood is the first champion kill, in time order, by an identified participant against an identified opponent.
- An execution (a death to a tower or minions) is not a first blood. It is a `CHAMPION_KILL` whose `killerId` is 0, or any id that is no participant. match-v4 then credits the next kill, so the loop skips the execution and goes on.
- match-v5 may instead credit the execution itself to the team: no player has `firstBloodKill`, and the team flag goes to the opponent of the executed player. The first blood is then that execution, with no killer (`killerId: null` in the `FirstBlood` result, `killerTeam` the flagged team). It is accepted only for the very first death, in a v5 JSON, when no participant is flagged true, at least one is flagged false, and exactly one team is flagged and it is the victim's opponent.
- A kill event without any `killerId`, or with an unknown victim, cannot be read: the first blood is unknown (null). So is a kill between teammates.
- Riot's end-of-game flags (`firstBloodFlags`: the player with `firstBloodKill`, the team with first blood; v5 fields `firstBloodKill` and `objectives.champion.first`, v4 fields `stats.firstBloodKill` and `firstBlood`) are a consistency check. When they name another player or team than the first readable kill, or explicitly flag its killer or team false, the first blood is unknown rather than a later plausible kill.
- An absent flag says nothing: only an explicit `false` counts in `notKillers` / `notTeams`. Treating absent as false would turn every game without flags into an unknown first blood.
