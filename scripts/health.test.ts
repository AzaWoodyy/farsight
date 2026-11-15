import { describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { databaseHealth } from "../src/lib/db/health";
import { createQuerySchema, createSchema } from "../src/lib/db/schema";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  createQuerySchema(db);
  db.exec("PRAGMA user_version=6");
  db.exec("INSERT INTO games (id, tournament_id) VALUES (1, 1), (2, 1)");

  return db;
}

describe("database health", () => {
  test("reports the schema version, the game count and the end of the latest build", () => {
    const db = database();

    try {
      const run = "INSERT INTO ingest_runs (kind, started_at, finished_at, schema_version, row_counts) VALUES (?, ?, ?, 6, '{}')";
      db.prepare(run).run("build", "2026-11-01T00:00:00Z", "2026-11-01T00:10:00Z");
      db.prepare(run).run("build", "2026-11-15T03:00:00Z", "2026-11-15T03:40:00Z");
      db.prepare(run).run("fetch", "2026-11-16T00:00:00Z", "2026-11-16T00:05:00Z");

      expect(databaseHealth(db)).toEqual({ schemaVersion: 6, games: 2, builtAt: "2026-11-15T03:40:00Z" });
    } finally {
      db.close();
    }
  });

  test("builtAt is null when no build was recorded", () => {
    const db = database();

    try {
      expect(databaseHealth(db)).toEqual({ schemaVersion: 6, games: 2, builtAt: null });
    } finally {
      db.close();
    }
  });
});
