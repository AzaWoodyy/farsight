import { expect, test } from "bun:test";
import { readFacts } from "../src/app/how/facts";
import { LEAGUES } from "../src/lib/domain/leagues";

const inlined = JSON.stringify({
  built: "2026-11-17T20:24:53.903Z",
  leagues: [
    { league: "Tencent LoL Pro League", games: 10, ingame: 0, first_ingame: null },
    { league: "World Championship", games: 5, ingame: 4, first_ingame: 2014 },
    { league: "LoL Champions Korea", games: 7, ingame: 7, first_ingame: 2016 },
  ],
});

test("the page's figures come from what the build inlined, without opening the database", () => {
  const facts = readFacts(inlined);

  expect(facts.releaseDay).toBe("2026-11-17");
  expect([facts.games, facts.ingame, facts.firstIngameYear]).toEqual([22, 11, 2014]);
  expect(facts.leagues.map((l) => l.name)).toEqual(LEAGUES.map((l) => l.name));
  expect(facts.leagues.find((l) => l.short === "LPL")).toMatchObject({ games: 10, ingame: 0 });
  expect(facts.leagues.find((l) => l.short === "LEC")).toMatchObject({ games: 0, ingame: 0 });
});

test("without inlined figures the page fails with what to run, rather than showing zeros", () => {
  expect(() => readFacts("")).toThrow("DATABASE_URL");
});
