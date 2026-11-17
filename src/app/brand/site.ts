/** Name and base URL of the site. Its texts are per language: see i18n/shell. */
export const SITE = { name: "Farsight", url: "https://askfarsight.com" } as const;

/** A path as an absolute URL; the home page keeps the bare domain, without a trailing slash. */
export const absoluteUrl = (path: string) => (path === "/" ? SITE.url : `${SITE.url}${path}`);

/** The palette the generated images use (globals.css holds the page's). */
export const PALETTE = {
  light: { background: "#fafaf9", foreground: "#1c1917", muted: "#78716c", accent: "#b45309" },
  dark: { background: "#0c0a09", foreground: "#e7e5e4", muted: "#a8a29e", accent: "#f59e0b" },
} as const;
