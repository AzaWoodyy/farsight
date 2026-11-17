import type { MetadataRoute } from "next";
import { sitemapEntries } from "./i18n/metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
