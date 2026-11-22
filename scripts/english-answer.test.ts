import { expect, test } from "bun:test";
import type { Answer } from "../src/lib/agent/types";
import { frenchInEnglishAnswer, type ShownStep } from "./english-answer";

function answer(over: Partial<Answer>): Answer {
  return {
    title: "Team ranking — win % (LEC 2025)",
    summary: "Teams ranked in LEC in 2025 by win %: 1. G2 Esports: 70%, 40 games.",
    rows: [], table: null, timeline: null, scoreboard: null, versus: null, teams: null, roster: null, champion: null, pool: null, runes: null, series: null,
    icons: {}, iconTones: {}, teamLeagues: {}, profiles: [], sources: [], followUps: [], notes: [],
    meta: { route: "team_leaderboard", sqlAvailable: false, input: null, players: [], teams: [], champion: null, league: null, rowCount: 1, totals: {}, ambiguities: [], attempts: 1, unread: [], empty: null },
    ...over,
  };
}

const step = (title: string): ShownStep => ({ step: "execute", title });
const words = (found: ReturnType<typeof frenchInEnglishAnswer>) => found.map((f) => `${f.field}: ${f.word}`);

test("an English answer reads clean", () => {
  expect(frenchInEnglishAnswer("LEC 2025 team ranking", answer({}), [], true)).toEqual([]);
});

test("French the site wrote is found wherever it shows: a column (#127), a league preposition (#141), a step (#161)", () => {
  const leaked = answer({ table: { columns: ["#", "Team", "% victoires"], rows: [] }, summary: "Faker's runes (aux Worlds in 2019) over 14 games." });

  expect(words(frenchInEnglishAnswer("Faker runes at Worlds 2019", leaked, [step("Timeline ESPORTSTMNT01_1: lecture de plus de 4 s")], true))).toEqual([
    "summary: aux",
    "column: victoires",
    "step execute: lecture",
  ]);
});

test("a French word next to a league name is still French, and a table's rows name its teams", () => {
  expect(words(frenchInEnglishAnswer("Who won?", answer({ summary: "Winner de la LEC 2025: G2 Esports." }), [], true))).toEqual(["summary: de"]);
  expect(words(frenchInEnglishAnswer("Who won?", answer({ table: { columns: ["Rang", "Team"], rows: [] } }), [], true))).toEqual(["column: Rang"]);

  const ranked = answer({ summary: "Winners of LES: Movistar KOI Fénix (3).", table: { columns: ["#", "Team"], rows: [[1, "Movistar KOI Fénix"]] } });
  expect(frenchInEnglishAnswer("LES winners", ranked, [], true)).toEqual([]);
});

test.each(["Poste", "Statut", "Nombre", "Finaliste", "arbre", "Rang", "Vainqueur", "Morts", "Plaques"])("the column label %s is French", (label) => {
  expect(words(frenchInEnglishAnswer("Who won?", answer({ table: { columns: ["#", label], rows: [] } }), [], true))).toEqual([`column: ${label}`]);
});

test("a localized scope the answer also keeps in its data is still French in the title", () => {
  const roster = answer({ title: "T1 roster au split Spring in LCK", teamLeagues: { T1: ["au split Spring in LCK"] } });

  expect(words(frenchInEnglishAnswer("T1 roster", roster, [], true))).toEqual(["title: au"]);
});

test("names, the visitor's own words and their follow-ups are not French the site wrote", () => {
  const named = answer({
    summary: "Most titles: Movistar KOI Fénix (3). Data missing: in-game statistics (âmes du dragon) for the LPL.",
    notes: ['"Uzi" names several players: Uzi (Lê Thanh Hà) (4 games).'],
    followUps: ["résultats de Knight"],
    meta: { ...answer({}).meta, ambiguities: [{ mention: "Uzi", chosen: "Uzi", alternatives: ["Uzi (Lê Thanh Hà)"], uncertain: false }], totals: { champion: "Movistar KOI Fénix" } },
  });

  expect(frenchInEnglishAnswer("âmes du dragon en LPL 2025", named, [], false)).toEqual([]);
});
