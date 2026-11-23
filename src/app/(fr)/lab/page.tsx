import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Lab } from "../../lab/lab";
import { SiteFooter } from "../../site-footer";
import { SiteHeader } from "../../site-header";

export const metadata: Metadata = { title: "Lab", robots: { index: false, follow: false } };

export default function LabPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
      <SiteHeader locale="fr" page="home" trail="lab des affichages" />
      <main id="main" tabIndex={-1} className="outline-none pb-8">
        <Lab />
      </main>
      <SiteFooter locale="fr" />
    </div>
  );
}
