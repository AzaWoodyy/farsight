import { SCHEMA_VIEWS } from "../db/schema";

/**
 * Schema guard for pipeline plans (typed or generated), a static pass that needs no database round trip. Trusted,
 * parameterized helper queries inside tools do not need this guard:
 *
 * - read-only: SELECT / WITH only, no write or admin keyword, and the database
 *   itself is opened read-only;
 * - a single statement;
 * - only allow-listed tables and views (every table of a comma list too), and only their known columns;
 * - no function that reads files or loads code;
 * - a forced LIMIT (the query is wrapped).
 *
 * The database that runs a generated query is the last check: it refuses any read outside the views
 * (src/lib/db/generated-query.ts), including what the static pass cannot see.
 */
export type GuardResult = { ok: true; sql: string } | { ok: false; issues: string[] };

/** Name-resolving views: the only objects generated (text-to-SQL) queries may read. */
export const VIEWS = SCHEMA_VIEWS;

/** What typed tools may read: the views plus small lookup tables (champion icons, a game's Riot key...). */
export const ALLOWED_OBJECTS = [...VIEWS, "leagues", "teams", "champions", "players", "game_riot"] as const;

export const MAX_ROWS = 200;

/** Statements and clauses a read-only query never needs (a SELECT … INTO creates a table, FOR UPDATE locks rows). */
const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|attach|detach|pragma|create|vacuum|reindex|truncate|analyze|begin|commit|rollback|savepoint|grant|revoke|copy|lock|listen|notify|unlisten|set|reset|discard|call|do|execute|prepare|deallocate|refresh|cluster|comment|security|into|import|load|checkpoint)\b/i;

/**
 * Functions that read files, run SQL of their own, sleep, signal the server or read its settings: never in a generated
 * query, whatever the role allows (the role of generated queries holds none of the privileges they need anyway).
 * SQLite's file functions are refused too: a model may still write that dialect.
 */
const DENIED_NAMES =
  "pg_\\w+|set_config|current_setting|query_to_xml\\w*|query_to_xmlschema|cursor_to_xml\\w*|table_to_xml\\w*|schema_to_xml\\w*|database_to_xml\\w*|" +
  "dblink\\w*|lo_\\w+|txid_\\w+|has_\\w+_privilege|inet_\\w+|version|" +
  "load_extension|readfile|writefile|fts3_tokenizer|eval|edit|shell|system";

const DENIED_FUNCTION = new RegExp(`(?:"(${DENIED_NAMES})"|\\b(${DENIED_NAMES}))\\s*\\(`, "i");

/** Words that end the table list of a FROM clause. */
const CLAUSE_END = /^(?:where|group|order|limit|having|window|union|except|intersect|on|using|join|left|right|inner|outer|full|cross|natural|offset|fetch|for)$/i;

const NOT_ALIAS = /^(on|where|group|order|left|inner|outer|join|limit|cross|using|natural|union|except|intersect|having|window)$/i;

export function allowedSchema(
  schema: Record<string, string[]>,
  objects: readonly string[] = ALLOWED_OBJECTS,
): Record<string, string[]> {
  return Object.fromEntries(objects.flatMap((t) => (schema[t] ? [[t, schema[t]]] : [])));
}

export function guardQuery(
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

  for (const { name: table, alias: rawAlias } of referencedTables(trimmed)) {
    const name = table.toLowerCase();

    if (!allowed.has(name) && !ctes.has(name)) {
      issues.push(
        schema[table] || schema[name]
          ? `Table not allowed: ${table} (use the v_* views).`
          : `Unknown table: ${table}.`,
      );
      continue;
    }

    const alias = rawAlias?.toLowerCase();

    if (alias && !NOT_ALIAS.test(alias)) aliases.set(alias, name);
    aliases.set(name, name);
  }

  // U&"set_confi\0067": an escaped name the static checks cannot read. No question needs one.
  if (/\bu&["']/i.test(trimmed)) issues.push("Unicode-escaped identifiers and strings (U&) are not allowed.");
  const denied = DENIED_FUNCTION.exec(trimmed);

  if (denied) issues.push(`Function not allowed: ${denied[1] ?? denied[2]}.`);

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

  const limited = `SELECT * FROM (\n${sql.trim().replace(/;\s*$/, "")}\n) AS guarded LIMIT ${maxRows}`;

  return { ok: true, sql: limited };
}

/**
 * Every table a query names after FROM (each one of a comma list) or JOIN, with its alias. Subqueries are read by their own
 * FROM; `EXTRACT(… FROM x)` and `IS DISTINCT FROM x` read a value, not a table.
 */
function referencedTables(code: string): { name: string; alias: string | undefined }[] {
  const masked = code.replace(/\bextract\s*\(\s*\w+\s+from\b/gi, (m) => m.replace(/from$/i, "    ")).replace(/\bdistinct\s+from\b/gi, (m) => m.replace(/from$/i, "    "));
  // In the order of the text: a later alias wins, as the static pass always read them.
  const found: { name: string; alias: string | undefined; at: number }[] = [];

  for (const m of masked.matchAll(/\bjoin\s+"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?/gi)) found.push({ name: m[1], alias: m[2], at: m.index });

  for (const m of masked.matchAll(/\bfrom\b/gi)) {
    // The FROM list runs to the first clause word or closing parenthesis of its own level.
    let depth = 0;
    let item = "";
    const items: string[] = [];

    for (const token of masked.slice(m.index + 4).match(/\(|\)|,|[^\s(),]+|\s+/g) ?? []) {
      if (token === "(") depth++;
      else if (token === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && token === ",") {
        items.push(item);
        item = "";
        continue;
      } else if (depth === 0 && CLAUSE_END.test(token)) break;
      item += token;
    }

    items.push(item);

    for (const [i, it] of items.entries()) {
      const t = /^\s*"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?/i.exec(it);

      // A subquery or a parenthesized join: its own FROM and JOIN are read on their own.
      if (t && !it.trimStart().startsWith("(")) found.push({ name: t[1], alias: t[2], at: m.index + i });
    }
  }

  return found.toSorted((a, b) => a.at - b.at);
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
