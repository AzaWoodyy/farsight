import type { Answer } from "../src/lib/agent/types";
import { z } from "zod";
import { LEAGUES } from "../src/lib/domain/leagues";

const FRENCH_WORDS = new Set([
  "de", "des", "du", "le", "la", "les", "et", "en", "aux", "au", "sur", "pas", "par", "pour", "avec", "sans", "dans", "est", "sont",
  "aucun", "aucune", "partie", "parties", "victoire", "victoires", "défaite", "défaites", "joueur", "joueurs", "équipe", "équipes",
  "toutes", "tous", "saison", "saisons", "côté", "tournoi", "tournois", "lecture", "finale", "classement", "écart",
  "rang", "vainqueur", "vainqueurs", "adversaire", "adversaires", "morts", "plaques", "ancestraux", "hérauts", "inhibiteur", "inhibiteurs",
  "moyenne", "joués", "exécution", "analyse", "recherche", "requête",
]);

const FRENCH_LETTER = /[àâçéèêëîïôûùüœ]/;
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;
const LEAGUE_NAMES = LEAGUES.flatMap((l) => [l.name, l.short]).toSorted((a, b) => b.length - a.length);

export type FrenchText = { field: string; word: string; text: string };

export type ShownStep = { step: string; title: string };

const words = (text: string) => text.match(WORD) ?? [];

const capitalized = (word: string) => word[0] !== word[0]!.toLowerCase();

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const withoutLeagues = (text: string) =>
  LEAGUE_NAMES.reduce((t, name) => t.replace(new RegExp(`(?<![\\p{L}])${escaped(name)}(?![\\p{L}])`, "gu"), " "), text);

function answerData(answer: Answer): string[] {
  const table = answer.table ? { ...answer.table, columns: [] } : null;
  const data = JSON.stringify({ ...answer, title: "", summary: "", notes: [], followUps: [], table }).match(/"(?:[^"\\]|\\.)*"/g) ?? [];

  return data.map((quoted) => z.string().parse(JSON.parse(quoted)));
}

function namedWords(question: string, data: string[], englishQuestion: boolean): Set<string> {
  const asked = words(question).filter((w) => englishQuestion || capitalized(w));

  return new Set([...asked, ...data.flatMap(words).filter(capitalized)]);
}

const withoutNames = (text: string, names: string[]) => names.reduce((t, name) => t.split(name).join(" "), text);

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

  return !named.has(word) && word !== word.toUpperCase() && (FRENCH_WORDS.has(lower) || FRENCH_LETTER.test(lower));
};

export function frenchInEnglishAnswer(question: string, answer: Answer, steps: ShownStep[], englishQuestion: boolean): FrenchText[] {
  const data = answerData(answer);
  const named = namedWords(question, data, englishQuestion);
  const names = [...new Set(data.filter((d) => words(d).length > 1 && words(d).some(capitalized)))].toSorted((a, b) => b.length - a.length);

  const shown: [string, string][] = [
    ["title", answer.title],
    ["summary", answer.summary],
    ...answer.notes.map((n): [string, string] => ["note", n]),
    ...(answer.table?.columns ?? []).map((c): [string, string] => ["column", c]),
    ...(englishQuestion ? answer.followUps.map((f): [string, string] => ["follow-up", f]) : []),
    ...steps.map((s): [string, string] => [`step ${s.step}`, s.title]),
  ];

  return shown.flatMap(([field, text]) => {
    const word = words(unquoted(withoutLeagues(withoutNames(text, names)), question)).find((w) => isFrench(w, named));

    return word ? [{ field, word, text }] : [];
  });
}
