"use client";

import { createContext, type ReactNode, useContext } from "react";
import { useLocale } from "./i18n/locale-context";
import { PATHS } from "./i18n/locales";
import { questionPath } from "./question-link";

export const AskContext = createContext<((question: string) => void) | null>(null);

export function AskLink({ question, className, children }: { question: string; className?: string; children: ReactNode }) {
  const ask = useContext(AskContext);
  const locale = useLocale();

  return (
    <a
      href={questionPath(PATHS.home[locale], question)}
      rel="nofollow"
      onClick={(e) => {
        if (!ask || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        ask(question);
      }}
      className={className}
    >
      {children}
    </a>
  );
}
