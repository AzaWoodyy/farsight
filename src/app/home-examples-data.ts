import type { Locale } from "@/lib/locale";

/**
 * Home examples, grouped by what the question is about. Each one is answered by a typed tool without the
 * LLM (checked with `bun run ask`); `display` names the layout the question opens.
 */
export const CATEGORIES = ["players", "teams", "champions", "games"] as const;

export type Category = (typeof CATEGORIES)[number];

export type Example = { question: string; display: string; category: Category };

/** The same examples in each language, in the same order. The English questions take the same route as the French ones. */
export const EXAMPLES: Record<Locale, Example[]> = {
  fr: [
    { category: "players", question: "Résultats de Chovy à tous les Worlds", display: "palmarès" },
    { category: "players", question: "Faker contre Chovy", display: "duel de joueurs" },
    { category: "players", question: "Champion pool de Faker", display: "champion pool" },
    { category: "players", question: "Meilleurs mids aux Worlds 2026", display: "classement de joueurs" },
    { category: "players", question: "Forme récente de Faker", display: "dernières parties" },
    { category: "teams", question: "KC contre MKOI", display: "confrontation d'équipes" },
    { category: "teams", question: "Samsung White roster 2014", display: "roster" },
    { category: "teams", question: "ADC de T1", display: "joueur d'un poste" },
    { category: "teams", question: "Champion pool de T1 aux Worlds 2025", display: "champion pool d'équipe" },
    { category: "teams", question: "Qui prend le plus souvent le premier dragon au MSI 2023 ?", display: "classement in-game d'équipes" },
    { category: "teams", question: "Équipes au meilleur winrate côté bleu en LEC 2025", display: "classement d'équipes" },
    { category: "champions", question: "Stats d'Azir aux Worlds 2025", display: "fiche champion" },
    { category: "champions", question: "Champions les plus bannis en LCK 2025", display: "classement de champions" },
    { category: "champions", question: "Champions les plus joués aux Worlds 2024", display: "méta d'un tournoi" },
    { category: "champions", question: "Items de Yunara aux Worlds 2026", display: "fiche champion et items" },
    { category: "champions", question: "Champions avec le plus de morts par game aux Worlds 2026", display: "moyenne par partie" },
    { category: "champions", question: "Azir contre Orianna en mid", display: "matchup de champions" },
    { category: "games", question: "Finale des Worlds 2025", display: "série en BO, game par game" },
    { category: "games", question: "Récap de la game 5 de la finale des Worlds 2024", display: "récap de partie" },
    { category: "games", question: "Classement des Worlds 2023", display: "classement de tournoi" },
    { category: "games", question: "Record de kills en une partie aux Worlds", display: "records sur une partie" },
  ],
  en: [
    { category: "players", question: "Chovy's results at every Worlds", display: "track record" },
    { category: "players", question: "Faker vs Chovy", display: "player duel" },
    { category: "players", question: "Faker's champion pool", display: "champion pool" },
    { category: "players", question: "Best mids at Worlds 2026", display: "player ranking" },
    { category: "players", question: "Faker's recent form", display: "latest games" },
    { category: "teams", question: "KC vs MKOI", display: "team head-to-head" },
    { category: "teams", question: "Samsung White roster 2014", display: "roster" },
    { category: "teams", question: "T1's ADC", display: "player in a role" },
    { category: "teams", question: "T1's champion pool at Worlds 2025", display: "team champion pool" },
    { category: "teams", question: "Who takes the first dragon most often at MSI 2023?", display: "in-game team ranking" },
    { category: "teams", question: "Teams with the best blue side winrate in LEC 2025", display: "team ranking" },
    { category: "champions", question: "Azir stats at Worlds 2025", display: "champion profile" },
    { category: "champions", question: "Most banned champions in LCK 2025", display: "champion ranking" },
    { category: "champions", question: "Most played champions at Worlds 2024", display: "tournament meta" },
    { category: "champions", question: "Yunara items at Worlds 2026", display: "champion profile and items" },
    { category: "champions", question: "Champions with the most deaths per game at Worlds 2026", display: "per-game average" },
    { category: "champions", question: "Azir vs Orianna mid", display: "champion matchup" },
    { category: "games", question: "Worlds 2025 final", display: "best-of series, game by game" },
    { category: "games", question: "Recap of game 5 of the Worlds 2024 final", display: "game recap" },
    { category: "games", question: "Worlds 2023 standings", display: "tournament standings" },
    { category: "games", question: "Most kills in a game at Worlds", display: "single-game records" },
  ],
};

export const byCategory = (locale: Locale, c: Category) => EXAMPLES[locale].filter((e) => e.category === c);

/** Number of rows the home examples drift on. */
const ROWS = 4;

/**
 * The examples dealt on the rows of the home page. They are first taken one subject after the other, then each
 * round of subjects is dealt one row further than the round before: every row mixes the subjects, and two
 * neighbours seldom look alike.
 */
export function exampleRows(locale: Locale): Example[][] {
  const groups = CATEGORIES.map((c) => byCategory(locale, c));
  const rounds = Math.max(...groups.map((g) => g.length));
  const order = Array.from({ length: rounds }, (_, n) => groups.flatMap((g) => g.slice(n, n + 1))).flat();

  return Array.from({ length: ROWS }, (_, row) => order.filter((_, i) => (i + Math.floor(i / ROWS)) % ROWS === row));
}
