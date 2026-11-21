# Cue words that look like another intent

The router reads intent from word lists (`src/lib/agent/query.ts`). A few words belong to two intents or collide with a name of the domain; each list below carries an exception that a wider or "simpler" regex would lose.

## Rules

- `ROSTER` reads "composition" as who played for a team, not as the draft ("composition d'équipe"): a draft is champions, and a question naming a champion is routed elsewhere before the roster.
- `PLAYER_TEAM` (one player named) is narrower than `ROSTER`: "who was Faker" names no team, so a verb counts only with its "with" ("who played with Caps", "qui jouait avec").
- `CHAMPION_RANKING` must not fire on a title: "champion du monde", "world champion", "champion en titre" are excluded by `NOT_CHAMPION_RANKING`.
- `GAME_NUMBER` reads "game 3", "partie 2", "3e game", "troisième partie", and never "G3": G2 is a team.
- `PHASES` is ordered most specific first, because `phaseOf` takes the first match and "demi-finale" also contains "finale"; third place, semifinal and quarterfinal must stay before `final`.
