import { SITE } from "./site";

const author = { "@type": "Person", "@id": "https://enzoneault.dev/#person", name: "Enzo Neault", url: "https://enzoneault.dev" };

/**
 * Structured data of the home page (schema.org): the site, and the application it is. Static: no answer
 * has its own URL, so there is nothing per question to describe.
 */
export const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#website`,
      url: SITE.url,
      name: SITE.name,
      description: SITE.description,
      inLanguage: "fr",
      author,
    },
    {
      "@type": "WebApplication",
      "@id": `${SITE.url}/#app`,
      name: SITE.name,
      url: SITE.url,
      description: SITE.description,
      inLanguage: "fr",
      applicationCategory: "ReferenceApplication",
      operatingSystem: "Web",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      about: { "@type": "VideoGame", name: "League of Legends" },
      author,
      isBasedOn: {
        "@type": "Dataset",
        name: "Leaguepedia",
        url: "https://lol.fandom.com",
        license: "https://creativecommons.org/licenses/by-sa/3.0/",
      },
    },
  ],
};

/** The JSON-LD as an inline script body, `<` escaped so no string can close the script tag. */
export const jsonLdScript = () => JSON.stringify(JSON_LD).replace(/</g, "\\u003c");
