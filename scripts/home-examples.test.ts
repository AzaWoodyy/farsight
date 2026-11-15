import { expect, test } from "bun:test";
import { byCategory, CATEGORIES, nextPicks, PICK_CSS, readPicks } from "../src/app/home-examples-data";

const counts = CATEGORIES.map((c) => byCategory(c).length);

test("a new draw never repeats the example shown in a category, whatever the random value", () => {
  for (const random of [0, 0.25, 0.5, 0.999999]) {
    for (let start = 0; start < Math.max(...counts); start++) {
      const shown = counts.map((n) => start % n);
      const next = nextPicks(shown, () => random);

      next.forEach((pick, i) => {
        expect(Number.isInteger(pick) && pick >= 0 && pick < counts[i]).toBe(true);

        if (counts[i] > 1) expect(pick).not.toBe(shown[i]);
      });
    }
  }
});

test("successive draws reach every example of each category", () => {
  let shown = counts.map(() => 0);
  const seen = counts.map(() => new Set<number>([0]));

  for (let k = 0; k < 200; k++) {
    shown = nextPicks(shown);
    shown.forEach((pick, i) => seen[i].add(pick));
  }

  seen.forEach((s, i) => expect(s.size).toBe(counts[i]));
});

test("the inline draw hides the undrawn examples without removing their place", () => {
  expect(PICK_CSS.endsWith("{visibility:hidden}")).toBe(true);
  expect(PICK_CSS).not.toContain("display:none");
});

test("picks read back from <html> fall back to the first example when missing or out of range", () => {
  const attrs = new Map([["data-ex0", "1"], ["data-ex1", "99"], ["data-ex2", "-1"]]);
  const root = { getAttribute: (name: string) => attrs.get(name) ?? null };

  expect(readPicks(root)).toEqual([1, 0, 0, 0]);
});
