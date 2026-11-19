"use client";

import { type ComponentProps, useSyncExternalStore } from "react";
import { addressQuestion, questionPath, subscribeToAddress } from "../question-link";

/**
 * A link of the language switch. The static HTML holds the plain address of the page in the other language,
 * which is what a crawler reads; in the browser, a home page showing an answer links to the same question
 * there (`carryQuestion`), kept in the `href` itself so a new tab or a copied link carry it too.
 */
export function LocaleLink({ href, carryQuestion, ...props }: ComponentProps<"a"> & { href: string; carryQuestion: boolean }) {
  const question = useSyncExternalStore(subscribeToAddress, addressQuestion, () => null);

  return <a {...props} href={carryQuestion && question != null ? questionPath(href, question) : href} />;
}
