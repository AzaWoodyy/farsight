import type { Locale } from "../i18n/locales";
import { SiteFooter, TEXT_LINK } from "../site-footer";
import { SiteHeader } from "../site-header";
import { LEGAL } from "./content";

/** The legal page of a language: its sections under a table of contents. The texts are in `content`. */
export function LegalPage({ locale }: { locale: Locale }) {
  const { title, trail, updated, toc, sections } = LEGAL[locale];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale={locale} page="legal" trail={trail} />
      <main className="flex-1 pt-10 pb-16 text-sm leading-relaxed sm:pt-16">
        <div className="max-w-[75ch]">
          <h1 className="text-xl leading-snug font-semibold text-balance sm:text-3xl">{title}</h1>
          <p className="mt-3 text-xs text-muted">{updated}</p>
          <nav aria-label={toc} className="mt-6">
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {sections.map((s) => (
                <li key={s.id}>
                  <a className={`tap ${TEXT_LINK}`} href={`#${s.id}`}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={s.id} className="mt-12 space-y-3">
              <h2 id={s.id} className="scroll-mt-6 text-xs tracking-widest text-muted uppercase">
                ── {s.label}
              </h2>
              {s.body}
            </section>
          ))}
        </div>
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}
