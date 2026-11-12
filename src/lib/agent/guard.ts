import type { DatabaseSync } from "node:sqlite";

/**
 * Schema guard: validates a query against the live SQLite schema *before*
 * it runs. Read-only, single statement, known tables, known columns.
 * The final check is `prepare()`, which compiles the statement without
 * executing it, so anything the static pass misses still fails early.
 */
export type GuardResult = { ok: true } | { ok: false; issues: string[] };

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex|truncate)\b/i;

export function guardQuery(
  db: DatabaseSync,
  schema: Record<string, string[]>,
  sql: string,
): GuardResult {
  const issues: string[] = [];
  // Ignore string literals and comments when scanning identifiers.
  const code = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const trimmed = code.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed))
    issues.push("Only SELECT / WITH queries are allowed.");
  if (trimmed.includes(";")) issues.push("Only one statement is allowed.");
  const forbidden = FORBIDDEN.exec(trimmed);
  if (forbidden) issues.push(`Forbidden keyword: ${forbidden[1].toUpperCase()}.`);

  const ctes = new Set(
    [...trimmed.matchAll(/(?:\bwith|,)\s+(\w+)\s+as\s*\(/gi)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
  const tables = new Map(
    Object.entries(schema).map(([t, cols]) => [t.toLowerCase(), cols]),
  );
  const aliases = new Map<string, string>(); // alias -> table

  for (const m of trimmed.matchAll(
    /\b(?:from|join)\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/gi,
  )) {
    const name = m[1].toLowerCase();
    if (name === "select" || name === "(") continue;
    if (!tables.has(name) && !ctes.has(name)) {
      issues.push(`Unknown table: ${m[1]}.`);
      continue;
    }
    const alias = m[2]?.toLowerCase();
    const keyword = /^(on|where|group|order|left|inner|join|limit|cross|using)$/;
    if (alias && !keyword.test(alias)) aliases.set(alias, name);
    aliases.set(name, name);
  }

  for (const m of trimmed.matchAll(/\b(\w+)\.(\w+)\b/g)) {
    const qualifier = m[1].toLowerCase();
    const column = m[2];
    const table = aliases.get(qualifier);
    if (!table) {
      if (!/^\d+$/.test(qualifier)) issues.push(`Unknown table alias: ${m[1]}.`);
      continue;
    }
    if (ctes.has(table)) continue; // CTE columns are checked by prepare()
    const cols = tables.get(table) ?? [];
    if (!cols.includes(column))
      issues.push(
        `Unknown column ${m[1]}.${column} (table ${table} has: ${cols.join(", ")}).`,
      );
  }

  if (issues.length === 0) {
    try {
      db.prepare(sql);
    } catch (err) {
      issues.push(`SQLite rejected the query: ${(err as Error).message}`);
    }
  }
  return issues.length ? { ok: false, issues: [...new Set(issues)] } : { ok: true };
}
