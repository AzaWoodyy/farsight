import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSchema, createQuerySchema, QUERY_DDL, SCHEMA_OBJECTS, SCHEMA_VERSION, TABLE_DDL } from "../../src/lib/db/schema";
import { derivationProblems } from "./artifact";

describe("database schema contract", () => {
  test("DDL changes require reviewing the schema version and its fingerprint together", () => {
    const fingerprint = createHash("sha256").update(TABLE_DDL + QUERY_DDL.replace(/^CREATE INDEX .+;\n/gm, "")).digest("hex");
    expect({ version: SCHEMA_VERSION, fingerprint }).toEqual({
      version: 5,
      fingerprint: "4ff3116a5be1a88bf3166ac678ca861fa3152add891c32c8769f741a3ac0301a",
    });
  });

  test("all public views prepare, and the champion index preserves draft slot uniqueness", () => {
    const db = new DatabaseSync(":memory:");

    try {
      createSchema(db);
      createQuerySchema(db);

      for (const name of SCHEMA_OBJECTS) expect(() => db.prepare(`SELECT * FROM ${name} LIMIT 0`)).not.toThrow();

      const index = db.prepare("PRAGMA index_info(draft_champion_kind_game)").all();
      expect(index.map((column) => column.name)).toEqual(["champion_id", "kind", "game_id"]);
      db.exec("INSERT INTO game_draft VALUES (1,1,0,1,100)");
      expect(() => db.exec("INSERT INTO game_draft VALUES (1,1,0,1,200)")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("release derivation consistency", () => {
  test("refuses stale summaries and a build made by an older definition", () => {
    expect(derivationProblems({ deriveVersion: 2, staleDerive: 0 }, 2)).toEqual([]);
    expect(derivationProblems({ deriveVersion: 2, staleDerive: 3 }, 2)).toHaveLength(1);
    expect(derivationProblems({ deriveVersion: 1, staleDerive: 0 }, 2)).toHaveLength(1);
    expect(derivationProblems({ deriveVersion: null, staleDerive: 0 }, 2)).toHaveLength(1);
  });
});
