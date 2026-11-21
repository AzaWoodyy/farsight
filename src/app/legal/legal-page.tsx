import { ContentPage } from "../content-page";
import type { Locale } from "../i18n/locales";
import { LEGAL } from "./content";

export function LegalPage({ locale }: { locale: Locale }) {
  const { title, trail, updated, toc, sections } = LEGAL[locale];

  return <ContentPage locale={locale} page="legal" trail={trail} title={title} dated={updated} toc={toc} sections={sections} />;
}
