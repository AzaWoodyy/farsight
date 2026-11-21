import { expect, test } from "bun:test";
import { affected, attribution, CHECKS, pushBase } from "./affected";

const sorted = (values: Iterable<string>) => [...values].sort();

const cases: [string[], readonly string[]][] = [
  [[], []],
  [["README.md", "docs/audits/perf-ci.md"], []],
  [["src/app/page.tsx"], ["lint", "typecheck", "build"]],
  [["src/lib/agent/query.ts"], CHECKS],
  [["scripts/data/derive.ts"], CHECKS],
  [["scripts/data/identity.ts"], CHECKS],
  [["scripts/data/ingame.ts"], CHECKS],
  [["scripts/data/fetch.ts"], ["lint", "typecheck", "test"]],
  [["scripts/tracing.test.ts"], ["lint", "typecheck", "test"]],
  [["eval/questions.json"], ["lint", "typecheck", "eval"]],
  [[".githooks/pre-push"], CHECKS],
  [[".github/workflows/ci.yml"], CHECKS],
  [["scripts/ci/select.ts"], CHECKS],
  [["ci/raw.tar.zst"], CHECKS],
  [["src/lib/db/schema.ts"], CHECKS],
  [["src/lib/domain/leagues.ts"], CHECKS],
  [["src/lib/sources/riot.ts"], CHECKS],
  [["package.json"], CHECKS],
  [["bun.lock"], CHECKS],
  [["data/raw/lines.json"], CHECKS],
  [["ci/data.json"], CHECKS],
  [["new dir/deleted.ts"], CHECKS],
  [["docs/x.md", "src/lib/db/index.ts"], CHECKS],
  [["src/app/old.tsx", "scripts/data/new.ts"], CHECKS],
];

test.each(cases)("affected %j", (paths, expected) => {
  expect(sorted(affected(paths))).toEqual(sorted(expected));
});

test("the attribution guard targets credits, while technical model names remain valid", () => {
  expect(attribution.test("Co-Authored-By: Claude <noreply@anthropic.com>")).toBe(true);
  expect(attribution.test("Generated with Codex")).toBe(true);
  expect(attribution.test("Support OpenRouter and Claude models")).toBe(false);
});

test("a push on main is compared with the newest validated ancestor, and with nothing when there is none", () => {
  const [newest, older, oldest, after] = ["a", "b", "c", "d"].map(char => char.repeat(40));
  const ancestors = new Set([newest, older, oldest]);
  const isAncestor = (sha: string) => ancestors.has(sha);
  const always = () => true;

  expect(pushBase([newest, older], after, isAncestor, always)).toBe(newest);
  expect(pushBase(["e".repeat(40), older], after, isAncestor, always)).toBe(older);
  expect(pushBase([after, oldest], after, always, always)).toBe(oldest);
  expect(pushBase(["not-a-sha", "A".repeat(40), oldest], after, isAncestor, always)).toBe(oldest);
  expect(pushBase([], after, isAncestor, always)).toBeNull();
  expect(pushBase(["e".repeat(40)], after, isAncestor, always)).toBeNull();
  expect(pushBase([newest, older], after, isAncestor, sha => sha === older)).toBe(older);
  expect(pushBase([newest, older], after, isAncestor, () => false)).toBeNull();
});
