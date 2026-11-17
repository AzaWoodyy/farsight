import type { Metadata, MetadataRoute } from "next";
import { absoluteUrl, SITE } from "../brand/site";
import { DEFAULT_LOCALE, isPublic, type Locale, OG_LOCALE, PAGES, type PageKey, PATHS, PUBLIC_LOCALES } from "./locales";
import { SHELL } from "./shell";

/**
 * hreflang of a page: its address in every public language, and the default one for any other visitor.
 * Nothing while only one language is public, and nothing on a page of a language that is not: an alternate
 * must be indexable and point back.
 */
function languages(page: PageKey, locale: Locale, url: (path: string) => string): Record<string, string> | undefined {
  if (PUBLIC_LOCALES.length < 2 || !isPublic(locale)) return undefined;

  return Object.fromEntries([...PUBLIC_LOCALES.map((l) => [l, url(PATHS[page][l])]), ["x-default", url(PATHS[page][DEFAULT_LOCALE])]]);
}

/** Metadata of a root layout: what every page of the language shares. */
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

/**
 * Metadata of one page: its canonical (resolved against metadataBase) and its other languages, set page by
 * page so a page added later does not inherit another one's address. `text` is the page's own title and
 * description; the home page keeps the layout's.
 */
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

const SITEMAP: Record<PageKey, Pick<MetadataRoute.Sitemap[number], "changeFrequency" | "priority">> = {
  home: { changeFrequency: "weekly", priority: 1 },
  legal: { changeFrequency: "yearly", priority: 0.2 },
};

/** Every page in every public language, each with its alternates. */
export function sitemapEntries(): MetadataRoute.Sitemap {
  return PAGES.flatMap((page) =>
    PUBLIC_LOCALES.map((locale) => {
      const alternates = languages(page, locale, absoluteUrl);

      return { url: absoluteUrl(PATHS[page][locale]), ...SITEMAP[page], alternates: alternates && { languages: alternates } };
    }),
  );
}
