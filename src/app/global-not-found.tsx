import type { Metadata } from "next";
import { LOCALES, PATHS } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { RootShell, VIEWPORT } from "./root-shell";
import { TEXT_LINK } from "./site-footer";
import { SiteHeader } from "./site-header";

export const metadata: Metadata = { title: "404 · Farsight" };

export const viewport = VIEWPORT;

/**
 * The 404 of any address no page answers. Each language has its own root layout, so an unmatched URL has no
 * layout to be drawn in: Next serves this one document for all of them, without knowing the address. It is
 * therefore written in both languages, the default one first.
 */
export default function GlobalNotFound() {
  return (
    <RootShell locale="fr">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
        <SiteHeader locale="fr" page="home" trail="404" />
        <main className="flex-1 space-y-10 pt-10 pb-16 text-sm leading-relaxed sm:pt-16">
          {LOCALES.map((locale) => (
            <section key={locale} lang={locale}>
              <h1 className="text-xl leading-snug font-semibold text-balance sm:text-3xl">{SHELL[locale].notFound.title}</h1>
              <p className="mt-3 text-muted">{SHELL[locale].notFound.body}</p>
              <p className="mt-4">
                <a className={`tap ${TEXT_LINK}`} href={PATHS.home[locale]}>
                  {SHELL[locale].notFound.home}
                </a>
              </p>
            </section>
          ))}
        </main>
      </div>
    </RootShell>
  );
}
