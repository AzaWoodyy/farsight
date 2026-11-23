import type { ReactNode } from "react";
import type { Locale, PageKey } from "./i18n/locales";
import { SiteFooter, TEXT_LINK } from "./site-footer";
import { SiteHeader } from "./site-header";

export type ContentSection = { id: string; label: string; body: ReactNode };

type Props = {
  locale: Locale;
  page: PageKey;
  trail: string;
  title: string;
  dated: string;
  toc: string;
  sections: ContentSection[];
};

export function ContentPage({ locale, page, trail, title, dated, toc, sections }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale={locale} page={page} trail={trail} />
      <main id="main" tabIndex={-1} className="outline-none flex-1 pt-10 pb-16 text-sm leading-relaxed sm:pt-16">
        <div className="max-w-[75ch]">
          <h1 className="text-xl leading-snug font-semibold text-balance sm:text-3xl">{title}</h1>
          <p className="mt-3 text-xs text-muted">{dated}</p>
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

export function Ext({ href, children, rel = "noreferrer" }: { href: string; children: ReactNode; rel?: string }) {
  return (
    <a className={TEXT_LINK} href={href} target="_blank" rel={rel}>
      {children}
    </a>
  );
}
