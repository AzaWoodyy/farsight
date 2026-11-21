/** Unknown paths run every check; the checks that read data load Postgres from the pinned snapshot. */
export const CHECKS = ["lint", "typecheck", "test", "eval", "build"] as const;

export type Check = (typeof CHECKS)[number];

const CODE: Check[] = ["lint", "typecheck"];

export function affected(paths: string[]): Set<Check> {
  const selected = new Set<Check>();

  for (const path of paths) {
    let checks: readonly Check[];

    if (/^(docs\/.*|[^/]+\.md|LICENSE)$/.test(path)) checks = [];
    else if (["package.json", "bun.lock", "ci/data.json", "ci/raw.tar.zst"].includes(path) || path.startsWith("data/")) checks = CHECKS;
    else if (path === "tsconfig.json" || /^(\.github\/|scripts\/ci\/|ci\/|\.githooks\/)/.test(path)) checks = CHECKS;
    else if (path.endsWith(".test.ts")) checks = [...CODE, "test"];
    else if (/^scripts\/data\/(fetch|sync)\.ts$/.test(path)) checks = [...CODE, "test"];
    else if (/^(scripts\/data\/|src\/lib\/sources\/|src\/lib\/domain\/)/.test(path) || path === "src/lib/aliases.ts" || path === "src/lib/db/schema.ts") checks = CHECKS;
    else if (path.startsWith("src/lib/")) checks = CHECKS;
    else if (path.startsWith("eval/") || path === "scripts/eval.ts") checks = [...CODE, "eval"];
    else if (path === "scripts/size.ts") checks = [...CODE, "build"];
    else if (/^(src\/|public\/)/.test(path) || ["next.config.ts", "vercel.json"].includes(path)) checks = [...CODE, "build"];
    else if (path === "oxlint.config.ts" || path.startsWith("tools/oxlint/")) checks = ["lint"];
    else checks = CHECKS;

    for (const check of checks) selected.add(check);
  }

  return selected;
}

/**
 * The newest commit already validated on main that is an ancestor of the pushed commit, or null: then every check runs.
 * A run only proves its own range when it selected checks with this rule, so older runs are never a base.
 */
export function pushBase(greenShas: string[], after: string, isAncestor: (sha: string) => boolean, usesThisRule: (sha: string) => boolean): string | null {
  return greenShas.find(sha => /^[a-f0-9]{40}$/.test(sha) && sha !== after && isAncestor(sha) && usesThisRule(sha)) ?? null;
}

export const attribution = /co-authored-by:.*(?:claude|anthropic|copilot|cursor|codex|openai|chatgpt|gemini|devin|aider)|generated (?:with|by).*(?:claude|copilot|cursor|codex|chatgpt|openai|gemini|\bAI\b)|noreply@anthropic\.com|claude\.com\/claude-code/i;
