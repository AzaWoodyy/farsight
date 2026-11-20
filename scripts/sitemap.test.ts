import { expect, test } from "bun:test";
import { sitemapEntries } from "../src/app/i18n/metadata";
import robots from "../src/app/robots";

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

test("robots.txt lets a link preview fetch its image, and nothing else under /api/", () => {
  expect(robots().rules).toEqual({ userAgent: "*", allow: ["/", "/api/card"], disallow: "/api/" });
});
