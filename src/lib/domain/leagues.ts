/**
 * The LES by its full name, in any case, or by its acronym in capitals before a year or after "en", "la", "in",
 * "the" ("classement LES 2026", "Résultats de X en LES"): "les" is a French article. Written without the `i`
 * flag (a case-sensitive part needs no regex modifier, which older browsers cannot parse).
 */
const LES_CUE = /\b[Ll][Ii][Gg][Aa] [Ee][Ss][Pp][Aa][ÑñNn][Oo][Ll][Aa]( [Dd][Ee] [Ll][Ee][Aa][Gg][Uu][Ee] [Oo][Ff] [Ll][Ee][Gg][Ee][Nn][Dd][Ss])?(?![\p{L}])|\bLES(?= \d{4}\b)|(?<=\b(?:[Ee][Nn]|[Ll][Aa]|[Ii][Nn]|[Tt][Hh][Ee]) )LES\b/u;

/** Fixed ingestion and query scope. Cues are matched by longest text, not declaration order. */
export const LEAGUES = [
  { name: "World Championship", short: "Worlds", region: "International", international: true, cue: /\b(world championship|worlds?|mondiaux|mondial|championnats? du monde|coupe du monde)\b/i, family: "", from: 2011, to: null },
  { name: "Mid-Season Invitational", short: "MSI", region: "International", international: true, cue: /\b(msi|mid[- ]season invitational)\b/i, family: "", from: 2011, to: null },
  { name: "First Stand", short: "First Stand", region: "International", international: true, cue: /\bfirst stand\b/i, family: "", from: 2011, to: null },
  { name: "Esports World Cup", short: "EWC", region: "International", international: true, cue: /\b(e-?sports? world cup|world cup|ewc|coupe du monde (de l['’]|des )e-?sports?)\b/i, family: "", from: 2011, to: null },
  { name: "LoL The Champions", short: "OGN Champions", region: "Korea", international: false, cue: /\b(ogn|champions korea \d{4}|the champions)\b/i, family: "LCK", from: 2011, to: 2015 },
  { name: "LoL Champions Korea", short: "LCK", region: "Korea", international: false, cue: /\blck\b/i, family: "LCK", from: 2016, to: null },
  { name: "LCK Challengers League", short: "LCK CL", region: "Korea", international: false, cue: /\b(lck cl|lck challengers)\b/i, family: "", from: 2011, to: null },
  { name: "Challengers Korea", short: "CK", region: "Korea", international: false, cue: /\bchallengers korea\b/i, family: "", from: 2011, to: null },
  { name: "KeSPA Cup", short: "KeSPA Cup", region: "Korea", international: false, cue: /\bkespa( cup)?\b/i, family: "", from: 2011, to: null },
  { name: "LCK Academy Series", short: "LCK AS", region: "Korea", international: false, cue: /\blck (as|academy)\b/i, family: "", from: 2011, to: null },
  { name: "Tencent LoL Pro League", short: "LPL", region: "China", international: false, cue: /\blpl\b/i, family: "", from: 2011, to: null },
  { name: "LoL Japan League", short: "LJL", region: "Japan", international: false, cue: /\bljl\b/i, family: "", from: 2011, to: null },
  { name: "Pacific Championship Series", short: "PCS", region: "Asia Pacific", international: false, cue: /\bpcs\b/i, family: "", from: 2011, to: null },
  { name: "Vietnam Championship Series", short: "VCS", region: "Vietnam", international: false, cue: /\bvcs\b/i, family: "", from: 2011, to: null },
  { name: "League of Legends Championship Pacific", short: "LCP", region: "Asia Pacific", international: false, cue: /\blcp\b/i, family: "", from: 2011, to: null },
  { name: "Europe League Championship Series", short: "EU LCS", region: "Europe", international: false, cue: /\beu ?lcs\b/i, family: "LEC", from: 2011, to: 2018 },
  { name: "LoL EMEA Championship", short: "LEC", region: "Europe", international: false, cue: /\blec\b/i, family: "LEC", from: 2019, to: null },
  { name: "European Masters", short: "EU Masters", region: "Europe", international: false, cue: /\b(eu masters|european masters)\b/i, family: "EM", from: 2011, to: 2022 },
  { name: "EMEA Masters", short: "EMEA Masters", region: "Europe", international: false, cue: /\bemea masters\b/i, family: "EM", from: 2023, to: null },
  { name: "North America League Championship Series", short: "NA LCS", region: "North America", international: false, cue: /\bna ?lcs\b/i, family: "LCS", from: 2011, to: 2018 },
  { name: "League of Legends Championship Series", short: "LCS", region: "North America", international: false, cue: /\blcs\b/i, family: "LCS", from: 2019, to: null },
  { name: "League of Legends Championship of The Americas", short: "LTA", region: "Americas", international: false, cue: /\blta\b/i, family: "", from: 2011, to: null },
  { name: "League of Legends Championship of The Americas North", short: "LTA North", region: "North America", international: false, cue: /\blta (north|nord)\b/i, family: "", from: 2011, to: null },
  { name: "League of Legends Championship of The Americas South", short: "LTA South", region: "Brazil", international: false, cue: /\blta (south|sud)\b/i, family: "", from: 2011, to: null },
  { name: "Circuit Brazilian League of Legends", short: "CBLOL", region: "Brazil", international: false, cue: /\bcblol\b/i, family: "", from: 2011, to: null },
  { name: "La Ligue Française", short: "LFL", region: "France", international: false, cue: /\blfl\b/i, family: "", from: 2011, to: null },
  { name: "La Ligue Française Division 2", short: "LFL D2", region: "France", international: false, cue: /\b(lfl d(iv(ision)?)? ?2|div2)\b/i, family: "", from: 2011, to: null },
  { name: "LVP SuperLiga Orange", short: "SL Orange", region: "Spain", international: false, cue: /\b((lvp )?superliga orange|sl orange)\b/i, family: "SuperLiga", from: 2011, to: 2020 },
  { name: "LVP SuperLiga", short: "SuperLiga", region: "Spain", international: false, cue: /\b((lvp )?superliga|lvp)\b/i, family: "SuperLiga", from: 2021, to: 2025 },
  { name: "Liga Española de League of Legends", short: "LES", region: "Spain", international: false, cue: LES_CUE, family: "SuperLiga", from: 2026, to: null },
  { name: "LVP SuperLiga 2nd Division", short: "SL 2nd Div", region: "Spain", international: false, cue: /\b((lvp )?superliga (2(nd|e)?|second|segunda)( div(isi[oó]n)?)?|(lvp )?superliga div(isi[oó]n)? ?2|(lvp )?superliga d2|sl 2nd|segunda divisi[oó]n)\b/i, family: "", from: 2011, to: null },
] as const;

export type LeagueName = (typeof LEAGUES)[number]["name"];

export const LEAGUE_NAMES = LEAGUES.map((l) => l.name);

/**
 * Cross-league competitions of the scope: a team plays them besides its own league (a French team in the
 * LFL and in the EMEA Masters, an LCK team in the KeSPA Cup), so they never name the league a team is in. Worlds, MSI,
 * First Stand and the Esports World Cup are `international`.
 */
export const CUP_LEAGUES: ReadonlySet<LeagueName> = new Set(["European Masters", "EMEA Masters", "KeSPA Cup"]);

/** How French names a competition: "les Worlds", "le MSI", "l'EWC", "la LCK". */
export function frenchArticle(short: string): "les" | "le" | "l'" | "la" {
  if (short === "Worlds" || short.endsWith("Masters")) return "les";

  if (short === "EWC") return "l'";

  return short === "MSI" || short === "First Stand" ? "le" : "la";
}

/** "les Worlds", "l'EWC", "la LCK". */
export const frenchNamed = (short: string) => `${frenchArticle(short)}${frenchArticle(short) === "l'" ? "" : " "}${short}`;

/** "aux Worlds", "au MSI", "à l'EWC", "à la KeSPA Cup", "en LCK". */
export function frenchIn(short: string): string {
  const article = frenchArticle(short);

  if (article === "les") return `aux ${short}`;

  if (article === "le") return `au ${short}`;

  return article === "l'" || short.endsWith(" Cup") ? `à ${frenchNamed(short)}` : `en ${short}`;
}

/** "des Worlds", "du MSI", "de l'EWC", "de la LCK". */
export function frenchOf(short: string): string {
  const article = frenchArticle(short);

  return article === "les" ? `des ${short}` : article === "le" ? `du ${short}` : `de ${frenchNamed(short)}`;
}

/** English names an international event bare ("at Worlds", "at First Stand") and a league with "the" ("the EWC"). */
export const englishBare = (short: string) => short === "Worlds" || short === "MSI" || short === "First Stand" || short.endsWith("Masters");

/** "at Worlds", "at First Stand", "at the EWC", "at the KeSPA Cup", "in LCK". */
export function englishIn(short: string): string {
  if (englishBare(short) && !short.endsWith("Masters")) return `at ${short}`;

  return short === "EWC" || short.endsWith(" Cup") ? `at the ${short}` : `in ${short}`;
}

export const SCOPE_LABEL = LEAGUES.map((l) => l.short).join(", ");

/** Only current family names include historical names; explicit old names keep their meaning. */
export function leagueMembers(name: string, yearFrom: number | null, yearTo: number | null): string[] {
  if (yearFrom == null && yearTo == null) return [name];
  const league = LEAGUES.find((l) => l.name === name);

  if (!league?.family || league.to != null) return [name];

  return LEAGUES.flatMap((l) => l.family === league.family && (yearTo == null || l.from <= yearTo) && (yearFrom == null || l.to == null || l.to >= yearFrom) ? [l.name] : []);
}

export function eraLeague(name: LeagueName | null, from: number | null, to: number | null): LeagueName | null {
  if (!name) return null;
  const members = leagueMembers(name, from, to);

  return members.length === 1 ? LEAGUES.find((l) => l.name === members[0])!.name : name;
}

export function detectLeague(question: string): { league: LeagueName | null; mention: string | null } {
  const matches = LEAGUES.flatMap((l) => { const m = l.cue.exec(question);

 return m ? [{ league: l.name, mention: m[0] }] : []; });

  matches.sort((a,b) => b.mention.length - a.mention.length);

  return matches[0] ?? { league: null, mention: null };
}
