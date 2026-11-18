import type { Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { SiteAnalytics } from "./analytics";
import { PALETTE } from "./brand/site";
import { THEME_SCRIPT } from "./brand/theme";
import { ARRIVAL_SCRIPT } from "./i18n/arrival";
import { LanguageArrival } from "./i18n/language-arrival";
import type { Locale } from "./i18n/locales";
import "./globals.css";

// The whole page is set in Geist Mono: Geist Sans would only add a preloaded font nobody reads.
// symbols2 holds the box-drawing dashes of the headings ("── joueurs"): preloaded with latin, or they are drawn
// in a fallback font first and the heading shifts sideways when that file arrives.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "symbols2"] });

export const VIEWPORT: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PALETTE.light.background },
    { media: "(prefers-color-scheme: dark)", color: PALETTE.dark.background },
  ],
};

/**
 * The document every page is drawn in. Each language has its own root layout (`(fr)/layout.tsx`,
 * `en/layout.tsx`) so that `<html lang>` is right in the static HTML; both render this.
 */
export function RootShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    // The theme script sets attributes on <html> before hydration (see brand/theme).
    <html lang={locale} className={`${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Before the first paint: the page must hear `pagereveal` to animate a language change. */}
        <script dangerouslySetInnerHTML={{ __html: ARRIVAL_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* First in the body: the stored theme is applied before anything is painted. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
        <LanguageArrival />
        <SiteAnalytics />
      </body>
    </html>
  );
}
