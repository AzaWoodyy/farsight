"use client";

import { setTheme, THEME_KEY, type Theme } from "./brand/theme";

/** The theme on screen: the visitor's choice when there is one, the system setting otherwise. */
function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");

  if (set === "light" || set === "dark") return set;

  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The wipe in progress, so a second click during it only cleans up its own. */
let wipe: ViewTransition | null = null;

/** The theme a wipe is about to apply: the browser runs the change a frame after the click. */
let pending: Theme | null = null;

/**
 * Applies the theme behind a line that sweeps the page from top to bottom: above the line the new theme, below
 * it the old one (view transition, styled in globals.css). The line is a real element so the browser moves its
 * snapshot from the top edge to the bottom one. Without view transitions, or with reduced motion, the theme
 * changes at once.
 */
function switchTheme(next: Theme) {
  const root = document.documentElement;

  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setTheme(next);

    return;
  }

  document.querySelector(".theme-wipe-line")?.remove();

  const line = document.createElement("div");

  line.className = "theme-wipe-line";
  line.setAttribute("aria-hidden", "true");
  document.body.append(line);
  root.setAttribute("data-theme-wipe", "");

  pending = next;

  const transition = document.startViewTransition(() => {
    if (wipe === transition) pending = null;

    setTheme(next);
    line.setAttribute("data-end", "");
  });

  wipe = transition;

  void transition.finished.finally(() => {
    line.remove();

    if (wipe === transition) {
      wipe = null;
      root.removeAttribute("data-theme-wipe");
    }
  });
}

/**
 * Switches between light and dark and remembers the choice: an icon only, named for screen readers. Both icons
 * are rendered and globals.css shows the one matching the theme on screen, so the server HTML is right from the
 * first frame, before hydration. The two names come from the page, in its language.
 */
export function ThemeToggle({ toLight, toDark }: { toLight: string; toDark: string }) {
  function toggle() {
    const next: Theme = (pending ?? currentTheme()) === "dark" ? "light" : "dark";

    switchTheme(next);

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
        <span className="sr-only">{toLight}</span>
      </span>
      <span data-when="light">
        <span aria-hidden>☾</span>
        <span className="sr-only">{toDark}</span>
      </span>
    </button>
  );
}
