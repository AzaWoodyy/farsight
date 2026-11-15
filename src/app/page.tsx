import type { Metadata } from "next";
import { AgentConsole } from "./agent-console";
import { jsonLdScript } from "./brand/json-ld";
import { Mark } from "./brand/logo";
import { SITE } from "./brand/site";
import { PICK_CSS, PICK_SCRIPT } from "./home-examples-data";
import { SiteFooter } from "./site-footer";

// Canonical of the home page only (resolved against metadataBase): a page added later must not inherit "/".
export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
      {/* Structured data for search engines (schema.org WebSite + WebApplication). */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript() }} />
      {/* Random draw of the home examples, made before they are painted (see home-examples-data). */}
      <style dangerouslySetInnerHTML={{ __html: PICK_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: PICK_SCRIPT }} />
      <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
        <p className="inline-flex min-h-11 items-center gap-2.5">
          <Mark size={32} />
          <span className="text-base font-semibold lowercase">{SITE.name}</span>
        </p>
        <span className="hidden text-xs text-muted sm:block">~/ {SITE.tagline.toLowerCase()}</span>
      </header>
      <main className="flex-1 pb-16">
        <AgentConsole />
      </main>
      <SiteFooter />
    </div>
  );
}
