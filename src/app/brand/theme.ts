import { PALETTE } from "./site";

export type Theme = "light" | "dark";

/** localStorage key of the theme the visitor chose. Without it, the page follows the system setting. */
export const THEME_KEY = "farsight-theme";

/**
 * Applies a theme to `<html>` (globals.css reads `data-theme`) and to the browser chrome (`theme-color`).
 * Kept as one self-contained function so the inline script before first paint and the toggle share it.
 */
function applyTheme(theme: "light" | "dark", colors: Record<string, string>) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", colors[theme] ?? ""));
}

const COLORS = { light: PALETTE.light.background, dark: PALETTE.dark.background };

export const setTheme = (theme: Theme) => applyTheme(theme, COLORS);

/**
 * Runs in the static HTML before the first paint: a stored choice is applied before anything is drawn, so a
 * visitor who picked light on a dark system never sees a dark flash. Without a choice, nothing is set and the
 * CSS media query follows the system.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")(${applyTheme.toString()})(t,${JSON.stringify(COLORS)})}catch(e){}`;
