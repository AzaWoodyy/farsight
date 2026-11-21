export const ROLE_CUES = [
  { role: "Support", words: "supports?|supps?" },
  { role: "Mid", words: "mid ?lane(?:rs?|urs?)?|mids?(?![- ]?(?:season|game))" },
  { role: "Jungle", words: "jungle(?:rs?|urs?)?|jungles|junglers" },
  { role: "Bot", words: "adcs?|ad ?carr(?:y|ies)|carr(?:y|ies) ad|bot ?lane(?:rs?|urs?)?|bots|(?:en|in|quels?|meilleurs?|best|which) bot(?! ?\\d)" },
  { role: "Top", words: "top ?lane(?:rs?|urs?)?|tops|(?:en|in|quels?|meilleurs?|best|which) top(?! ?\\d)" },
] as const;

export type Role = (typeof ROLE_CUES)[number]["role"];

export const ROLE_WORDS = ROLE_CUES.map((r) => r.words).join("|");

const SHORT_ROLE_WORDS: Record<Role, string> = {
  Support: "sup",
  Mid: "",
  Jungle: "jgl?|jng",
  Bot: "bot(?! ?\\d)",
  Top: "top(?! ?\\d)",
};

export const TEAM_ROLE_CUES = ROLE_CUES.map((r) => ({ role: r.role, words: SHORT_ROLE_WORDS[r.role] ? `${r.words}|${SHORT_ROLE_WORDS[r.role]}` : r.words }));

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

export const roleOf = (question: string): Role | null => first(question, cues);

export const teamRoleOf = (rest: string): Role | null => first(rest, teamCues);
