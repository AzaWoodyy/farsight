import { ContentPage } from "../content-page";
import type { Locale } from "../i18n/locales";
import { HOW, howContent } from "./content";
import { readFacts } from "./facts";

/** The "how it works" page of a language. The texts are in `content`, their figures in `facts`. */
export function HowPage({ locale }: { locale: Locale }) {
  const { title, trail, toc } = HOW[locale];
  const { dated, sections } = howContent(locale, readFacts());

  return <ContentPage locale={locale} page="how" trail={trail} title={title} dated={dated} toc={toc} sections={sections} />;
}
