import type { Answer, StepPart } from "../src/lib/agent/types";
import { LEAGUES } from "../src/lib/domain/leagues";

const FRENCH_WORDS = new Set([
  "de", "des", "du", "le", "la", "les", "et", "en", "aux", "au", "sur", "pas", "par", "pour", "avec", "sans", "dans", "est", "sont",
  "aucun", "aucune", "partie", "parties", "victoire", "victoires", "défaite", "défaites", "joueur", "joueurs", "équipe", "équipes",
  "toutes", "tous", "saison", "saisons", "côté", "tournoi", "tournois", "lecture", "finale", "classement", "écart",
]);

const FRENCH_LETTER = /[àâçéèêëîïôûùüœ]/;
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;
const LEAGUE_WORDS = LEAGUES.flatMap((l) => [l.name, l.short]);

export type FrenchText = { field: string; word: string; text: string };

const words = (text: string) => text.match(WORD) ?? [];

const capitalized = (word: string) => word[0] !== word[0]!.toLowerCase();

function namedWords(question: string, answer: Answer, englishQuestion: boolean): Set<string> {
  const data = JSON.stringify({ ...answer, title: "", summary: "", notes: [], followUps: [], table: null }).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const names = data.flatMap(words).filter(capitalized);

  const asked = words(question).filter((w) => englishQuestion || capitalized(w));

  return new Set([...LEAGUE_WORDS.flatMap(words), ...asked, ...names].map((w) => w.toLowerCase()));
}

function unquoted(text: string, question: string): string {
  const asked = words(question).map((w) => w.toLowerCase());
  const shown = words(text);
  const quoted = new Set<number>();

  for (let i = 0; i < shown.length; i++)
    for (let j = 0; j < asked.length; j++) {
      let n = 0;

      while (i + n < shown.length && j + n < asked.length && shown[i + n]!.toLowerCase() === asked[j + n]) n++;

      if (n >= 2) for (let k = i; k < i + n; k++) quoted.add(k);
    }

  return shown.filter((_, i) => !quoted.has(i)).join(" ");
}

const isFrench = (word: string, named: Set<string>) => {
  const lower = word.toLowerCase();

  return !named.has(lower) && word !== word.toUpperCase() && (FRENCH_WORDS.has(lower) || FRENCH_LETTER.test(lower));
};

export function frenchInEnglishAnswer(question: string, answer: Answer, steps: StepPart[], englishQuestion: boolean): FrenchText[] {
  const named = namedWords(question, answer, englishQuestion);

  const shown: [string, string][] = [
    ["title", answer.title],
    ["summary", answer.summary],
    ...answer.notes.map((n): [string, string] => ["note", n]),
    ...(answer.table?.columns ?? []).map((c): [string, string] => ["column", c]),
    ...(englishQuestion ? answer.followUps.map((f): [string, string] => ["follow-up", f]) : []),
    ...steps.flatMap((s) => [...new Set([s.title, ...s.entries.map((e) => e.title)])].map((t): [string, string] => [`step ${s.step}`, t])),
  ];

  return shown.flatMap(([field, text]) => {
    const word = words(unquoted(text, question)).find((w) => isFrench(w, named));

    return word ? [{ field, word, text }] : [];
  });
}
