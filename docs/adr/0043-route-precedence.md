# Order of the rules in the router

`routeByRules` (`src/lib/agent/query.ts`) tries its routes in a fixed order, and several cues are shared between routes. The order below is what makes a shared word go to the right tool; moving a block silently changes the answer of questions that still "work".

## Rules

- The game timeline (`routeTimeline`) is tried before the in-game metrics: "courbe d'or" or "dragons" in a timeline question are not a statistic.
- A stage of a competition, or a match named by its stage (`routeSeries`), is tried before the head-to-head and the standings: "Final worlds 2025" is the Worlds final, not a tournament whose name holds "Finals".
- `routeSeries` needs a competition or a team and no player or champion; a game number or a timeline cue has already gone to the timeline. In-game metrics, pool, roster and standings words keep their own route. Without a stage, two teams and a best-of word give their series only in a season asked ("BO KC T1 worlds 2026"); without a season their whole record stays the head-to-head.
- A single-game record asked per minute goes to generated SQL (`SINGLE_GAME` with `PER_MINUTE`): the records hold no per-minute figure, and a ranking over the scope would answer another question.
- Two players set against each other get the comparison even with a metric ("Faker vs Chovy KDA"): the check on `OPPOSE` comes before every metric and ranking route.
- One player and a rune word ("runes de Faker aux Worlds 2019", "runes de Faker sur Azir") go to `player_runes`, on the champion named with them. A champion alone keeps its profile (`champion_event_stats`), which shows its runes.
- The pool route (`POOL`) comes before the roster: "quels champions joue le mid de T1" asks for champions, not players. It is not taken with a champion named (a player on one champion) nor with an in-game metric the pool does not hold.
- A champion alone goes to its profile, which answers its averages too ("KDA d'Azir", "dégâts de Jinx") and the gold and CS differences at 15 min (`PROFILE_INGAME`); another in-game metric ("gold diff at 10", "solo kills") is not in the profile and goes on to the in-game routes.
- Teams are ranked by `team_leaderboard` only on a criterion the question names ("équipes avec le meilleur winrate", "quelle équipe a les parties les plus courtes"). In-game metrics keep `ingame_leaderboard`, and "meilleures équipes" alone keeps the standings.
- Players are ranked by `player_leaderboard` on an end-of-game criterion; in-game metrics (gold diff, solo kills) keep their leaderboard. A role with a comparison word ranks its players too ("comparaison des mids aux Worlds"). "classement" is also a tournament's standings, so it ranks players only with a role or a player word.
- In `routeIngame`, souls, elder dragons and dragons by element go to `dragon_stats` (every team or one team), but a ranking of teams keeps the leaderboard.
- In `routeIngame`, a role names who is ranked even without a ranking word ("écart d'or à 15 min des junglers").
- A team ranking on one dragon element ("équipes avec le plus d'âmes infernales") goes to generated SQL: one element is not the soul rate `ingame_leaderboard` ranks.
