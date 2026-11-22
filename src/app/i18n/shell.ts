import type { Locale } from "./locales";

const fr = {
  tagline: "L'esport League of Legends (LoL) en une question",
  description:
    "Pose une question sur l'esport LoL (League of Legends), Farsight répond avec ses sources : Worlds, MSI, LCK, LPL, LEC, LCS.",
  dataset:
    "Wiki communautaire de l'esport League of Legends : résultats des matchs, compositions, picks et bans, statistiques des joueurs et des équipes de chaque compétition.",
  homeLabel: "Farsight, retour à l'accueil",
  chat: { label: "Conversation", short: "Chat", stage: "bêta", trail: "conversation (bêta)", opening: "Ouverture de la conversation…", closed: "La conversation n’est pas ouverte sur ce site pour l’instant." },
  theme: { toLight: "Passer au thème clair", toDark: "Passer au thème sombre" },
  footer: {
    data: "Données",
    icons: "icônes",
    photos: "photos des joueurs et logos des équipes © Riot Games, les ligues et les équipes, via Leaguepedia",
    madeBy: "Projet réalisé par",
    privacy:
      "Questions enregistrées sans adresse IP ni identifiant, envoyées au modèle de langage et visibles dans l'adresse de la page : évite d'y mettre des informations personnelles.",
    riot: "Farsight n'est ni approuvé ni sponsorisé par Riot Games.",
    how: "Comment Farsight fonctionne",
    legal: "Mentions légales et confidentialité",
  },
  share: {
    questions: ["Faker contre Chovy", "Stats d'Azir aux Worlds 2025", "Champions les plus bannis en LCK 2025"],
    credit: "Données Leaguepedia et Riot Data Dragon · askfarsight.com",
  },
  notFound: { title: "Page introuvable", home: "Retour à l'accueil" },
};

export type Shell = typeof fr;

const en: Shell = {
  tagline: "League of Legends (LoL) esports in one question",
  description:
    "Ask a question about LoL (League of Legends) esports, Farsight answers with its sources: Worlds, MSI, LCK, LPL, LEC, LCS.",
  dataset:
    "Community wiki of League of Legends esports: match results, drafts, picks and bans, player and team statistics of every competition.",
  homeLabel: "Farsight, back to the home page",
  chat: { label: "Conversation", short: "Chat", stage: "beta", trail: "conversation (beta)", opening: "Opening the conversation…", closed: "The conversation is not open on this site for now." },
  theme: { toLight: "Switch to the light theme", toDark: "Switch to the dark theme" },
  footer: {
    data: "Data from",
    icons: "icons from",
    photos: "player photos and team logos © Riot Games, the leagues and the teams, via Leaguepedia",
    madeBy: "Built by",
    privacy:
      "Questions are logged without an IP address or an identifier, sent to the language model and visible in the page address: avoid personal information.",
    riot: "Farsight isn't endorsed or sponsored by Riot Games.",
    how: "How Farsight works",
    legal: "Legal notice and privacy",
  },
  share: {
    questions: ["Faker vs Chovy", "Azir stats at Worlds 2025", "Most banned champions in LCK 2025"],
    credit: "Data from Leaguepedia and Riot Data Dragon · askfarsight.com",
  },
  notFound: { title: "Page not found", home: "Back to the home page" },
};

export const SHELL: Record<Locale, Shell> = { fr, en };
