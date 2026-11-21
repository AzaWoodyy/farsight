import { type Locale, PATHS } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { absoluteUrl, SITE } from "./site";

const author = { "@type": "Person", "@id": "https://enzoneault.dev/#person", name: "Enzo Neault", url: "https://www.enzoneault.dev" };

const jsonLd = (locale: Locale) => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#website`,
      url: SITE.url,
      name: SITE.name,
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

export const jsonLdScript = (locale: Locale) => JSON.stringify(jsonLd(locale)).replace(/</g, "\\u003c");
