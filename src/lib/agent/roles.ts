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

/**
 * Short role words that are also everyday words or handles: "top", "bot", "jg", "sup". They name a role
 * only next to one team ("top fpx 2019", "jg de G2"), read on the question with its entities and years
 * blanked out, so that "Top Esports" and "top 2019" are not taken for them. "top 5" stays a ranking.
 */
const SHORT_ROLE_WORDS: Record<Role, string> = {
  Support: "sup",
  Mid: "",
  Jungle: "jgl?|jng",
  Bot: "bot(?! ?\\d)",
  Top: "top(?! ?\\d)",
};

/** Role words next to one team: the role words and the short ones. */
export const TEAM_ROLE_CUES = ROLE_CUES.map((r) => ({ role: r.role, words: SHORT_ROLE_WORDS[r.role] ? `${r.words}|${SHORT_ROLE_WORDS[r.role]}` : r.words }));

/** A mention that is only a short role word ("Top", "Sup"): not a player handle next to a team. */
export const SHORT_ROLE_MENTION = new RegExp(`^(?:${Object.values(SHORT_ROLE_WORDS).filter(Boolean).join("|")})$`, "iu");

const compile = (list: readonly { role: Role; words: string }[]) =>
  list.map((r) => ({ role: r.role, pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${r.words})(?![\\p{L}\\p{N}])`, "iu") }));

const cues = compile(ROLE_CUES);
const teamCues = compile(TEAM_ROLE_CUES);

function first(question: string, list: { role: Role; pattern: RegExp }[]): Role | null {
  let best: { role: Role; at: number } | null = null;

  for (const c of list) {
    const m = c.pattern.exec(question);

    if (m && (!best || m.index < best.at)) best = { role: c.role, at: m.index };
  }

  return best?.role ?? null;
}

/** The role a question names, or null (the first one when it names several). */
export const roleOf = (question: string): Role | null => first(question, cues);

/** The role named next to one team, short words included; `rest` is the question with its entities and years blanked out. */
export const teamRoleOf = (rest: string): Role | null => first(rest, teamCues);
