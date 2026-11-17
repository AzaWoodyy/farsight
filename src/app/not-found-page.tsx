import Link from "next/link";
import { type Locale, PATHS } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { TEXT_LINK } from "./site-footer";
import { SiteHeader } from "./site-header";

/** The 404 of a language, in the page frame. */
export function NotFoundPage({ locale }: { locale: Locale }) {
  const { notFound } = SHELL[locale];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale={locale} page="home" trail="404" />
      <main className="flex-1 pt-10 pb-16 text-sm leading-relaxed sm:pt-16">
        <h1 className="text-xl leading-snug font-semibold text-balance sm:text-3xl">{notFound.title}</h1>
        <p className="mt-3 text-muted">{notFound.body}</p>
        <p className="mt-6">
          <Link className={`tap ${TEXT_LINK}`} href={PATHS.home[locale]}>
            {notFound.home}
          </Link>
        </p>
      </main>
    </div>
  );
}
