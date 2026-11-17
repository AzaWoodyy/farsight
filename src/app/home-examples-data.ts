import { DEFAULT_LOCALE, type Locale } from "@/lib/locale";

/**
 * Home examples, grouped by what the question is about. Each one is answered by a typed tool without the
 * LLM (checked with `bun run ask`); `display` names the layout the question opens.
 *
 * Kept out of the client component so that the page (a server component) can ship the draw script below.
 */
export const CATEGORIES = ["players", "teams", "champions", "games"] as const;

export type Category = (typeof CATEGORIES)[number];

export type Example = { question: string; display: string; category: Category };

/**
 * The same examples in each language, in the same order: the draw is made on positions, before the page
 * knows its language (see PICK_SCRIPT). The English questions take the same route as the French ones.
 */
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

// Every language has the same examples: the counts of the default one are the counts of all.
const COUNTS = CATEGORIES.map((c) => byCategory(DEFAULT_LOCALE, c).length);

const ATTR = "data-ex";

/** Attribute of `<html>` holding the example drawn for category `i`. */
const pickAttr = (i: number) => `${ATTR}${i}`;

/**
 * The random draw happens in the static HTML, before the first paint: this script, placed ahead of the
 * examples, sets one attribute per category on `<html>`, and PICK_CSS hides every other example of the
 * category. The visitor reads the drawn examples from the first frame, on a slow connection too, and
 * hydration keeps them (it reads the same attributes) instead of swapping texts on screen.
 */
export const PICK_SCRIPT = `try{var d=document.documentElement;${JSON.stringify(COUNTS)}.forEach(function(n,i){d.setAttribute("${ATTR}"+i,Math.floor(Math.random()*n))})}catch(e){}`;

// Without the attribute (the script did not run), the first example of each category stays visible. The others are
// hidden but keep their place: every example of a category sits in the same grid cell, so the block is as tall as
// its longest example from the first frame, and a later draw changes no height.
export const PICK_CSS = `${COUNTS.flatMap((n, i) => [
  `:root:not([${pickAttr(i)}]) [data-c="${i}"]>[data-i]:not([data-i="0"])`,
  ...Array.from({ length: n }, (_, p) => `:root[${pickAttr(i)}="${p}"] [data-c="${i}"]>[data-i]:not([data-i="${p}"])`),
]).join(",")}{visibility:hidden}`;

/** The draw read back on the client; out-of-range or missing values fall back to the first example. */
export function readPicks(root: Pick<Element, "getAttribute">): number[] {
  return COUNTS.map((n, i) => {
    const v = Number(root.getAttribute(pickAttr(i)));

    return Number.isInteger(v) && v >= 0 && v < n ? v : 0;
  });
}

/** Delay between two automatic draws on the home page: time to read four short questions. */
export const ROTATE_MS = 7000;

/**
 * A new draw: in each category with more than one example, another example than the one shown, so the same set
 * never comes back twice in a row. `random` returns a number in [0, 1), like Math.random.
 */
export function nextPicks(shown: readonly number[], random: () => number = Math.random): number[] {
  return COUNTS.map((n, i) => {
    const current = shown[i] ?? 0;

    return n < 2 ? 0 : (current + 1 + Math.floor(random() * (n - 1))) % n;
  });
}
