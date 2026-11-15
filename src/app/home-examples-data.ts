/**
 * Home examples, grouped by what the question is about. Each one is answered by a typed tool without the
 * LLM (checked with `bun run ask`); `display` names the layout the question opens.
 *
 * Kept out of the client component so that the page (a server component) can ship the draw script below.
 */
export const CATEGORIES = ["joueurs", "équipes", "champions", "parties"] as const;

export type Category = (typeof CATEGORIES)[number];

export type Example = { question: string; display: string; category: Category };

export const EXAMPLES: Example[] = [
  { category: "joueurs", question: "Résultats de Chovy à tous les Worlds", display: "palmarès" },
  { category: "joueurs", question: "Faker contre Chovy", display: "duel de joueurs" },
  { category: "joueurs", question: "Champion pool de Faker", display: "champion pool" },
  { category: "joueurs", question: "Meilleurs mids aux Worlds 2026", display: "classement de joueurs" },
  { category: "équipes", question: "KC contre MKOI", display: "confrontation d'équipes" },
  { category: "équipes", question: "Samsung White roster 2014", display: "roster" },
  { category: "équipes", question: "ADC de T1", display: "joueur d'un poste" },
  { category: "équipes", question: "Champion pool de T1 aux Worlds 2025", display: "champion pool d'équipe" },
  { category: "équipes", question: "Qui prend le plus souvent le premier dragon au MSI 2023 ?", display: "classement in-game d'équipes" },
  { category: "champions", question: "Stats d'Azir aux Worlds 2025", display: "fiche champion" },
  { category: "champions", question: "Champions les plus bannis en LCK 2025", display: "classement de champions" },
  { category: "champions", question: "Champions les plus joués aux Worlds 2024", display: "méta d'un tournoi" },
  { category: "champions", question: "Items de Yunara aux Worlds 2026", display: "fiche champion et items" },
  { category: "champions", question: "Champions avec le plus de morts par game aux Worlds 2026", display: "moyenne par partie" },
  { category: "parties", question: "Finale des Worlds 2025", display: "série en BO, game par game" },
  { category: "parties", question: "Récap de la game 5 de la finale des Worlds 2024", display: "récap de partie" },
  { category: "parties", question: "Classement des Worlds 2023", display: "classement de tournoi" },
];

export const byCategory = (c: Category) => EXAMPLES.filter((e) => e.category === c);

const COUNTS = CATEGORIES.map((c) => byCategory(c).length);

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
