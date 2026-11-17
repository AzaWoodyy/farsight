import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Lab } from "../../lab/lab";
import { SiteFooter } from "../../site-footer";
import { SiteHeader } from "../../site-header";

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
    // No extra room for the floating menu: the page ends where production ends (H hides the menu).
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale="fr" page="home" trail="lab des affichages" />
      <main className="flex-1 pb-8">
        <Lab />
      </main>
      <SiteFooter locale="fr" />
    </div>
  );
}
