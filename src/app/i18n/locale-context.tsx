"use client";

import { createContext, type ReactNode, useContext } from "react";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locale";
import { UI, type Ui } from "./ui";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Gives the language of the page to the console and to every answer view under it. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

/** The texts of the views in the language of the page. */
export const useUi = (): Ui => UI[useLocale()];
