import type { Locale } from "@/lib/locale";

/**
 * The languages of the site. French keeps the URLs it always had (`/`, `/mentions-legales`); English lives
 * under `/en`. The language of a page is its URL: nothing is read from a cookie or from Accept-Language, so
 * every page stays static and a search engine always gets the same language at the same address.
 */
export { DEFAULT_LOCALE, type Locale, LOCALES } from "@/lib/locale";

/**
 * The languages visitors and search engines are sent to: the language switch, hreflang and the sitemap list
 * only these, and a page in another language is served with `noindex`. English joins the list once the
 * console and the agent's answers are in English too; until then `/en` is reachable by its address only.
 */
export const PUBLIC_LOCALES: readonly Locale[] = ["fr"];

export const isPublic = (locale: Locale): boolean => PUBLIC_LOCALES.includes(locale);

/** The pages that exist in every language, and the path of each one. */
export const PATHS = {
  home: { fr: "/", en: "/en" },
  legal: { fr: "/mentions-legales", en: "/en/legal-notice" },
} as const satisfies Record<string, Record<Locale, string>>;

export type PageKey = keyof typeof PATHS;

export const PAGES: PageKey[] = ["home", "legal"];

/** Each language named in itself, for the switch. */
export const LOCALE_NAME: Record<Locale, string> = { fr: "Français", en: "English" };

/** Open Graph wants a territory with the language. */
export const OG_LOCALE: Record<Locale, string> = { fr: "fr_FR", en: "en_US" };
