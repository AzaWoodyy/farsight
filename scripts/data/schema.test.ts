import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSchema, createQuerySchema, QUERY_DDL, SCHEMA_OBJECTS, SCHEMA_VERSION, TABLE_DDL } from "../../src/lib/db/schema";
import { derivationProblems } from "./artifact";

describe("database schema contract", () => {
  test("DDL changes require reviewing the schema version and its fingerprint together", () => {
    const fingerprint = createHash("sha256").update(TABLE_DDL + QUERY_DDL.replace(/^CREATE INDEX .+;\n/gm, "")).digest("hex");
    expect({ version: SCHEMA_VERSION, fingerprint }).toEqual({
      version: 11,
      fingerprint: "e5f852a10c5e928c9140e86b7f17dc7d6adb75a823066130d512f994c03eba6d",
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
      expect(db.prepare("PRAGMA index_info(gp_team)").all().map((column) => column.name)).toEqual(["team_id"]);
      db.exec("INSERT INTO game_draft VALUES (1,1,0,1,100)");
      expect(() => db.exec("INSERT INTO game_draft VALUES (1,1,0,1,200)")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("release derivation consistency", () => {
  test("refuses stale summaries and a build made by an older definition", () => {
    expect(derivationProblems({ deriveVersion: 2, staleDerive: 0, olderDerive: 0 }, 2)).toEqual([]);
    expect(derivationProblems({ deriveVersion: 2, staleDerive: 3, olderDerive: 0 }, 2)).toHaveLength(1);
    expect(derivationProblems({ deriveVersion: 1, staleDerive: 0, olderDerive: 0 }, 2)).toHaveLength(1);
    expect(derivationProblems({ deriveVersion: null, staleDerive: 0, olderDerive: 0 }, 2)).toHaveLength(1);
  });

  test("summaries of an older compatible definition pass the offline check only", () => {
    const facts = { deriveVersion: 3, staleDerive: 0, olderDerive: 12 };

    expect(derivationProblems(facts, 3)).toHaveLength(1);
    expect(derivationProblems(facts, 3, { allowOlder: true })).toEqual([]);
    expect(derivationProblems({ ...facts, staleDerive: 1 }, 3, { allowOlder: true })).toHaveLength(1);
  });
});
