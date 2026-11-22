"use client";

import { SignInButton, SignOutButton, useAuth, useUser } from "@clerk/nextjs";
import "./chat.css";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { Locale } from "@/lib/locale";
import { CHAT_PATHS } from "../i18n/locales";

const TEXT = {
  fr: {
    heading: "La conversation est réservée aux comptes invités.",
    intro: "Connecte-toi, puis Enzo ouvre l’accès à ton compte.",
    signIn: "Se connecter",
    preparing: "Préparation de la connexion…",
    pendingHeading: "Ton compte n’a pas encore accès.",
    pending: (email: string) => `${email ? `Compte : ${email}. ` : ""}Demande à Enzo d’ouvrir l’accès, puis recharge la page.`,
    signOut: "Se déconnecter",
  },
  en: {
    heading: "The conversation is for invited accounts only.",
    intro: "Sign in, then Enzo opens access for your account.",
    signIn: "Sign in",
    preparing: "Preparing sign-in…",
    pendingHeading: "Your account does not have access yet.",
    pending: (email: string) => `${email ? `Account: ${email}. ` : ""}Ask Enzo to open access, then reload the page.`,
    signOut: "Sign out",
  },
} as const;

const BUTTON = "press inline-flex min-h-11 items-center border border-line px-4 text-[13px] tracking-wider uppercase hover:border-accent hover:text-accent sm:pointer-fine:min-h-9";

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
    <div className="mt-10 sm:mt-16">
      <h1 className="max-w-3xl text-xl leading-snug font-semibold text-balance sm:text-3xl">
        <span aria-hidden className="text-accent">
          &gt;{" "}
        </span>
        {pending ? t.pendingHeading : t.heading}
      </h1>
      <p className="mt-4 max-w-[68ch] border-l border-dashed border-line pl-3 text-sm leading-relaxed text-pretty text-muted">
        {pending ? t.pending(user?.primaryEmailAddress?.emailAddress ?? "") : t.intro}
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
          {pending ? (
            <SignOutButton redirectUrl={here}>
              <button type="button" className={BUTTON}>
                {t.signOut}
              </button>
            </SignOutButton>
          ) : (
            <SignInButton mode="modal" forceRedirectUrl={here} signUpForceRedirectUrl={here}>
              <button type="button" disabled={!isLoaded} aria-busy={!isLoaded} className={`${BUTTON} border-accent text-accent disabled:border-line disabled:text-muted`}>
                {isLoaded ? (
                  t.signIn
                ) : (
                  <span className="t-shimmer" data-text={t.preparing}>
                    {t.preparing}
                  </span>
                )}
              </button>
            </SignInButton>
          )}
      </div>
    </div>
  );
}
