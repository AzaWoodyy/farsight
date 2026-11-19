import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { sitemapEntries } from "../src/app/i18n/metadata";
import { dataReleaseDay } from "../src/lib/db/release";

const RUNS = "CREATE TABLE ingest_runs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL)";

function withRuns(rows: [kind: string, finishedAt: string][]): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  db.exec(RUNS);

  for (const [kind, finishedAt] of rows) db.prepare("INSERT INTO ingest_runs (kind, started_at, finished_at) VALUES (?, 'x', ?)").run(kind, finishedAt);

  return db;
}

test("the data release day is the last build recorded in the database", () => {
  const db = withRuns([["build", "2026-11-10T02:17:37.590Z"], ["fetch_full", "2026-11-17T01:00:00.000Z"], ["build", "2026-11-17T02:17:37.590Z"], ["fetch_full", "2026-11-18T01:00:00.000Z"]]);

  expect(dataReleaseDay(db)).toBe("2026-11-17");
});

test("no build, or an unreadable date, gives no day rather than an invented one", () => {
  expect(dataReleaseDay(withRuns([]))).toBeNull();
  expect(dataReleaseDay(withRuns([["build", "x"]]))).toBeNull();
});

test("the sitemap dates each page with its own day and keeps its alternates", () => {
  const entries = sitemapEntries({ home: "2026-11-17", how: "2026-11-17", legal: "2026-11-15" });
  const byUrl = Object.fromEntries(entries.map((e) => [e.url, e]));

  expect(Object.keys(byUrl)).toEqual(["https://askfarsight.com", "https://askfarsight.com/en", "https://askfarsight.com/comment-ca-marche", "https://askfarsight.com/en/how-it-works", "https://askfarsight.com/mentions-legales", "https://askfarsight.com/en/legal-notice"]);
  expect(entries.map((e) => e.lastModified)).toEqual(["2026-11-17", "2026-11-17", "2026-11-17", "2026-11-17", "2026-11-15", "2026-11-15"]);
  expect(byUrl["https://askfarsight.com/en"]?.alternates?.languages).toEqual({ fr: "https://askfarsight.com", en: "https://askfarsight.com/en", "x-default": "https://askfarsight.com" });

  for (const entry of entries) expect(entry).not.toHaveProperty("changeFrequency");
});

test("a page without a known day gets no lastModified", () => {
  expect(sitemapEntries({ legal: "2026-11-15" })[0]?.lastModified).toBeUndefined();
});
