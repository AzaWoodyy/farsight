/** Name, tagline and base URL of the site, shared by the header, the metadata and the generated images. */
export const SITE = {
  name: "Farsight",
  tagline: "L'esport League of Legends en une question",
  description:
    "Pose une question sur l'esport League of Legends : Farsight cherche dans les matchs pros (Worlds, MSI, LCK, LPL, LEC, LCS…) et répond avec un tableau et ses sources Leaguepedia.",
  url: "https://lolesport.enzoneault.dev",
} as const;

/** The palette the generated images use (globals.css holds the page's). */
export const PALETTE = {
  light: { background: "#fafaf9", foreground: "#1c1917", muted: "#78716c", accent: "#b45309" },
  dark: { background: "#0c0a09", foreground: "#e7e5e4", muted: "#a8a29e", accent: "#f59e0b" },
} as const;
