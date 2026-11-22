"use client";

import { SignInButton, SignOutButton, useAuth, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { Locale } from "@/lib/locale";
import { Mark } from "../brand/logo";
import { SITE } from "../brand/site";
import { CHAT_PATHS, PATHS } from "../i18n/locales";
import { SHELL } from "../i18n/shell";

const TEXT = {
  fr: {
    heading: "La conversation est réservée aux comptes invités.",
    intro: "Ce prototype consomme plus de crédit que les questions du site : il faut se connecter, puis qu’Enzo ouvre l’accès au compte.",
    signIn: "Se connecter",
    pendingHeading: "Ton compte n’a pas encore accès.",
    pending: (email: string) => `Tu es connecté${email ? ` avec ${email}` : ""}. Demande à Enzo d’ouvrir l’accès à ce compte, puis recharge la page.`,
    signOut: "Se déconnecter",
    home: "Revenir aux questions",
  },
  en: {
    heading: "The conversation is for invited accounts only.",
    intro: "This prototype costs more credit than the site’s questions: sign in, then Enzo opens access for the account.",
    signIn: "Sign in",
    pendingHeading: "Your account does not have access yet.",
    pending: (email: string) => `You are signed in${email ? ` as ${email}` : ""}. Ask Enzo to open access for this account, then reload the page.`,
    signOut: "Sign out",
    home: "Back to the questions",
  },
} as const;

const BUTTON = "press inline-flex min-h-11 items-center border border-line px-4 text-xs tracking-wider uppercase hover:border-accent hover:text-accent sm:pointer-fine:min-h-9";

export function ChatDoor({ locale, pending }: { locale: Locale; pending: boolean }) {
  const t = TEXT[locale];
  const { user } = useUser();
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const refreshed = useRef(false);
  const here = CHAT_PATHS[locale];

  useEffect(() => {
    if (!isLoaded || !isSignedIn || pending || refreshed.current) return;

    refreshed.current = true;
    router.refresh();
  }, [isLoaded, isSignedIn, pending, router]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-6">
      <header className="pt-5 sm:pt-8">
        <Link href={PATHS.home[locale]} aria-label={SHELL[locale].homeLabel} className="press inline-flex min-h-11 items-center gap-2.5 hover:text-accent">
          <Mark size={32} />
          <span translate="no" className="text-base font-semibold lowercase">
            {SITE.name}
          </span>
        </Link>
      </header>
      <main className="my-auto py-10">
        <h1 className="max-w-3xl text-xl leading-tight font-semibold tracking-tight text-balance sm:text-2xl">
          <span aria-hidden className="text-accent">
            &gt;{" "}
          </span>
          {pending ? t.pendingHeading : t.heading}
        </h1>
        <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-pretty text-muted">{pending ? t.pending(user?.primaryEmailAddress?.emailAddress ?? "") : t.intro}</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {pending ? (
            <SignOutButton redirectUrl={here}>
              <button type="button" className={BUTTON}>
                {t.signOut}
              </button>
            </SignOutButton>
          ) : (
            <SignInButton mode="modal" forceRedirectUrl={here} signUpForceRedirectUrl={here}>
              <button type="button" className={`${BUTTON} border-accent text-accent`}>
                {t.signIn}
              </button>
            </SignInButton>
          )}
          <Link href={PATHS.home[locale]} className="press inline-flex min-h-11 items-center text-xs text-muted underline decoration-line underline-offset-2 hover:text-accent sm:pointer-fine:min-h-9">
            {t.home}
          </Link>
        </div>
      </main>
    </div>
  );
}
