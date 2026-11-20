import { afterAll, describe, expect, test } from "bun:test";
import { understandQuestion } from "../src/lib/agent/understand";
import { testDb } from "./fixtures/test-db";

describe("a single year after a period word: depuis / jusqu'en include it, après / avant do not", async () => {
  const db = await testDb();

  await db.exec(`
    INSERT INTO players(id,page) VALUES (1,'Faker');
    INSERT INTO player_aliases VALUES ('faker','Faker',1);
  `);

  afterAll(() => db.close());

  test.each([
    ["Faker depuis 2016", 2016, null],
    ["Faker since 2016", 2016, null],
    ["Faker après 2016", 2017, null],
    ["Faker apres 2016", 2017, null],
    ["Faker after 2016", 2017, null],
    ["Faker jusqu'en 2020", null, 2020],
    ["Faker until 2020", null, 2020],
    ["Faker avant 2020", null, 2019],
    ["Faker before 2020", null, 2019],
    ["Faker en 2020", 2020, 2020],
    ["Faker de 2018 à 2020", 2018, 2020],
    // Two years are still read as their min–max range.
    ["Faker avant 2020 et après 2016", 2016, 2020],
  ] as const)("%s → %p, %p", async (q, yearFrom, yearTo) => {
    const entities = (await understandQuestion(db, q, new Date("2026-11-14")))?.result;

    expect(entities?.players.map((p) => p.player)).toEqual(["Faker"]);
    expect({ yearFrom: entities?.yearFrom, yearTo: entities?.yearTo }).toEqual({ yearFrom, yearTo });
  });
});
