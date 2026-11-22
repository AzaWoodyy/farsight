import Link from "next/link";
import { HomeLink } from "./home-link";
import { LANG_SWITCH_ATTR } from "./i18n/arrival";
import { LocaleLink } from "./i18n/locale-link";
import { CHAT_PATHS, isPublic, LOCALE_NAME, LOCALES, type Locale, type PageKey, PATHS } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader({ locale, page, trail, chat = false }: { locale: Locale; page: PageKey; trail: string; chat?: boolean }) {
  const shell = SHELL[locale];

  return (
    <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
      <HomeLink href={PATHS.home[locale]} label={shell.homeLabel} />
      <div className="flex items-center gap-2">
        <span className="mr-2 hidden text-xs text-muted sm:block">~/ {trail}</span>
        {chat && (
          <Link
            href={CHAT_PATHS[locale]}
            prefetch={false}
            className="press inline-flex min-h-11 shrink-0 items-center gap-2 border border-line px-3 text-xs hover:border-accent hover:text-accent sm:pointer-fine:min-h-8"
          >
            <span aria-hidden className="max-[359px]:hidden sm:hidden">
              {shell.chat.short}
            </span>
            <span className="sr-only sm:not-sr-only">{shell.chat.label}</span>
            <span className="text-accent">{shell.chat.stage}</span>
          </Link>
        )}
        <LocaleSwitch locale={locale} page={page} />
        <ThemeToggle toLight={shell.theme.toLight} toDark={shell.theme.toDark} />
      </div>
    </header>
  );
}

function LocaleSwitch({ locale, page }: { locale: Locale; page: PageKey }) {
  return LOCALES.filter((other) => other !== locale && isPublic(other)).map((other) => (
    <LocaleLink
      key={other}
      href={PATHS[page][other]}
      carryQuestion={page === "home"}
      hrefLang={other}
      lang={other}
      aria-label={LOCALE_NAME[other]}
      title={LOCALE_NAME[other]}
      {...{ [LANG_SWITCH_ATTR]: "" }}
      className="press inline-flex size-11 shrink-0 items-center justify-center border border-line text-xs text-muted uppercase hover:border-accent hover:text-accent sm:pointer-fine:size-8"
    >
      {other}
    </LocaleLink>
  ));
}
