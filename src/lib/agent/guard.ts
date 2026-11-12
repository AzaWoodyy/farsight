import type { DatabaseSync } from "node:sqlite";

/**
 * Schema guard, applied to every query (typed or generated) before it runs:
 *
 * - read-only: SELECT / WITH only, no write or admin keyword, and the database
 *   itself is opened read-only;
 * - a single statement;
 * - only allow-listed tables and views, and only their known columns;
 * - a forced LIMIT (the query is wrapped);
 * - `prepare()` as the final schema validator: it compiles the statement
 *   without running it, so anything the static pass misses still fails here.
 */
export type GuardResult = { ok: true; sql: string } | { ok: false; issues: string[] };

/** What queries may read: the name-resolving views plus small lookup tables. */
export const ALLOWED_OBJECTS = [
  "v_tournaments",
  "v_tournament_results",
  "v_games",
  "v_game_players",
  "v_draft",
  "v_player_items",
  "leagues",
  "teams",
  "champions",
  "players",
] as const;

export const MAX_ROWS = 200;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex|truncate|analyze|begin|commit|rollback|savepoint|release)\b/i;
const NOT_ALIAS = /^(on|where|group|order|left|inner|outer|join|limit|cross|using|natural|union|except|intersect|having|window)$/i;

export function allowedSchema(schema: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(ALLOWED_OBJECTS.filter((t) => schema[t]).map((t) => [t, schema[t]]));
}

export function guardQuery(
  db: DatabaseSync,
  schema: Record<string, string[]>,
  sql: string,
  { maxRows = MAX_ROWS }: { maxRows?: number } = {},
): GuardResult {
  const issues: string[] = [];
  const allowed = new Map(Object.entries(allowedSchema(schema)).map(([t, c]) => [t.toLowerCase(), c]));

  // Ignore string literals and comments when scanning identifiers.
  const code = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const trimmed = code.trim().replace(/;\s*$/, "");

  if (!/^(select|with)\b/i.test(trimmed)) issues.push("Only SELECT / WITH queries are allowed.");
  if (trimmed.includes(";")) issues.push("Only one statement is allowed.");
  const forbidden = FORBIDDEN.exec(trimmed);
  if (forbidden) issues.push(`Forbidden keyword: ${forbidden[1].toUpperCase()}.`);

  const ctes = new Set(
    [...trimmed.matchAll(/(?:\bwith|,)\s+(\w+)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()),
  );
  const aliases = new Map<string, string>(); // alias -> table

  for (const m of trimmed.matchAll(/\b(?:from|join)\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
    const name = m[1].toLowerCase();
    if (!allowed.has(name) && !ctes.has(name)) {
      issues.push(
        schema[m[1]] ? `Table not allowed: ${m[1]} (use the v_* views).` : `Unknown table: ${m[1]}.`,
      );
      continue;
    }
    const alias = m[2]?.toLowerCase();
    if (alias && !NOT_ALIAS.test(alias)) aliases.set(alias, name);
    aliases.set(name, name);
  }

  for (const m of trimmed.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\b/g)) {
    const table = aliases.get(m[1].toLowerCase());
    if (!table) {
      issues.push(`Unknown table alias: ${m[1]}.`);
      continue;
    }
    if (ctes.has(table)) continue; // CTE columns are checked by prepare()
    const cols = allowed.get(table) ?? [];
    if (!cols.includes(m[2]))
      issues.push(`Unknown column ${m[1]}.${m[2]} (${table} has: ${cols.join(", ")}).`);
  }

  if (issues.length) return { ok: false, issues: [...new Set(issues)] };

  const limited = `SELECT * FROM (\n${sql.trim().replace(/;\s*$/, "")}\n) LIMIT ${maxRows}`;
  try {
    db.prepare(limited);
  } catch (err) {
    return { ok: false, issues: [`SQLite rejected the query: ${(err as Error).message}`] };
  }
  return { ok: true, sql: limited };
}
