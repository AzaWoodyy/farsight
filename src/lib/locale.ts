/** The languages of the site and of the agent's answers. French is the default: the one of `/`. */
export const LOCALES = ["fr", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "fr";

const INTL_TAG: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

/** A figure the data does not hold. */
export const NO_DATA: Record<Locale, string> = { fr: "n/d", en: "n/a" };

const numberFormats = new Map<string, Intl.NumberFormat>();

/** Numbers as the language writes them ("1 233,5" / "1,233.5"), with at most `digits` decimals. */
export function numberFormat(locale: Locale, digits: number): Intl.NumberFormat {
  const key = `${locale}:${digits}`;
  const cached = numberFormats.get(key);

  if (cached) return cached;
  const format = new Intl.NumberFormat(INTL_TAG[locale], { maximumFractionDigits: digits });
  numberFormats.set(key, format);

  return format;
}

/** Dates as the language writes them, always in UTC: a game has one date, whoever reads it. */
export const dateFormat = (locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(INTL_TAG[locale], { ...options, timeZone: "UTC" });

/** A percentage around an already formatted number: "43,9 %" in French, "43.9%" in English. */
export const percent = (locale: Locale, text: string | number): string => (locale === "fr" ? `${text} %` : `${text}%`);

/** Text order of the language, for sorting names. */
export const compareText = (locale: Locale, a: string, b: string): number => a.localeCompare(b, locale, { numeric: true });

/** A label both languages write the same ("KDA", "picks"). */
export const sameLabel = (text: string): Record<Locale, string> => ({ fr: text, en: text });
