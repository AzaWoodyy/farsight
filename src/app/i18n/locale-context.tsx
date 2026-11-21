"use client";

import { createContext, type ReactNode, useContext } from "react";
import { DEFAULT_LOCALE, type Locale } from "@/lib/locale";
import { UI, type Ui } from "./ui";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

export const useUi = (): Ui => UI[useLocale()];
