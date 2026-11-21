"use client";

import { setTheme, THEME_KEY, type Theme } from "./brand/theme";

function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");

  if (set === "light" || set === "dark") return set;

  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let wipe: ViewTransition | null = null;

let pending: Theme | null = null;

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

export function ThemeToggle({ toLight, toDark }: { toLight: string; toDark: string }) {
  function toggle() {
    const next: Theme = (pending ?? currentTheme()) === "dark" ? "light" : "dark";

    switchTheme(next);

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
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
