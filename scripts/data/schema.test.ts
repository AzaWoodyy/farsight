import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSchema, createQuerySchema, QUERY_DDL, SCHEMA_OBJECTS, SCHEMA_VERSION, TABLE_DDL } from "../../src/lib/db/schema";

describe("database schema contract", () => {
  test("DDL changes require reviewing the schema version and its fingerprint together", () => {
    const fingerprint = createHash("sha256").update(TABLE_DDL + QUERY_DDL.replace(/^CREATE INDEX .+;\n/gm, "")).digest("hex");
    expect({ version: SCHEMA_VERSION, fingerprint }).toEqual({
      version: 12,
      fingerprint: "b938a7c4e9636480bfd6d0fb42907d3f0d8927494b4df3bdb4eee2abd85bff65",
    });
  });

  test("all public views prepare, and a draft slot stays unique", () => {
    const db = new DatabaseSync(":memory:");

    try {
      createSchema(db);
      createQuerySchema(db);

      for (const name of SCHEMA_OBJECTS) expect(() => db.prepare(`SELECT * FROM ${name} LIMIT 0`)).not.toThrow();

      db.exec("INSERT INTO game_draft VALUES (1,1,0,1,100)");
      expect(() => db.exec("INSERT INTO game_draft VALUES (1,1,0,1,200)")).toThrow();
    } finally {
      db.close();
    }
  });
});
