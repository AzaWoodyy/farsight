"use client";

import Link from "next/link";
import { Mark } from "./brand/logo";
import { SITE } from "./brand/site";

export const HOME_EVENT = "farsight:home";

export function HomeLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      onClick={(e) => {
        if (window.location.pathname !== href || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new Event(HOME_EVENT));
      }}
      className="press inline-flex min-h-11 items-center gap-2.5 hover:text-accent"
      aria-label={label}
    >
      <Mark size={32} />
      <span className="text-base font-semibold lowercase">{SITE.name}</span>
    </Link>
  );
}
