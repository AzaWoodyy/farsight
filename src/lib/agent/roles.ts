/**
 * Role words of a question, French and English, with the `role` value they
 * mean in the database. Bare "top" and "bot" are left out: "top 5" is a
 * ranking and Top Esports is a team. Their plurals ("les tops", "the bots")
 * and "en top", "quel top", "best bot" still name the role.
 */
export const ROLE_CUES = [
  { role: "Support", words: "supports?|supps?" },
  { role: "Mid", words: "mid ?lane(?:rs?|urs?)?|mids?(?![- ]?(?:season|game))" },
  { role: "Jungle", words: "jungle(?:rs?|urs?)?|jungles|junglers" },
  { role: "Bot", words: "adcs?|ad ?carr(?:y|ies)|carr(?:y|ies) ad|bot ?lane(?:rs?|urs?)?|bots|(?:en|in|quels?|meilleurs?|best|which) bot(?! ?\\d)" },
  { role: "Top", words: "top ?lane(?:rs?|urs?)?|tops|(?:en|in|quels?|meilleurs?|best|which) top(?! ?\\d)" },
] as const;

export type Role = (typeof ROLE_CUES)[number]["role"];

/** Every role word, as one regex alternation. */
export const ROLE_WORDS = ROLE_CUES.map((r) => r.words).join("|");

const cues = ROLE_CUES.map((r) => ({ role: r.role, pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${r.words})(?![\\p{L}\\p{N}])`, "iu") }));

/** The role a question names, or null (the first one when it names several). */
export function roleOf(question: string): Role | null {
  let best: { role: Role; at: number } | null = null;

  for (const c of cues) {
    const m = c.pattern.exec(question);

    if (m && (!best || m.index < best.at)) best = { role: c.role, at: m.index };
  }

  return best?.role ?? null;
}
