# League cues, the LES acronym, and competitions that are not a team's league

`src/lib/domain/leagues.ts` fixes the scope and how a question names each competition. Some competitions need a rule of their own because their name collides with a word, or because a team plays them besides its league.

## Rules

- `detectLeague` keeps the longest matching cue, not the first league declared: "LCK CL" must win over "LCK", "LTA North" over "LTA", "EU LCS" over "LCS", "SuperLiga 2nd Division" over "SuperLiga". The order of `LEAGUES` carries no priority.
- `LES_CUE`: "les" is a French article, so the LES is read by its full name in any case ("Liga Española de League of Legends"), or by its acronym in capitals only before a year or after "en", "la", "in", "the" ("classement LES 2026", "Résultats de X en LES").
- `LES_CUE` is written with explicit character classes (`[Ll][Ii][Gg][Aa]…`) instead of the `i` flag or an inline modifier: part of the pattern must stay case-sensitive, and the regex modifier syntax that would allow mixing both cannot be parsed by older browsers, where this module also runs.
- `CUP_LEAGUES` (European Masters, EMEA Masters, KeSPA Cup) are cross-league competitions: a team plays them besides its own league (a French team in the LFL and in the EMEA Masters, an LCK team in the KeSPA Cup), so they never name the league a team is in. Worlds, MSI, First Stand and the Esports World Cup are covered by `international` instead.
- `ROSTER_EXCLUDED` (KeSPA Cup) is left out of a team's roster unless the question names it: an LCK team fields its academy players at the KeSPA Cup, who would read as substitutes of the main roster. Its games still count everywhere else.
