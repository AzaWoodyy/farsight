import Link from "next/link";
import { LanguageArrival } from "./i18n/language-arrival";
import { type Locale, PATHS } from "./i18n/locales";
import { SHELL } from "./i18n/shell";

export const TEXT_LINK = "underline decoration-line underline-offset-2 hover:text-accent";

export const CC_BY_SA_URL = "https://creativecommons.org/licenses/by-sa/3.0/";

export const RIOT_BOILERPLATE =
  "Farsight isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.";

export function SiteFooter({ locale }: { locale: Locale }) {
  const { footer } = SHELL[locale];

  return (
    <footer className="border-t border-dashed border-line py-6 text-xs leading-relaxed text-muted">
      <p className="max-w-[80ch]">
        {footer.data}{" "}
        <a className={TEXT_LINK} href="https://lol.fandom.com" target="_blank" rel="noreferrer">
          Leaguepedia
        </a>{" "}
        (
        <a className={TEXT_LINK} href={CC_BY_SA_URL} target="_blank" rel="noreferrer license">
          CC BY-SA 3.0
        </a>
        ) · {footer.icons}{" "}
        <a
          className={TEXT_LINK}
          href="https://developer.riotgames.com/docs/lol#data-dragon"
          target="_blank"
          rel="noreferrer"
        >
          Riot Data Dragon
        </a>{" "}
        · {footer.photos}. {footer.madeBy}{" "}
        <a
          className="font-medium text-accent underline decoration-accent underline-offset-2 hover:decoration-2"
          href="https://www.enzoneault.dev"
          target="_blank"
          rel="noreferrer"
        >
          Enzo Neault
        </a>
        .
      </p>
      <p className="mt-2 max-w-[80ch]">
        {footer.privacy} {footer.riot}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        <Link className={`tap ${TEXT_LINK}`} href={PATHS.how[locale]}>
          {footer.how}
        </Link>
        <Link className={`tap ${TEXT_LINK}`} href={PATHS.legal[locale]}>
          {footer.legal}
        </Link>
      </p>
      <LanguageArrival />
    </footer>
  );
}
