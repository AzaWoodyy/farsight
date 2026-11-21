export const LOCALES = ["fr", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "fr";

const INTL_TAG: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

export const NO_DATA: Record<Locale, string> = { fr: "n/d", en: "n/a" };

const numberFormats = new Map<string, Intl.NumberFormat>();

export function numberFormat(locale: Locale, digits: number, minDigits = 0): Intl.NumberFormat {
  const key = `${locale}:${digits}:${minDigits}`;
  const cached = numberFormats.get(key);

  if (cached) return cached;
  const format = new Intl.NumberFormat(INTL_TAG[locale], { minimumFractionDigits: minDigits, maximumFractionDigits: digits });
  numberFormats.set(key, format);

  return format;
}

export const thousands = (locale: Locale, n: number): string => `${numberFormat(locale, 1, 1).format(n / 1000)}k`;

export const dateFormat = (locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(INTL_TAG[locale], { ...options, timeZone: "UTC" });

export const percent = (locale: Locale, text: string | number): string => (locale === "fr" ? `${text} %` : `${text}%`);

export const compareText = (locale: Locale, a: string, b: string): number => a.localeCompare(b, locale, { numeric: true });

export const sameLabel = (text: string): Record<Locale, string> => ({ fr: text, en: text });
