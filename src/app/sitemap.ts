import type { MetadataRoute } from "next";
import { readFacts } from "./how/facts";
import { sitemapEntries } from "./i18n/metadata";
import { LEGAL_UPDATED } from "./legal/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const released = (process.env.HOW_FACTS ? readFacts().releaseDay : null) ?? undefined;

  return sitemapEntries({ home: released, how: released, legal: LEGAL_UPDATED });
}
