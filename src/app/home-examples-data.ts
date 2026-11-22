import type { Locale } from "@/lib/locale";

export const CATEGORIES = ["players", "teams", "champions", "games"] as const;

export type Category = (typeof CATEGORIES)[number];

export type Example = { question: string; category: Category };

export const EXAMPLES: Record<Locale, Example[]> = {
  fr: [
    { category: "players", question: "Résultats de Chovy à tous les Worlds" },
    { category: "players", question: "Faker contre Chovy" },
    { category: "players", question: "Champion pool de Faker" },
    { category: "players", question: "Meilleurs mids aux Worlds 2026" },
    { category: "players", question: "Forme récente de Faker" },
    { category: "teams", question: "KC contre MKOI" },
    { category: "teams", question: "Samsung White roster 2014" },
    { category: "teams", question: "ADC de T1" },
    { category: "teams", question: "Champion pool de T1 aux Worlds 2025" },
    { category: "teams", question: "Qui prend le plus souvent le premier dragon au MSI 2023 ?" },
    { category: "teams", question: "Équipes au meilleur winrate côté bleu en LEC 2025" },
    { category: "champions", question: "Stats d'Azir aux Worlds 2025" },
    { category: "champions", question: "Champions les plus bannis en LCK 2025" },
    { category: "champions", question: "Champions les plus joués aux Worlds 2024" },
    { category: "champions", question: "Items de Yunara aux Worlds 2026" },
    { category: "champions", question: "Champions avec le plus de morts par game aux Worlds 2026" },
    { category: "champions", question: "Azir contre Orianna en mid" },
    { category: "games", question: "Finale des Worlds 2025" },
    { category: "games", question: "Récap de la game 5 de la finale des Worlds 2024" },
    { category: "games", question: "Classement des Worlds 2023" },
    { category: "games", question: "Record de kills en une partie aux Worlds" },
  ],
  en: [
    { category: "players", question: "Chovy's results at every Worlds" },
    { category: "players", question: "Faker vs Chovy" },
    { category: "players", question: "Faker's champion pool" },
    { category: "players", question: "Best mids at Worlds 2026" },
    { category: "players", question: "Faker's recent form" },
    { category: "teams", question: "KC vs MKOI" },
    { category: "teams", question: "Samsung White roster 2014" },
    { category: "teams", question: "T1's ADC" },
    { category: "teams", question: "T1's champion pool at Worlds 2025" },
    { category: "teams", question: "Who takes the first dragon most often at MSI 2023?" },
    { category: "teams", question: "Teams with the best blue side winrate in LEC 2025" },
    { category: "champions", question: "Azir stats at Worlds 2025" },
    { category: "champions", question: "Most banned champions in LCK 2025" },
    { category: "champions", question: "Most played champions at Worlds 2024" },
    { category: "champions", question: "Yunara items at Worlds 2026" },
    { category: "champions", question: "Champions with the most deaths per game at Worlds 2026" },
    { category: "champions", question: "Azir vs Orianna mid" },
    { category: "games", question: "Worlds 2025 final" },
    { category: "games", question: "Recap of game 5 of the Worlds 2024 final" },
    { category: "games", question: "Worlds 2023 standings" },
    { category: "games", question: "Most kills in a game at Worlds" },
  ],
};

export const byCategory = (locale: Locale, c: Category) => EXAMPLES[locale].filter((e) => e.category === c);

const ROWS = 4;

export function exampleRows(locale: Locale): Example[][] {
  const groups = CATEGORIES.map((c) => byCategory(locale, c));
  const rounds = Math.max(...groups.map((g) => g.length));
  const order = Array.from({ length: rounds }, (_, n) => groups.flatMap((g) => g.slice(n, n + 1))).flat();

  return Array.from({ length: ROWS }, (_, row) => order.filter((_, i) => (i + Math.floor(i / ROWS)) % ROWS === row));
}
