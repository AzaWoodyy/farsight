import Link from "next/link";
import { dateFormat, numberFormat } from "@/lib/locale";
import type { Facts } from "./how/facts";
import { type Locale, PATHS } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { TEXT_LINK } from "./site-footer";

export function HomeCoverage({ locale, facts }: { locale: Locale; facts: Facts }) {
  const text = SHELL[locale].home.coverage;
  const competitions = facts.leagues.filter((l) => l.games > 0).length;
  const updated = facts.releaseDay && dateFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(facts.releaseDay));

  return (
    <p className="mt-5 max-w-[60ch] text-xs leading-relaxed text-pretty text-muted">
      {text.text(numberFormat(locale, 0).format(facts.games), competitions)}
      {updated && text.updated(updated)}.{" "}
      <Link className={TEXT_LINK} href={PATHS.how[locale]}>
        {text.link}
      </Link>
    </p>
  );
}
