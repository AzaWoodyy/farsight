import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import { SiteAnalytics } from "./analytics";
import { PALETTE, SITE } from "./brand/site";
import "./globals.css";

// The whole page is set in Geist Mono: Geist Sans would only add a preloaded font nobody reads.
// symbols2 holds the box-drawing dashes of the headings ("── joueurs"): preloaded with latin, or they are drawn
// in a fallback font first and the heading shifts sideways when that file arrives.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "symbols2"] });

const title = `${SITE.name} · ${SITE.tagline}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: title, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  openGraph: { type: "website", locale: "fr_FR", siteName: SITE.name, title, description: SITE.description, url: "/" },
  twitter: { card: "summary_large_image", title, description: SITE.description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PALETTE.light.background },
    { media: "(prefers-color-scheme: dark)", color: PALETTE.dark.background },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The page's draw script sets the home examples' attributes on <html> before hydration (see home-examples-data).
    <html lang="fr" className={`${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}
