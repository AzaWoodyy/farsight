import { expect, test } from "bun:test";
import { affected, attribution, CHECKS, CODE_CHECKS, withSnapshotSchema } from "./affected";

const sorted = (values: Iterable<string>) => [...values].sort();

const cases: [string[], readonly string[]][] = [
  [[], []],
  [["README.md", "docs/audits/perf-ci.md"], []],
  [["src/app/page.tsx"], ["lint", "typecheck", "build"]],
  [["src/lib/agent/query.ts"], CHECKS.filter(check => check !== "database")],
  [["scripts/data/build.ts"], CHECKS],
  [["scripts/data/identity.ts"], CHECKS],
  [["scripts/data/ingame.ts"], CHECKS],
  [["scripts/data/fetch.ts"], ["lint", "typecheck", "test"]],
  [["scripts/tracing.test.ts"], ["lint", "typecheck", "test"]],
  [["eval/questions.json"], ["lint", "typecheck", "eval"]],
  [[".githooks/pre-push"], CODE_CHECKS],
  [[".github/workflows/ci.yml"], CODE_CHECKS],
  [["scripts/ci/select.ts"], CODE_CHECKS],
  [["ci/raw.tar.zst"], CHECKS],
  [["src/lib/db/schema.ts"], CHECKS],
  [["src/lib/domain/leagues.ts"], CHECKS],
  [["src/lib/sources/riot.ts"], CHECKS],
  [["package.json"], CHECKS],
  [["bun.lock"], CHECKS],
  [["data/raw/lines.json"], CHECKS],
  [["ci/data.json"], CHECKS],
  [["new dir/deleted.ts"], CODE_CHECKS],
  [["docs/x.md", "src/lib/db/index.ts"], CHECKS.filter(check => check !== "database")],
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

test("a snapshot of another schema version rebuilds the database for the checks that open it", () => {
  const app = affected(["src/lib/agent/query.ts"]);

  expect(withSnapshotSchema(app, 6, 6).has("database")).toBe(false);
  expect(withSnapshotSchema(app, 5, 6).has("database")).toBe(true);
  // Lint and tests alone never open the pinned database.
  expect(sorted(withSnapshotSchema(affected(["scripts/roster.test.ts"]), 5, 6))).toEqual(["lint", "test", "typecheck"]);
  expect(sorted(withSnapshotSchema(affected(["README.md"]), 5, 6))).toEqual([]);
});
