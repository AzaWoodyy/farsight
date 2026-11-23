import type { Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { SiteAnalytics } from "./analytics";
import { PALETTE } from "./brand/site";
import { THEME_SCRIPT } from "./brand/theme";
import { ARRIVAL_SCRIPT } from "./i18n/arrival";
import type { Locale } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { QUESTION_LINK_SCRIPT } from "./question-link";
import "./globals.css";

const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "symbols2"] });

export const VIEWPORT: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PALETTE.light.background },
    { media: "(prefers-color-scheme: dark)", color: PALETTE.dark.background },
  ],
};

export function RootShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale} className={`${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ARRIVAL_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: QUESTION_LINK_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <a href="#main" className="skip-link">
          {SHELL[locale].skip}
        </a>
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}
