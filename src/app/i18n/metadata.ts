import type { Metadata, MetadataRoute } from "next";
import { absoluteUrl, SITE } from "../brand/site";
import { DEFAULT_LOCALE, isPublic, type Locale, OG_LOCALE, PAGES, type PageKey, PATHS, PUBLIC_LOCALES } from "./locales";
import { SHELL } from "./shell";

function languages(page: PageKey, locale: Locale, url: (path: string) => string): Record<string, string> | undefined {
  if (PUBLIC_LOCALES.length < 2 || !isPublic(locale)) return undefined;

  return Object.fromEntries([...PUBLIC_LOCALES.map((l) => [l, url(PATHS[page][l])]), ["x-default", url(PATHS[page][DEFAULT_LOCALE])]]);
}

export function rootMetadata(locale: Locale): Metadata {
  const { tagline, description } = SHELL[locale];
  const title = `${SITE.name} · ${tagline}`;

  return {
    metadataBase: new URL(SITE.url),
    title: { default: title, template: `%s · ${SITE.name}` },
    description,
    applicationName: SITE.name,
    openGraph: { type: "website", locale: OG_LOCALE[locale], siteName: SITE.name, title, description, url: PATHS.home[locale] },
    twitter: { card: "summary_large_image", title, description },
    robots: isPublic(locale) ? undefined : { index: false, follow: false },
  };
}

export function pageMetadata(locale: Locale, page: PageKey, text?: { title: string; description: string }): Metadata {
  const path = PATHS[page][locale];
  const alternates = { canonical: path, languages: languages(page, locale, (p) => p) };

  if (!text) return { alternates };

  return {
    ...text,
    alternates,
    openGraph: { type: "website", locale: OG_LOCALE[locale], siteName: SITE.name, ...text, url: path },
    twitter: { card: "summary_large_image", ...text },
  };
}

export function sitemapEntries(lastModified: Partial<Record<PageKey, string>> = {}): MetadataRoute.Sitemap {
  return PAGES.flatMap((page) =>
    PUBLIC_LOCALES.map((locale) => {
      const alternates = languages(page, locale, absoluteUrl);

      return { url: absoluteUrl(PATHS[page][locale]), lastModified: lastModified[page], alternates: alternates && { languages: alternates } };
    }),
  );
}
