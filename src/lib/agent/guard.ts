import { constants, type DatabaseSync } from "node:sqlite";
import { SCHEMA_VIEWS } from "../db/schema";

/**
 * Schema guard for pipeline plans (typed or generated). Trusted, parameterized
 * helper queries inside tools do not need this guard:
 *
 * - read-only: SELECT / WITH only, no write or admin keyword, and the database
 *   itself is opened read-only;
 * - a single statement;
 * - only allow-listed tables and views, and only their known columns;
 * - a forced LIMIT (the query is wrapped);
 * - `prepare()` as the final schema validator: it compiles the statement
 *   without running it, so anything the static pass misses still fails here,
 *   and SQLite's authorizer rejects any read of a table outside the allow-list
 *   (comma joins, subqueries, CTEs over base tables).
 */
export type GuardResult = { ok: true; sql: string } | { ok: false; issues: string[] };

/** Name-resolving views: the only objects generated (text-to-SQL) queries may read. */
export const VIEWS = SCHEMA_VIEWS;

/** What typed tools may read: the views plus small lookup tables (champion icons, a game's Riot key...). */
export const ALLOWED_OBJECTS = [...VIEWS, "leagues", "teams", "champions", "players", "game_riot"] as const;

export const MAX_ROWS = 200;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|vacuum|reindex|truncate|analyze|begin|commit|rollback|savepoint)\b/i;

const NOT_ALIAS = /^(on|where|group|order|left|inner|outer|join|limit|cross|using|natural|union|except|intersect|having|window)$/i;

export function allowedSchema(
  schema: Record<string, string[]>,
  objects: readonly string[] = ALLOWED_OBJECTS,
): Record<string, string[]> {
  return Object.fromEntries(objects.flatMap((t) => (schema[t] ? [[t, schema[t]]] : [])));
}

export function guardQuery(
  db: DatabaseSync,
  schema: Record<string, string[]>,
  sql: string,
  { maxRows = MAX_ROWS, objects = ALLOWED_OBJECTS }: { maxRows?: number; objects?: readonly string[] } = {},
): GuardResult {
  const issues: string[] = [];
  const allowed = new Map(Object.entries(allowedSchema(schema, objects)).map(([t, c]) => [t.toLowerCase(), c]));

  // Ignore string literals and comments when scanning identifiers.
  const scanned = scanSql(sql);

  if (!scanned.ok) return { ok: false, issues: [scanned.issue] };
  const code = scanned.code;

  const trimmed = code.trim().replace(/;\s*$/, "");

  if (!/^(select|with)\b/i.test(trimmed)) issues.push("Only SELECT / WITH queries are allowed.");

  if (trimmed.includes(";")) issues.push("Only one statement is allowed.");
  const forbidden = FORBIDDEN.exec(trimmed);

  if (forbidden) issues.push(`Forbidden keyword: ${forbidden[1].toUpperCase()}.`);

  const ctes = new Set(
    [...trimmed.matchAll(/(?:\bwith|,)\s+(\w+)\s*(?:\([^)]*\)\s*)?as\s*\(/gi)].map((m) => m[1].toLowerCase()),
  );

  const aliases = new Map<string, string>(); // alias -> table

  for (const m of trimmed.matchAll(/\b(?:from|join)\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
    const name = m[1].toLowerCase();

    if (!allowed.has(name) && !ctes.has(name)) {
      issues.push(
        schema[m[1]] || schema[m[1].toLowerCase()]
          ? `Table not allowed: ${m[1]} (use the v_* views).`
          : `Unknown table: ${m[1]}.`,
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

  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS)
    issues.push(`Row limit must be between 1 and ${MAX_ROWS}.`);

  if (issues.length) return { ok: false, issues: [...new Set(issues)] };

  const limited = `SELECT * FROM (\n${sql.trim().replace(/;\s*$/, "")}\n) LIMIT ${maxRows}`;
  const denied = new Set<string>();
  const objectSet = new Set(objects.map((o) => o.toLowerCase()));
  // SQLite's authorizer sees every table the compiled statement reads, including
  // the ones the static pass cannot spot (comma joins, nested subqueries).
  db.setAuthorizer((action, table, column, dbName, view) => {
    if (action === constants.SQLITE_FUNCTION) {
      const name = column ?? table ?? "";

      if (/^(load_extension|readfile|writefile|fts3_tokenizer|eval|edit|shell|system)$/i.test(name)) {
        denied.add(`function ${name}`);

        return constants.SQLITE_DENY;
      }

      return constants.SQLITE_OK;
    }

    if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;

    if (action !== constants.SQLITE_READ) {
      denied.add(`action ${action}`);

      return constants.SQLITE_DENY;
    }

    const name = table?.toLowerCase() ?? "";

    // Reads made by an allow-listed view on its base tables are fine.
    if (objectSet.has(name) || (view != null && objectSet.has(view.toLowerCase()))) return constants.SQLITE_OK;

    // Joins inside a view read a base table with no column; SQLite then reports
    // the schema name but not always the view. A direct reference has no schema
    // name, and reading any column still needs an allow-listed view.
    if (column === "" && dbName != null) return constants.SQLITE_OK;
    denied.add(table ?? "?");

    return constants.SQLITE_DENY;
  });

  try {
    db.prepare(limited);
  } catch (err) {
    if (denied.size)
      return { ok: false, issues: [...denied].map((t) => `Table not allowed: ${t} (use the v_* views).`) };

    return { ok: false, issues: [`SQLite rejected the query: ${err instanceof Error ? err.message : String(err)}`] };
  } finally {
    db.setAuthorizer(null);
  }

  return { ok: true, sql: limited };
}

/** Strip literals/comments for the static pass and reject an unfinished token.
 * A trailing /* would otherwise swallow the forced LIMIT added by the wrapper.
 */
function scanSql(sql: string): { ok: true; code: string } | { ok: false; issue: string } {
  let code = "";
  let depth = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let token = char;
      let closed = false;

      for (i++; i < sql.length; i++) {
        token += sql[i];

        if (sql[i] !== close) continue;

        if (sql[i + 1] === close && close !== "]") {
          token += sql[++i];
          continue;
        }

        closed = true;
        break;
      }

      if (!closed) return { ok: false, issue: "Unclosed SQL literal or identifier." };
      code += char === "'" ? "''" : token;
    } else if (char === "-" && sql[i + 1] === "-") {
      for (i += 2; i < sql.length && sql[i] !== "\n"; i++) { /* line comment */ }

      code += "\n";
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);

      if (end < 0) return { ok: false, issue: "Unclosed SQL comment." };
      i = end + 1;
      code += " ";
    } else {
      if (char === "(") depth++;

      if (char === ")" && --depth < 0) return { ok: false, issue: "Unbalanced SQL parentheses." };
      code += char;
    }
  }

  return depth === 0 ? { ok: true, code } : { ok: false, issue: "Unbalanced SQL parentheses." };
}
