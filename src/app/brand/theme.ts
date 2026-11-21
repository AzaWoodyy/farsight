import { PALETTE } from "./site";

export type Theme = "light" | "dark";

export const THEME_KEY = "farsight-theme";

function applyTheme(theme: "light" | "dark", colors: Record<string, string>) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", colors[theme] ?? ""));
}

const COLORS = { light: PALETTE.light.background, dark: PALETTE.dark.background };

export const setTheme = (theme: Theme) => applyTheme(theme, COLORS);

export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")(${applyTheme.toString()})(t,${JSON.stringify(COLORS)})}catch(e){}`;
