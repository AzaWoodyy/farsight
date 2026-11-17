import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, createQuerySchema, createSchema } from "../../src/lib/db/schema";
import { MIN_GAMES_RATIO, type Manifest, corruption, headerProblems, readFacts, regressionProblems, usabilityProblems } from "./artifact";

const dir = mkdtempSync(join(tmpdir(), "farsight-artifact-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;

/** An empty database with the app's schema, as `data:build` leaves it, in a temp directory. */
function buildDb(path: string, opts: { schema?: number; journal?: "DELETE" | "WAL"; buildDetails?: string } = {}): string {
  const db = new DatabaseSync(path);

  try {
    createSchema(db);
    createQuerySchema(db);

    if (opts.buildDetails != null)
      db.prepare("INSERT INTO ingest_runs (kind, started_at, finished_at, schema_version, row_counts, details) VALUES ('build', 'x', 'x', ?, '{}', ?)")
        .run(opts.schema ?? SCHEMA_VERSION, opts.buildDetails);
    db.exec(`PRAGMA user_version=${opts.schema ?? SCHEMA_VERSION}; PRAGMA journal_mode=${opts.journal ?? "DELETE"};`);
  } finally {
    db.close();
  }

  return path;
}

const fresh = (opts?: Parameters<typeof buildDb>[1]) => buildDb(join(dir, `db-${++files}.sqlite`), opts);

const COUNTS: Manifest["counts"] = { games: 1000, leagues: 19, tournaments: 50, players: 400, teams: 80, ingame_games: 800 };

function manifest(counts: Partial<Manifest["counts"]> = {}): Manifest {
  const sha256 = "0".repeat(64);

  return {
    format: 1,
    tag: "data-20261108",
    schema_version: SCHEMA_VERSION,
    created_at: "2026-11-08T00:00:00Z",
    commit: "abc",
    database: { file: "lol.sqlite", size: 1, sha256 },
    asset: { file: "lol.sqlite.zst", compression: "zstd", size: 1, sha256 },
    counts: { ...COUNTS, ...counts },
    ddragon_version: null,
  };
}

describe("regressionProblems (data:package --previous)", () => {
  const ok = { allowIngameDrop: false };
  const min = Math.floor(COUNTS.games * MIN_GAMES_RATIO);

  test("equal counts, or games at exactly the minimum ratio, pass", () => {
    expect(regressionProblems(COUNTS, manifest(), ok)).toEqual([]);
    expect(regressionProblems({ ...COUNTS, games: min }, manifest(), ok)).toEqual([]);
  });

  test("one game below the minimum is refused, naming the previous release", () => {
    const problems = regressionProblems({ ...COUNTS, games: min - 1 }, manifest(), ok);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("data-20261108");
    expect(problems[0]).toContain(`minimum ${min}`);
  });

  test("one league fewer is refused", () => {
    const problems = regressionProblems({ ...COUNTS, leagues: COUNTS.leagues - 1 }, manifest(), ok);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("leagues");
  });

  test("an in-game drop is refused unless explicitly allowed", () => {
    const counts = { ...COUNTS, ingame_games: Math.floor(800 * MIN_GAMES_RATIO) - 1 };
    const problems = regressionProblems(counts, manifest(), ok);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("in-game");
    expect(regressionProblems(counts, manifest(), { allowIngameDrop: true })).toEqual([]);
  });

  test("a previous manifest without in-game counts sets no in-game floor", () => {
    expect(regressionProblems({ ...COUNTS, ingame_games: 0 }, manifest({ ingame_games: undefined }), ok)).toEqual([]);
  });
});

describe("headerProblems", () => {
  test("a text file, or a file shorter than the 100-byte header, is not a database", () => {
    const text = join(dir, "text.sqlite");
    writeFileSync(text, "x".repeat(200));
    expect(headerProblems(text)).toEqual(["not a SQLite database"]);

    const short = join(dir, "short.sqlite");
    writeFileSync(short, "SQLite format 3\0");
    expect(headerProblems(short)).toEqual(["not a SQLite database"]);
  });

  test("a WAL database is refused, a rollback-journal one passes", () => {
    const [problem, ...rest] = headerProblems(fresh({ journal: "WAL" }));
    expect(rest).toEqual([]);
    expect(problem).toStartWith("WAL mode");
    expect(headerProblems(fresh())).toEqual([]);
  });
});

describe("usabilityProblems", () => {
  test("a missing file is refused", () => {
    const missing = join(dir, "missing.sqlite");
    expect(usabilityProblems(missing, SCHEMA_VERSION)).toEqual([`${missing} does not exist`]);
  });

  test("another schema version is refused", () => {
    expect(usabilityProblems(fresh({ schema: SCHEMA_VERSION + 1 }), SCHEMA_VERSION)).toEqual([
      `schema v${SCHEMA_VERSION + 1}, the code expects v${SCHEMA_VERSION}`,
    ]);
  });

  test("a WAL file is refused before SQLite opens it", () => {
    expect(usabilityProblems(fresh({ journal: "WAL" }), SCHEMA_VERSION)[0]).toStartWith("WAL mode");
  });

  test("a valid file passes", () => {
    expect(usabilityProblems(fresh(), SCHEMA_VERSION)).toEqual([]);
  });
});

describe("readFacts", () => {
  test("reads the versions of the latest build run and the headline counts", () => {
    const path = fresh({ buildDetails: JSON.stringify({ derive_version: 2, ddragon_version: "16.1.1", ingame: { stale_derive: 3, older_derive: 4 } }) });

    expect(readFacts(path)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      journalMode: "delete",
      counts: { games: 0, leagues: 0, tournaments: 0, players: 0, teams: 0, ingame_games: 0 },
      ddragonVersion: "16.1.1",
      deriveVersion: 2,
      staleDerive: 3,
      olderDerive: 4,
    });
  });

  test("without a build run, no derivation version", () => {
    const facts = readFacts(fresh());
    expect(facts.deriveVersion).toBeNull();
    expect(facts.ddragonVersion).toBeNull();
    expect(facts.staleDerive).toBe(0);
    expect(facts.olderDerive).toBe(0);
  });
});

describe("corruption", () => {
  test("a sound file has none", () => {
    const path = fresh();
    expect(corruption(path, false)).toBeNull();
    expect(corruption(path, true)).toBeNull();
  });

  test("a damaged file is reported by both the quick and the full check", () => {
    const path = join(dir, "damaged.sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t (a); PRAGMA journal_mode=DELETE;");
    db.close();
    // Header bytes 36-39: number of freelist pages. Claiming 5 on a file without any breaks the freelist.
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.from([0, 0, 0, 5]), 0, 4, 36);
    closeSync(fd);

    expect(corruption(path, false)).toContain("Freelist");
    expect(corruption(path, true)).toContain("Freelist");
  });
});
