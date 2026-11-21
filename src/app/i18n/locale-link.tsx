"use client";

import { type ComponentProps, useSyncExternalStore } from "react";
import { addressQuestion, questionPath, subscribeToAddress } from "../question-link";

export function LocaleLink({ href, carryQuestion, ...props }: ComponentProps<"a"> & { href: string; carryQuestion: boolean }) {
  const question = useSyncExternalStore(subscribeToAddress, addressQuestion, () => null);

  return <a {...props} href={carryQuestion && question != null ? questionPath(href, question) : href} />;
}
