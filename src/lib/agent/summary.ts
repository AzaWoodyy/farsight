/** A rephrasing may omit facts, but may not permute or invent their numbers. */
const numbers = (text: string) => [...text.replaceAll("−", "-").matchAll(/(?<![\p{L}\p{N}])[+-]?\d+(?:[.,]\d+)?(?![\p{L}\p{N}])/gu)].map((m) => m[0].replace(",", "."));
const PERIODS = ["saison", "season", "cette année", "this year", "actuellement", "en cours", "currently"];
const INTERPRETATIONS = /\b(meilleur\w*|best|record|plus de deux|deux tiers|sur trois|majorit[ée]|domine\w*|more than two|two[- ]thirds|out of three|majority|dominat\w*)\b/giu;
const METRIC = /first blood|premi[eè]re tourelle|first tower|premier dragon|first dragon|premier baron|first baron/giu;

/** Words a sentence starts with, in French and in English: capitalized by grammar, not names. */
const STARTERS = new Set(
  ("Le La Les Un Une Au Aux En Sur Avec Il Elle Son Ses Cette Ces Dans " + "The A An In At On Over Across With He She They It His Her Their Its This These Of For From").split(" "),
);

const fold = (s: string) => s.toLocaleLowerCase().replaceAll(",", ".").replaceAll("−", "-");

function metricValues(text: string): Map<string, string[]> {
  const matches = [...text.matchAll(METRIC)];

  return new Map(matches.map((m, i) => [fold(m[0]), numbers(text.slice(m.index! + m[0].length, matches[i + 1]?.index))]));
}

export function claimsBeyondFacts(text: string, facts: string, question = ""): string[] {
  const issues: string[] = [];
  // A free paraphrase cannot prove which metric owns a number. Keep the original
  // numeric wording (decimal commas/punctuation may change) instead of guessing.
  const wording = (s: string) => fold(s).replace(/[^\p{L}\p{N}.%+-]+/gu, " ").replace(/\.$/, "").trim();

  if (/\d/.test(text) && !wording(facts).includes(wording(text))) issues.push("formulation chiffrée différente des faits");
  const known = numbers(facts);
  let index = 0;

  for (const n of numbers(text)) {
    while (index < known.length && known[index] !== n) index++;

    if (index === known.length) issues.push(`chiffre ou ordre : ${n}`);
    else index++;
  }

  const lower = fold(text), source = fold(facts);
  issues.push(...PERIODS.filter((w) => lower.includes(w) && !source.includes(w)));
  issues.push(...[...text.matchAll(INTERPRETATIONS)].flatMap((m) => !source.includes(fold(m[0])) ? [m[0]] : []));
  // Names and acronyms must already occur in the facts/question. Sentence starters are grammatical.
  const context = `${facts} ${question}`;

  for (const m of text.matchAll(/(?<![\p{L}\p{N}])[\p{Lu}][\p{L}\p{N}.]*(?:\.[\p{L}\p{N}]+)*/gu)) {
    if (!STARTERS.has(m[0]) && !context.includes(m[0])) issues.push(`nom : ${m[0]}`);
  }

  const factMetrics = metricValues(facts);

  for (const [metric, values] of metricValues(text)) {
    const expected = factMetrics.get(metric);

    if (expected && values.some((v, i) => expected[i] !== v)) issues.push(`métrique : ${metric}`);
  }

  return [...new Set(issues)];
}
