# Team badges: which logo and which league a team name gets

The views put a logo and a league beside each team name of an answer. `src/lib/agent/team-badges.ts` resolves them from the database by the name shown, which is not always one team and not always the name the team had in the period.

An answer carries, for every team it names, the league that team played in over the answer's period (`Answer.teamLeagues`, computed by `teamLeagues` in `src/lib/agent/team-badges.ts`), and the views show it beside the name.

## Rules

- `teamNames` includes the teams the question names, even when no cell of the answer holds their name: an answer about one team shows its logo all the same.
- `teamLogoFiles` matches a name as stored or without Leaguepedia's disambiguation ("Griffin" for "Griffin (Korean Team)"), compared literally (`starts_with`, not `LIKE`, so `%` and `_` in a name are not patterns). A name two teams answer to ("Nova Esports", the Thai and the Taiwanese team; "Awesome", a team and "Awesome (Awesome Spear Academy)") gets none (`HAVING COUNT(*) = 1`): no logo rather than the other team's.
- The logo is read as `to_jsonb(tm) ->> 'logo'`, not `tm.logo`, because the code accepts a database the load of migration 3 has not reached yet (`PG_MIGRATION_READ`): there the column does not exist, and this form gives no logo rather than an error. It can become a plain column once `PG_MIGRATION_READ` is 3 or more.
- `teamLeagues`: the league of a team over the period is each of its own leagues (neither international nor cross-league cup, `CUP_LEAGUES`) that holds at least `LEAGUE_SHARE` (10 %) of all its games of the period; internationals and cups count in that total. Below that share a league does not name the team: it is a few games played as a stand-in. Of those leagues, ordered by first game, the last `LEAGUES_SHOWN` (2) are shown, for a team that moved.
- A team without an own league in the period under that name (a name taken later, "Movistar KOI" at MSI 2023) gets the league it last played in, from its latest season that has one.
- `seasonGames` runs two queries on purpose: the team ids first, then the games by id, so the scan of `games` filters on a short list of integer ids (`blue_team_id` / `red_team_id IN (…)`) instead of joining every game to `teams` on a name condition with an `ILIKE`. `games` has no index on its team columns today, so this is about the cost of the predicate, not an index lookup.
- The value is a list of short league names, oldest first: two entries when the team moved during the period ("LFL D2" then "LFL").
- International and cross-league competitions (Worlds, MSI, EMEA Masters) never count as a team's league: every team would otherwise be badged with the event the question is about instead of its home league.
