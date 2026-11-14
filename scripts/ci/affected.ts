/** Unknown paths run every code check; only data inputs and dependencies rebuild SQLite. */
export const CHECKS = ["lint", "typecheck", "test", "eval", "build", "database"] as const;

export type Check = (typeof CHECKS)[number];

export const CODE_CHECKS = CHECKS.filter(check => check !== "database");

const CODE: Check[] = ["lint", "typecheck"];

export function affected(paths: string[]): Set<Check> {
  const selected = new Set<Check>();

  for (const path of paths) {
    let checks: readonly Check[];

    if (/^(docs\/.*|[^/]+\.md|LICENSE)$/.test(path)) checks = [];
    else if (["package.json", "bun.lock", "ci/data.json", "ci/raw.tar.zst"].includes(path) || path.startsWith("data/")) checks = CHECKS;
    else if (path === "tsconfig.json" || /^(\.github\/|scripts\/ci\/|ci\/|\.githooks\/)/.test(path)) checks = CODE_CHECKS;
    else if (path.endsWith(".test.ts")) checks = [...CODE, "test"];
    else if (/^scripts\/data\/(fetch|sync)\.ts$/.test(path)) checks = [...CODE, "test"];
    else if (/^(scripts\/data\/|src\/lib\/sources\/|src\/lib\/domain\/)/.test(path) || path === "src/lib/aliases.ts" || path === "src/lib/db/schema.ts") checks = CHECKS;
    else if (path.startsWith("src/lib/")) checks = CHECKS.filter(check => check !== "database");
    else if (path.startsWith("eval/") || path === "scripts/eval.ts") checks = [...CODE, "eval"];
    else if (path === "scripts/size.ts") checks = [...CODE, "build"];
    else if (/^(src\/|public\/)/.test(path) || ["next.config.ts", "vercel.json"].includes(path)) checks = [...CODE, "build"];
    else if (path === "oxlint.config.ts" || path.startsWith("tools/oxlint/")) checks = ["lint"];
    else checks = CODE_CHECKS;

    for (const check of checks) selected.add(check);
  }

  return selected;
}

export const attribution = /co-authored-by:.*(?:claude|anthropic|copilot|cursor|codex|openai|chatgpt|gemini|devin|aider)|generated (?:with|by).*(?:claude|copilot|cursor|codex|chatgpt|openai|gemini|\bAI\b)|noreply@anthropic\.com|claude\.com\/claude-code/i;
