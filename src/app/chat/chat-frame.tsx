import type { ReactNode } from "react";
import type { Locale } from "@/lib/locale";
import { CHAT_PATHS } from "../i18n/locales";
import { SHELL } from "../i18n/shell";
import { SiteFooter } from "../site-footer";
import { SiteHeader } from "../site-header";

export function ChatFrame({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale={locale} page="home" trail={SHELL[locale].chat.trail} switchTo={CHAT_PATHS} />
      <main className="chat-shell pb-8">{children}</main>
      <SiteFooter locale={locale} />
    </div>
  );
}
