# Resolving a player mention: aliases, nicknames, pages and homonyms

Many players share a handle, and answers name a homonym by its full Leaguepedia page. `src/lib/agent/understand.ts` resolves a mention to one player without ever hiding that a choice was made, and `src/lib/aliases.ts` normalizes both sides of the comparison.

## Rules

- `normalizeAlias` decomposes with NFKD to strip accents, then recomposes with NFC before anything else: without the recomposition a Hangul name stays split into jamo and no longer equals the SQL literal stored for it ('정지훈').
- `NICKNAMES` ("goat", "unkillable demon king", "hide on bush" for Faker, "claps" for Caps) holds nicknames that designate one player without doubt, by normalized alias and Leaguepedia page. `lookupAliases` reads one only when no alias of the database matches the mention: a real player who owns that handle always wins over the nickname.
- `PAGE_MENTION` matches up to three words followed by a parenthesis, which is how a Leaguepedia page tells homonyms apart ("Knight (Zhuo Ding)"). `pageMentions` resolves such a mention to that page exactly, never to a homonym, because this is the form the answers themselves use to name a homonym or a teammate (follow-up questions must round-trip).
- In `pageMentions`, the candidate pages of one parenthesis are generated longest first and only the first page found is kept, so that "Hide on bush (…)" wins over "bush (…)". The loop relies on that order.
- In `detectMentions`, a player written by their page is replaced by one placeholder token (`PAGE_PREFIX`) before anything else is read, so the words of the page cannot be read as another player, team or champion.
- `resolvePlayer` picks among homonyms in this order: the exact case of the handle ("caPs" vs "Caps"), but only if that player played in the competition and period of the question; then games in that competition and period; then total games.
- The pick is never silent: `resolvePlayer` returns the `ambiguity` (candidates, `chosenBy`, `reason`) so the answer can say who was picked and offer the others.
- `CLEAR_MARGIN = 3`: the most played homonym is a safe pick only when it has at least three times the games of the next one (in context, or overall). Below that ratio the pick is marked `uncertain`, which lowers the confidence of the rules and removes the share card of the answer.
