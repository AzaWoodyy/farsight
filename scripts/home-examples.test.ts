import { expect, test } from "bun:test";
import { CATEGORIES, EXAMPLES, exampleRows } from "../src/app/home-examples-data";

test("every language has the same examples, category by category", () => {
  expect(EXAMPLES.en.map((e) => e.category)).toEqual(EXAMPLES.fr.map((e) => e.category));
});

test("the rows of the home page hold every example exactly once", () => {
  for (const locale of ["fr", "en"] as const) {
    const dealt = exampleRows(locale).flat();

    expect(dealt).toHaveLength(EXAMPLES[locale].length);
    expect(new Set(dealt).size).toBe(EXAMPLES[locale].length);
  }
});

test("every row mixes the subjects and none is left short", () => {
  const rows = exampleRows("fr");
  const sizes = rows.map((row) => row.length);

  expect(rows).toHaveLength(4);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);

  for (const row of rows) expect(new Set(row.map((e) => e.category)).size).toBeGreaterThanOrEqual(CATEGORIES.length - 1);
});
