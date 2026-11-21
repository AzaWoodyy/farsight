# Period words and superlatives when reading a question

`understandQuestion` (`src/lib/agent/understand.ts`) reads years and player names from free text in two languages. Two readings look like bugs and are deliberate.

## Rules

- A single year after a period word is inclusive or exclusive by the word: "depuis 2016" / "since 2016" starts in 2016, "après 2016" / "after 2016" in 2017, "jusqu'en 2020" / "until 2020" ends in 2020, "avant 2020" / "before 2020" in 2019. Two years in one question are still read as their min–max range, whatever the words around them: "Faker avant 2020 et après 2016" is 2016–2020, not 2017–2019 (`scripts/period.test.ts`).
- A superlative placed before what it ranks is not a player, even when the word is a player's alias. The alias index holds real names, so Zentinel, whose real name is Kevin Pires, is indexed under "pires", and a player's handle is "Worst": "pires champions aux Worlds 2024", "pires mids", "worst players", "worst AD carries", "worst laners" name no player, while "Worst aux Worlds 2024" names Worst and "stats de Pires" names Zentinel (`scripts/team-aliases.test.ts`, "a superlative before what it ranks").
