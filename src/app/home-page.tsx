import { chatConfigured } from "@/lib/auth/chat-config";
import { AgentConsole } from "./agent-console";
import { jsonLdScript } from "./brand/json-ld";
import type { Locale } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export function HomePage({ locale }: { locale: Locale }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(locale) }} />
      <SiteHeader locale={locale} page="home" trail={SHELL[locale].tagline.toLowerCase()} chat={chatConfigured()} />
      <main className="pb-8">
        <AgentConsole locale={locale} />
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}
