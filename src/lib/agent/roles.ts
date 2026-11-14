/**
 * Role words of a question, French and English, with the `role` value they
 * mean in the database. Bare "top" and "bot" are left out: "top 5" is a
 * ranking and Top Esports is a team.
 */
export const ROLE_CUES = [
  { role: "Support", words: "supports?" },
  { role: "Mid", words: "mid ?lane(?:rs?)?|mids?(?![- ]?(?:season|game))" },
  { role: "Jungle", words: "jungle(?:rs?|urs?)?|jungles" },
  { role: "Bot", words: "adcs?|ad ?carr(?:y|ies)|carr(?:y|ies) ad|bot ?lane(?:rs?)?" },
  { role: "Top", words: "top ?lane(?:rs?)?" },
] as const;

/** Every role word, as one regex alternation. */
export const ROLE_WORDS = ROLE_CUES.map((r) => r.words).join("|");
