// Separate OS process: SQLite's synchronous VM can be killed even while busy.
// This file is shipped verbatim by outputFileTracingIncludes.
import { constants, DatabaseSync } from "node:sqlite";

let input = "";

for await (const chunk of process.stdin) input += chunk;

const { databasePath, schemaVersion, sql, params, objects, maxRows, maxBytes } = JSON.parse(input);
let db;

try {
  db = new DatabaseSync(databasePath, { readOnly: true, limits: { length: 1_000_000 } });

  if (!db.limits || db.limits.length > 1_000_000) throw new Error("SQLite length limit unavailable; Node >=24.15 is required.");

  if (db.prepare("PRAGMA user_version").get().user_version !== schemaVersion) throw new Error("Database schema version mismatch.");
  const allowed = new Set(objects);
  db.setAuthorizer((action, table, column, dbName, view) => {
    if (action === constants.SQLITE_SELECT || action === constants.SQLITE_FUNCTION) return constants.SQLITE_OK;

    if (action !== constants.SQLITE_READ) return constants.SQLITE_DENY;

    if (allowed.has(table) || (view != null && allowed.has(view))) return constants.SQLITE_OK;

    if (column === "" && dbName != null) return constants.SQLITE_OK;

    return constants.SQLITE_DENY;
  });
  const stmt = db.prepare(sql);
  const iterator = Array.isArray(params) ? stmt.iterate(...params) : stmt.iterate(params);
  const rows = [];
  let bytes = 0;

  for (const row of iterator) {
    bytes += Buffer.byteLength(JSON.stringify(row));

    if (bytes > maxBytes) throw new Error("SQL result exceeds the response size limit.");
    rows.push(row);

    if (rows.length >= maxRows) break;
  }

  process.stdout.write(JSON.stringify({ rows }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : "SQLite execution failed." }));
  process.exitCode = 1;
} finally {
  db?.close();
}
