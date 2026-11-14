/** Name, tagline and base URL of the site, shared by the header, the metadata and the generated images. */
export const SITE = {
  name: "Minimap",
  tagline: "L'esport League of Legends en une question",
  description:
    "Pose une question sur l'esport League of Legends : Minimap cherche dans les matchs pros (Worlds, MSI, LCK, LPL, LEC, LCS…) et répond avec un tableau et ses sources Leaguepedia.",
  url: "https://lolesport.enzoneault.dev",
} as const;

/** Identity directions, picked with ?theme= until one is chosen. The first one is the default. */
export const THEMES = ["minimap", "ambre", "baron"] as const;

export type ThemeName = (typeof THEMES)[number];

/**
 * Runs in <head> before the first paint: applies a valid ?theme= to <html>, so the
 * page never flashes the default palette. Anything else keeps the default.
 */
export const THEME_SCRIPT = `(function(){try{var t=new URLSearchParams(location.search).get("theme");if(${JSON.stringify(THEMES)}.indexOf(t)>=0)document.documentElement.dataset.theme=t}catch(e){}})()`;
