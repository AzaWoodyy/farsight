# Reading misspelled champions, matchups and champion pools

Visitors misspell champions and write matchups loosely ("oriana vs lock"). `src/lib/agent/understand.ts` accepts a typo one edit away, with thresholds chosen so that ordinary words are not turned into champions.

## Rules

- `resolveChampionTypo` reads a champion misspelled by one letter ("oriana", "lucain") only when exactly one champion is that close, and only on a word that is not a player, a team, a stop word or an everyday word.
- `CHAMPION_TYPO_MIN = 5`: shorter words are too often another real word or champion one letter away ("Zoe", "Sion"), so they are never corrected.
- `OPPONENT_TYPO_MIN = 4`: for the opponent of a champion already named, four letters are enough and an everyday word is accepted ("oriana vs lock"). This looser reading applies only in a question about champions alone (no player, no team), on a token right after or before "vs" / "versus" / "contre" / "against" (`VERSUS_TOKENS`), or next to the first champion after a matchup word (`MATCHUP_CUE`, "match up oriana lock"), so that "lock" or "then" in a normal question stays a word ("Azir lock in vs G2").
- `NOT_OPPONENTS` lists grammar words that are one letter away from a champion and commonly follow one in a sentence ("Azir when", "Azir sont"); they are never read as an opponent.
- Longer names are detected first ("Lee Sin" before "Azir"), so after detection `detectMentions` swaps `champion` and `opponentChampion` back to the order of the question: the champion named first stays the subject.
- `CHAMP` ("champ", "champion(s)" and near typos such as "chamion", "champoin") and `POOL_WORD` ("pool" and near typos such as "pol", "poool") are loose on purpose and must only be used inside `CHAMPION_POOL`, where each is read next to the other; on their own they would match ordinary words ("poll").
- `BARE_POOL`: "pool" alone counts as nothing else being said, so with a short or everyday handle and nothing else ("pool Bin") the question still names the player and asks for a champion pool.
