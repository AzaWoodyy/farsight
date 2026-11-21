# Reading role words without mistaking rankings, teams and handles

"top", "bot", "jg" and "sup" are role names, everyday words, parts of team names and sometimes handles. `src/lib/agent/roles.ts` keeps two lists so that each is read only where it is safe.

## Rules

- `ROLE_CUES` leaves out bare "top" and "bot": "top 5" is a ranking and Top Esports is a team. Their plurals ("les tops", "the bots") and "en top", "quel top", "best bot" still name the role.
- `SHORT_ROLE_WORDS` ("top", "bot", "jg", "sup") name a role only next to one team ("top fpx 2019", "jg de G2"), through `TEAM_ROLE_CUES` and `teamRoleOf`. They are read on the question with its entities and years blanked out (`maskUnderstood(...).rest`), so that "Top Esports" and "top 2019" are not taken for them; "top 2019" there is the top laner of 2019, not a "top N" ranking. "top 5" stays a ranking (`(?! ?\d)`).
- `SHORT_ROLE_MENTION`: a mention that is only a short role word ("Top", "Sup") is not read as a player handle next to a team.
- In `routeByRules`, one team and a roster word ("Samsung White roster 2014", "qui jouait chez Fnatic en 2018") gives its players by role; one team and a role and nothing else ("adc de T1", "c'est qui le toplaner de T1 ?", "top fpx 2019", "jg de G2") gives the roster with that role first.
