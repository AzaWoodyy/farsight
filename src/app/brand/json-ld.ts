import { type Locale, PATHS } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { absoluteUrl, SITE } from "./site";

const author = { "@type": "Person", "@id": "https://enzoneault.dev/#person", name: "Enzo Neault", url: "https://enzoneault.dev" };

/**
 * Structured data of the home page (schema.org): the site, and the application it is. Static: no answer
 * has its own URL, so there is nothing per question to describe. One site, described on each home page in
 * the language of that page.
 */
const jsonLd = (locale: Locale) => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#website`,
      url: SITE.url,
      name: SITE.name,
      // The name Google may show instead of the bare domain, and its accepted alternatives: the brand as it is
      // searched ("farsight lol") and the domain.
      alternateName: [`${SITE.name} LoL`, new URL(SITE.url).host],
      description: SHELL[locale].description,
      inLanguage: locale,
      author,
    },
    {
      "@type": "WebApplication",
      "@id": `${SITE.url}/#app`,
      name: SITE.name,
      alternateName: `${SITE.name} LoL`,
      url: absoluteUrl(PATHS.home[locale]),
      description: SHELL[locale].description,
      inLanguage: locale,
      applicationCategory: "ReferenceApplication",
      operatingSystem: "Web",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      about: { "@type": "VideoGame", name: "League of Legends", alternateName: "LoL" },
      author,
      isBasedOn: {
        "@type": "Dataset",
        name: "Leaguepedia",
        description: SHELL[locale].dataset,
        url: "https://lol.fandom.com",
        creator: { "@type": "Organization", name: "Leaguepedia", url: "https://lol.fandom.com" },
        license: "https://creativecommons.org/licenses/by-sa/3.0/",
      },
    },
  ],
});

/** The JSON-LD as an inline script body, `<` escaped so no string can close the script tag. */
export const jsonLdScript = (locale: Locale) => JSON.stringify(jsonLd(locale)).replace(/</g, "\\u003c");
