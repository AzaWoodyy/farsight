import { SCHEMA_VIEWS } from "../db/schema";

export type GuardResult = { ok: true; sql: string } | { ok: false; issues: string[] };

export const VIEWS = SCHEMA_VIEWS;

export const ALLOWED_OBJECTS = [...VIEWS, "leagues", "teams", "champions", "players", "game_riot"] as const;

export const MAX_ROWS = 200;

const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|attach|detach|pragma|create|vacuum|reindex|truncate|analyze|begin|commit|rollback|savepoint|grant|revoke|copy|lock|listen|notify|unlisten|set|reset|discard|call|do|execute|prepare|deallocate|refresh|cluster|comment|security|into|import|load|checkpoint)\b/i;

const DENIED_NAMES =
  "pg_\\w+|set_config|current_setting|query_to_xml\\w*|query_to_xmlschema|cursor_to_xml\\w*|table_to_xml\\w*|schema_to_xml\\w*|database_to_xml\\w*|" +
  "dblink\\w*|lo_\\w+|txid_\\w+|has_\\w+_privilege|inet_\\w+|version|" +
  "load_extension|readfile|writefile|fts3_tokenizer|eval|edit|shell|system";

const DENIED_FUNCTION = new RegExp(`(?:"(${DENIED_NAMES})"|\\b(${DENIED_NAMES}))\\s*\\(`, "i");

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

  const aliases = new Map<string, string>();

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

  if (/\bu&["']/i.test(trimmed)) issues.push("Unicode-escaped identifiers and strings (U&) are not allowed.");
  const denied = DENIED_FUNCTION.exec(trimmed);

  if (denied) issues.push(`Function not allowed: ${denied[1] ?? denied[2]}.`);

  for (const m of trimmed.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\b/g)) {
    const table = aliases.get(m[1].toLowerCase());

    if (!table) {
      issues.push(`Unknown table alias: ${m[1]}.`);
      continue;
    }

    if (ctes.has(table)) continue;
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

function referencedTables(code: string): { name: string; alias: string | undefined }[] {
  const masked = code.replace(/\bextract\s*\(\s*\w+\s+from\b/gi, (m) => m.replace(/from$/i, "    ")).replace(/\bdistinct\s+from\b/gi, (m) => m.replace(/from$/i, "    "));
  const found: { name: string; alias: string | undefined; at: number }[] = [];

  for (const m of masked.matchAll(/\bjoin\s+"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?/gi)) found.push({ name: m[1], alias: m[2], at: m.index });

  for (const m of masked.matchAll(/\bfrom\b/gi)) {
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

      if (t && !it.trimStart().startsWith("(")) found.push({ name: t[1], alias: t[2], at: m.index + i });
    }
  }

  return found.toSorted((a, b) => a.at - b.at);
}

function scanSql(sql: string): { ok: true; code: string } | { ok: false; issue: string } {
  let code = "";
  let depth = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "")) return { ok: false, issue: "Escape strings (E'…') are not allowed." };

    if (char === "$") return { ok: false, issue: "Dollar signs (dollar-quoted strings, parameters) are not allowed." };

    if (char === "/" && sql[i + 1] === "*") return { ok: false, issue: "Block comments (/* … */) are not allowed." };

    if (char === "'" || char === '"') {
      const close = char;
      let token = char;
      let closed = false;

      for (i++; i < sql.length; i++) {
        token += sql[i];

        if (sql[i] !== close) continue;

        if (sql[i + 1] === close) {
          token += sql[++i];
          continue;
        }

        closed = true;
        break;
      }

      if (!closed) return { ok: false, issue: "Unclosed SQL literal or identifier." };
      code += char === "'" ? "''" : token;
    } else if (char === "-" && sql[i + 1] === "-") {
      const lineEnd = sql.slice(i + 2).search(/[\r\n]/);
      i = lineEnd < 0 ? sql.length : i + 2 + lineEnd;

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
