import type { MetadataRoute } from "next";
import { readFacts } from "./how/facts";
import { sitemapEntries } from "./i18n/metadata";
import { LEGAL_UPDATED } from "./legal/content";

/**
 * Prerendered at build: the home pages and the "how it works" pages change with the data, so their `lastmod` is the day
 * the database was built (inlined at build with the page's figures, HOW_FACTS); the legal pages keep the day written in
 * their text. Never the build's clock.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const released = (process.env.HOW_FACTS ? readFacts().releaseDay : null) ?? undefined;

  return sitemapEntries({ home: released, how: released, legal: LEGAL_UPDATED });
}
