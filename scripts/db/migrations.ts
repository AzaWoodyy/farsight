import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../db/migrations");

export type Migration = { version: number; name: string; sql: string; checksum: string };

export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .map((file) => {
      const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);

      if (!m) throw new Error(`Migration file name ${file} is not NNNN_name.sql`);
      const sql = readFileSync(resolve(dir, file), "utf8");

      return { version: Number(m[1]), name: m[2], sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 0001, 0002… without gaps: ${m.version} at position ${i + 1}`);
  });

  return migrations;
}

export async function migrate(client: pg.ClientBase, migrations = readMigrations()): Promise<number[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  for (const [version, checksum] of applied) {
    const file = migrations.find((m) => m.version === version);

    if (!file) throw new Error(`Migration ${version} is applied but its file is missing`);

    if (file.checksum !== checksum) throw new Error(`Migration ${version} (${file.name}) changed after it was applied: add a new migration instead`);
  }

  const done: number[] = [];

  for (const m of migrations.filter((x) => !applied.has(x.version))) {
    await client.query("BEGIN");

    try {
      await client.query(m.sql);
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, m.checksum]);
      await client.query("COMMIT");
      done.push(m.version);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return done;
}

export async function grantReaders(client: pg.ClientBase, schema: string, views: readonly string[]) {
  const { rows } = await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('farsight_app', 'farsight_sql')");
  const roles = new Set(rows.map((r) => r.rolname));
  const id = quoteIdent(schema);

  if (roles.has("farsight_app")) {
    await client.query(`GRANT USAGE ON SCHEMA ${id} TO farsight_app`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${id} TO farsight_app`);
  }

  if (roles.has("farsight_sql")) {
    await client.query(`GRANT USAGE ON SCHEMA ${id} TO farsight_sql`);
    await client.query(`GRANT SELECT ON ${views.map((v) => `${id}.${quoteIdent(v)}`).join(", ")} TO farsight_sql`);
  }
}

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
