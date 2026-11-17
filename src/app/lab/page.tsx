import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HomeLink } from "../home-link";
import { SiteFooter } from "../site-footer";
import { ThemeToggle } from "../theme-toggle";
import { Lab } from "./lab";

export const metadata: Metadata = { title: "Lab", robots: { index: false, follow: false } };

/**
 * Display lab: every layout an answer can take, behind a floating menu, drawn by the production views from
 * real answers computed at build time (`bun run lab:build`). A preview and local tool: production has neither
 * the page nor its fixtures.
 */
export default function LabPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    // Same frame as the home page, so every layout is judged at the width and beside the neighbours it ships with.
    // Room under the footer for the floating menu, so it never covers the last lines.
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-20 sm:px-6">
      <header className="flex items-center justify-between gap-4 pt-5 sm:pt-8">
        <HomeLink />
        <div className="flex items-center gap-4">
          <span className="hidden text-xs text-muted sm:block">~/ lab des affichages</span>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 pb-16">
        <Lab />
      </main>
      <SiteFooter />
    </div>
  );
}
