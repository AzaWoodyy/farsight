"use client";

import { setTheme, THEME_KEY, type Theme } from "./brand/theme";

/** The theme on screen: the visitor's choice when there is one, the system setting otherwise. */
function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");

  if (set === "light" || set === "dark") return set;

  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Switches between light and dark and remembers the choice: an icon only, named for screen readers. Both icons
 * are rendered and globals.css shows the one matching the theme on screen, so the server HTML is right from the
 * first frame, before hydration.
 */
export function ThemeToggle() {
  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";

    setTheme(next);

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked (private mode): the choice holds for this page only.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="theme-toggle press inline-flex size-11 shrink-0 items-center justify-center border border-line text-sm text-muted hover:border-accent hover:text-accent sm:pointer-fine:size-8"
    >
      <span data-when="dark">
        <span aria-hidden>☀</span>
        <span className="sr-only">Passer au thème clair</span>
      </span>
      <span data-when="light">
        <span aria-hidden>☾</span>
        <span className="sr-only">Passer au thème sombre</span>
      </span>
    </button>
  );
}
