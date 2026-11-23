import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

test("every application environment variable is documented with an empty value", () => {
  const example = readFileSync(".env.example", "utf8");
  const platform = /^((?:NEXT_PUBLIC_)?VERCEL(?:_.*)?|NODE_ENV|PATH|CI|GITHUB_.*|RUNNER_TEMP|HOW_FACTS|HOME_PROOFS)$/;
  const missing = new Set<string>();

  for (const root of ["src", "scripts"]) {
    for (const path of new Glob("**/*.{ts,tsx}").scanSync(root)) {
      if (path.endsWith(".test.ts")) continue;
      const code = readFileSync(`${root}/${path}`, "utf8");

      for (const match of code.matchAll(/process\.env\.([A-Z][A-Z_0-9]+)/g)) {
        if (!platform.test(match[1]) && !new RegExp(`^${match[1]}=$`, "m").test(example)) missing.add(match[1]);
      }
    }
  }

  expect([...missing]).toEqual([]);
});
