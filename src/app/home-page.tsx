import { chatConfigured } from "@/lib/auth/chat-config";
import { AgentConsole } from "./agent-console";
import { jsonLdScript } from "./brand/json-ld";
import { HomeCoverage } from "./home-coverage";
import { HomeProofsView } from "./home-proofs";
import { readProofs } from "./home-proofs-data";
import { HomeExamples } from "./home-examples";
import { readFacts } from "./how/facts";
import type { Locale } from "./i18n/locales";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export function HomePage({ locale }: { locale: Locale }) {
  const proofs = readProofs();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(locale) }} />
      <SiteHeader locale={locale} page="home" trail="" chat={chatConfigured()} />
      <main id="main" tabIndex={-1} className="pb-8 outline-none">
        <AgentConsole
          locale={locale}
          proof={proofs && <HomeProofsView locale={locale} proofs={proofs} />}
          coverage={process.env.HOW_FACTS && <HomeCoverage locale={locale} facts={readFacts()} />}
          below={<HomeExamples />}
        />
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}
