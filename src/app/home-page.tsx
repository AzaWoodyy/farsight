import { AgentConsole } from "./agent-console";
import { jsonLdScript } from "./brand/json-ld";
import { PICK_CSS, PICK_SCRIPT } from "./home-examples-data";
import type { Locale } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/** The home page of a language: the console between the header and the footer. */
export function HomePage({ locale }: { locale: Locale }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      {/* Structured data for search engines (schema.org WebSite + WebApplication). */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(locale) }} />
      {/* Random draw of the home examples, made before they are painted (see home-examples-data). With href and
          precedence React moves the rules to <head>: a <style> is not valid HTML in the body. */}
      <style href="home-picks" precedence="default">
        {PICK_CSS}
      </style>
      <script dangerouslySetInnerHTML={{ __html: PICK_SCRIPT }} />
      <SiteHeader locale={locale} page="home" trail={SHELL[locale].tagline.toLowerCase()} />
      {/* Not stretched to the screen: under a short answer the footer follows it, instead of an empty screen between the two. */}
      <main className="pb-8">
        <AgentConsole locale={locale} />
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}
