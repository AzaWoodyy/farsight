import type { Answer } from "../src/lib/agent/types";
import { z } from "zod";
import { LEAGUES } from "../src/lib/domain/leagues";

const FRENCH_WORDS = new Set([
  "de", "des", "du", "le", "la", "les", "et", "en", "aux", "au", "sur", "pas", "par", "pour", "avec", "sans", "dans", "est", "sont",
  "aucun", "aucune", "partie", "parties", "victoire", "victoires", "défaite", "défaites", "joueur", "joueurs", "équipe", "équipes",
  "toutes", "tous", "saison", "saisons", "côté", "tournoi", "tournois", "lecture", "finale", "classement", "écart",
  "rang", "vainqueur", "vainqueurs", "adversaire", "adversaires", "morts", "plaques", "ancestraux", "hérauts", "inhibiteur", "inhibiteurs",
  "moyenne", "joués", "exécution", "analyse", "recherche", "requête",
  "poste", "statut", "nombre", "finaliste", "arbre", "pris", "bleu", "rouge", "titulaire", "remplaçant", "inconnu", "quart", "historique",
]);

const ENTITY_COLUMN = /team|player|champion|opponent|winner|blue|red|tournament|event|rune|keystone|item|spell/i;

const ENTITY_FIELDS = new Set([
  "player", "playerA", "playerB", "realName", "nativeName", "champion", "team", "teamA", "teamB", "blue", "red", "winner", "forfeitedBy",
  "name", "keystone", "rune", "item", "event", "tournament", "chosen", "alternatives", "mention",
]);

const FRENCH_LETTER = /[àâçéèêëîïôûùüœ]/;
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;
const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}'’]|[.,](?=\p{N}))*/gu;
const LEAGUE_NAMES = LEAGUES.flatMap((l) => [l.name, l.short]).toSorted((a, b) => b.length - a.length);

export type FrenchText = { field: string; word: string; text: string };

export type ShownStep = { step: string; title: string };

const words = (text: string) => text.match(WORD) ?? [];

const capitalized = (word: string) => word[0] !== word[0]!.toLowerCase();

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Span = [number, number];

const leagueSpans = (text: string): Span[] =>
  LEAGUE_NAMES.flatMap((name) => [...text.matchAll(new RegExp(`(?<![\\p{L}])${escaped(name)}(?![\\p{L}])`, "gu"))].map((m): Span => [m.index, m.index + m[0].length]));

const nameSpans = (text: string, names: string[]): Span[] =>
  names.flatMap((name) => {
    const spans: Span[] = [];

    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) spans.push([at, at + name.length]);

    return spans;
  });

const blanked = (text: string, spans: Span[]) => spans.reduce((t, [from, to]) => t.slice(0, from) + " ".repeat(to - from) + t.slice(to), text);

type Data = { all: string[]; entities: string[] };

const Json = z.json();
const Text = z.string();
const List = z.array(Json);
const Fields = z.record(z.string(), Json);

function answerData(answer: Answer): Data {
  const data: Data = { all: [], entities: [] };

  const walk = (value: z.infer<typeof Json>, entity: boolean) => {
    const text = Text.safeParse(value);

    if (text.success) {
      data.all.push(text.data);

      if (entity) data.entities.push(text.data);

      return;
    }

    for (const item of List.safeParse(value).data ?? []) walk(item, entity);

    for (const [key, item] of Object.entries(Fields.safeParse(value).data ?? {})) walk(item, ENTITY_FIELDS.has(key));
  };

  walk(Json.parse(JSON.parse(JSON.stringify({ ...answer, title: "", summary: "", notes: [], followUps: [], table: null }))), false);

  const columns = answer.table?.columns ?? [];

  for (const row of answer.table?.rows ?? [])
    for (const [i, cell] of row.entries()) {
      const text = Text.safeParse(cell);

      if (!text.success) continue;
      data.all.push(text.data);

      if (ENTITY_COLUMN.test(columns[i] ?? "")) data.entities.push(text.data);
    }

  return data;
}

const namedWords = (data: string[]): Set<string> => new Set(data.flatMap(words).filter(capitalized));


function quoteSpans(text: string, question: string): Span[] {
  const asked = question.match(TOKEN) ?? [];
  const shown = [...text.matchAll(TOKEN)];
  const spans: Span[] = [];

  for (let i = 0; i < shown.length; i++)
    for (let j = 0; j < asked.length; j++) {
      let n = 0;

      while (i + n < shown.length && j + n < asked.length && shown[i + n]![0] === asked[j + n]) n++;

      if (n >= 2) spans.push([shown[i]!.index, shown[i + n - 1]!.index + shown[i + n - 1]![0].length]);
    }

  return spans;
}

const isFrench = (word: string, named: Set<string>) => {
  const lower = word.toLowerCase();

  return !named.has(word) && (FRENCH_WORDS.has(lower) || FRENCH_LETTER.test(lower));
};

export function frenchInEnglishAnswer(question: string, answer: Answer, steps: ShownStep[], englishQuestion: boolean): FrenchText[] {
  const data = answerData(answer);
  const named = namedWords(data.entities);
  const names = [...new Set(data.entities.filter((d) => words(d).length > 1))].toSorted((a, b) => b.length - a.length);

  const shown: [string, string][] = [
    ["title", answer.title],
    ["summary", answer.summary],
    ...answer.notes.map((n): [string, string] => ["note", n]),
    ...(answer.table?.columns ?? []).map((c): [string, string] => ["column", c]),
    ...(englishQuestion ? answer.followUps.map((f): [string, string] => ["follow-up", f]) : []),
    ...steps.map((s): [string, string] => [`step ${s.step}`, s.title]),
  ];

  return shown.flatMap(([field, text]) => {
    const word = words(blanked(text, [...quoteSpans(text, question), ...leagueSpans(text), ...nameSpans(text, names)])).find((w) => isFrench(w, named));

    return word ? [{ field, word, text }] : [];
  });
}
