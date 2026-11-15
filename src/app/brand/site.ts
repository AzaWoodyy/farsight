/**
 * Name, tagline and base URL of the site, shared by the header, the metadata and the generated images.
 * The description is the search snippet, the Open Graph and Twitter text and the JSON-LD: one sentence that
 * stands alone, about 150 characters so Google shows it whole.
 */
export const SITE = {
  name: "Farsight",
  tagline: "L'esport League of Legends en une question",
  description:
    "Farsight répond à tes questions sur les matchs pros de League of Legends (Worlds, MSI, LCK, LPL, LEC, LCS) avec un tableau et ses sources Leaguepedia.",
  url: "https://askfarsight.com",
} as const;

/** The palette the generated images use (globals.css holds the page's). */
export const PALETTE = {
  light: { background: "#fafaf9", foreground: "#1c1917", muted: "#78716c", accent: "#b45309" },
  dark: { background: "#0c0a09", foreground: "#e7e5e4", muted: "#a8a29e", accent: "#f59e0b" },
} as const;
