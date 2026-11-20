import type { MetadataRoute } from "next";
import { dataReleaseDay } from "@/lib/db/release";
import { sitemapEntries } from "./i18n/metadata";
import { LEGAL_UPDATED } from "./legal/content";

/**
 * Prerendered at build: the home pages and the "how it works" pages change with the data, so their `lastmod` is the day
 * of the data release the build ships; the legal pages keep the day written in their text. Never the build's clock.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const released = (await dataReleaseDay()) ?? undefined;

  return sitemapEntries({ home: released, how: released, legal: LEGAL_UPDATED });
}
