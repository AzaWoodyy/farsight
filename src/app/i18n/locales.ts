import type { Locale } from "@/lib/locale";

export { DEFAULT_LOCALE, type Locale, LOCALES } from "@/lib/locale";

export const PUBLIC_LOCALES: readonly Locale[] = ["fr", "en"];

export const isPublic = (locale: Locale): boolean => PUBLIC_LOCALES.includes(locale);

export const PATHS = {
  home: { fr: "/", en: "/en" },
  how: { fr: "/comment-ca-marche", en: "/en/how-it-works" },
  legal: { fr: "/mentions-legales", en: "/en/legal-notice" },
} as const satisfies Record<string, Record<Locale, string>>;

export type PageKey = keyof typeof PATHS;

export const PAGES: PageKey[] = ["home", "how", "legal"];

export const LOCALE_NAME: Record<Locale, string> = { fr: "Français", en: "English" };

export const OG_LOCALE: Record<Locale, string> = { fr: "fr_FR", en: "en_US" };
