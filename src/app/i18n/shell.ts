import type { Locale } from "./locales";

/**
 * The texts around the console, in each language: metadata, header, footer, share card and 404. `en` is typed
 * on `fr`, so a text added in one language and forgotten in the other fails the typecheck.
 *
 * Tagline and description both carry "LoL": people search "farsight lol" more than "farsight league of
 * legends", and Google ranks a brand query on the words a page actually contains. The description is the
 * search snippet, the Open Graph and Twitter text and the JSON-LD: one sentence that stands alone, about 150
 * characters so Google shows it whole.
 */
const fr = {
  tagline: "L'esport League of Legends (LoL) en une question",
  description:
    "Farsight répond à tes questions sur les matchs pros de LoL (League of Legends) : Worlds, MSI, LCK, LPL, LEC, LCS, avec un tableau et ses sources Leaguepedia.",
  dataset:
    "Wiki communautaire de l'esport League of Legends : résultats des matchs, compositions, picks et bans, statistiques des joueurs et des équipes de chaque compétition.",
  homeLabel: "Farsight, retour à l'accueil",
  theme: { toLight: "Passer au thème clair", toDark: "Passer au thème sombre" },
  footer: {
    data: "Données",
    icons: "icônes",
    photos: "photos des joueurs et logos des équipes © Riot Games, les ligues et les équipes, via Leaguepedia",
    madeBy: "Projet réalisé par",
    privacy:
      "Questions enregistrées sans adresse IP ni identifiant, et envoyées au modèle de langage : évite d'y mettre des informations personnelles.",
    riot: "Farsight n'est ni approuvé ni sponsorisé par Riot Games.",
    legal: "Mentions légales et confidentialité",
  },
  share: {
    questions: ["Faker contre Chovy", "Stats d'Azir aux Worlds 2025", "Champions les plus bannis en LCK 2025"],
    credit: "Données Leaguepedia et Riot Data Dragon · askfarsight.com",
  },
  notFound: { title: "Page introuvable", body: "Cette adresse ne mène à aucune page de Farsight.", home: "Retour à l'accueil" },
};

export type Shell = typeof fr;

const en: Shell = {
  tagline: "League of Legends (LoL) esports in one question",
  description:
    "Farsight answers your questions about pro LoL (League of Legends) matches: Worlds, MSI, LCK, LPL, LEC, LCS, with a table and its Leaguepedia sources.",
  dataset:
    "Community wiki of League of Legends esports: match results, drafts, picks and bans, player and team statistics of every competition.",
  homeLabel: "Farsight, back to the home page",
  theme: { toLight: "Switch to the light theme", toDark: "Switch to the dark theme" },
  footer: {
    data: "Data from",
    icons: "icons from",
    photos: "player photos and team logos © Riot Games, the leagues and the teams, via Leaguepedia",
    madeBy: "Built by",
    privacy: "Questions are logged without an IP address or an identifier, and sent to the language model: avoid personal information.",
    riot: "Farsight isn't endorsed or sponsored by Riot Games.",
    legal: "Legal notice and privacy",
  },
  share: {
    questions: ["Faker vs Chovy", "Azir stats at Worlds 2025", "Most banned champions in LCK 2025"],
    credit: "Data from Leaguepedia and Riot Data Dragon · askfarsight.com",
  },
  notFound: { title: "Page not found", body: "This address does not lead to any Farsight page.", home: "Back to the home page" },
};

export const SHELL: Record<Locale, Shell> = { fr, en };
