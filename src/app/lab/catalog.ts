export type LabState = "loading-start" | "loading-retry" | "error" | "load-failed" | "feedback";

export type LabVariant = {
  id: string;
  label: string;
  question: string;
  state?: LabState;
};

export type LabGroup = { id: string; title: string; variants: LabVariant[] };

export const LAB_GROUPS: LabGroup[] = [
  {
    id: "player_event_history",
    title: "Palmarès de joueur",
    variants: [
      { id: "history-worlds", label: "tous les Worlds", question: "Résultats de Chovy à tous les Worlds" },
      { id: "history-long", label: "carrière longue", question: "Faker aux Worlds" },
      { id: "history-league", label: "une saison de ligue", question: "Caps en LEC 2024" },
      { id: "history-ambiguous", label: "alias ambigu", question: "jihoon aux Worlds" },
    ],
  },
  {
    id: "player_comparison",
    title: "Duel de joueurs",
    variants: [
      { id: "versus", label: "sans statistique", question: "Faker contre Chovy" },
      { id: "versus-focus", label: "statistique mise en avant", question: "Faker vs Chovy pentakills" },
      { id: "versus-scope", label: "dans une compétition", question: "Caps contre Humanoid en LEC" },
      { id: "versus-no-h2h", label: "jamais affrontés", question: "Saken vs Kyeahoo" },
      { id: "versus-lpl", label: "LPL, sans in-game", question: "Knight vs Scout pentakills en LPL" },
    ],
  },
  {
    id: "champion_pool",
    title: "Champion pool",
    variants: [
      { id: "pool-player", label: "joueur, carrière", question: "Champion pool de Faker" },
      { id: "pool-player-event", label: "joueur, un tournoi", question: "Champion pool de Chovy aux Worlds 2024" },
      { id: "pool-team", label: "équipe", question: "Champion pool de T1 aux Worlds 2025" },
    ],
  },
  {
    id: "player_runes",
    title: "Runes de joueur",
    variants: [
      { id: "runes-full", label: "pages complètes", question: "Keystones de Chovy en LCK 2025" },
      { id: "runes-worlds-2019", label: "Worlds 2019", question: "Runes de Faker aux Worlds 2019" },
      { id: "runes-keystone-only", label: "keystone seule (LPL 2019)", question: "Runes de Rookie en LPL 2019" },
      { id: "runes-champion", label: "sur un champion", question: "Runes de Faker sur Azir" },
      { id: "runes-none", label: "aucune rune avant 2018", question: "Runes de Faker aux Worlds 2016" },
    ],
  },
  {
    id: "player_leaderboard",
    title: "Classement de joueurs",
    variants: [
      { id: "players-role", label: "un poste", question: "Meilleurs mids aux Worlds 2026" },
      { id: "players-criterion", label: "un critère", question: "Quel ADC a la plus grosse part de l'or aux Worlds 2025 ?" },
      { id: "players-side", label: "un côté de carte", question: "Meilleurs ADC côté rouge aux Worlds 2025" },
      { id: "players-games", label: "nombre de parties", question: "quel joueur a joué le plus de parties aux Worlds" },
    ],
  },
  {
    id: "player_recent_games",
    title: "Forme récente",
    variants: [
      { id: "recent", label: "dernières parties", question: "Forme récente de Faker" },
      { id: "recent-event", label: "dans un tournoi", question: "5 dernières parties de Faker aux Worlds 2025" },
    ],
  },
  {
    id: "player_ingame_stats",
    title: "Stats in-game de joueur",
    variants: [
      { id: "ingame-player", label: "un total", question: "combien de pentakills Faker a-t-il fait aux Worlds" },
      { id: "ingame-player-diff", label: "un écart à 15 min", question: "écart d'or à 15 minutes de Chovy en LCK 2024" },
    ],
  },
  {
    id: "ingame_leaderboard",
    title: "Classement in-game",
    variants: [
      { id: "ingame-board-players", label: "joueurs", question: "quel joueur a fait le plus de solo kills aux Worlds" },
      { id: "ingame-board-teams", label: "équipes", question: "Qui prend le plus souvent le premier dragon au MSI 2023 ?" },
      { id: "ingame-board-role", label: "un poste", question: "meilleur midlaner en gold diff à 15 en LEC 2024" },
      { id: "ingame-board-dragons", label: "dragons", question: "équipes avec le plus de dragons ancestraux en LCK 2025" },
    ],
  },
  {
    id: "team_history",
    title: "Palmarès d'équipe",
    variants: [
      { id: "team-history", label: "une compétition", question: "historique de T1 aux Worlds" },
      { id: "team-history-all", label: "toutes compétitions", question: "palmarès de KC" },
      { id: "team-history-schedule", label: "séries du calendrier seul", question: "Historique de T1 Rookies en LCK AS 2020" },
    ],
  },
  {
    id: "head_to_head",
    title: "Confrontation d'équipes",
    variants: [
      { id: "h2h", label: "toutes compétitions", question: "KC contre MKOI" },
      { id: "h2h-long", label: "longue rivalité", question: "T1 contre Gen.G en LCK" },
      { id: "h2h-short", label: "peu de séries", question: "T1 vs Anyone's Legend" },
      { id: "h2h-schedule", label: "forfait du calendrier seul", question: "Gen.G contre Fredit BRION en LCK 2022" },
    ],
  },
  {
    id: "team_roster",
    title: "Roster",
    variants: [
      { id: "roster", label: "une saison", question: "Samsung White roster 2014" },
      { id: "roster-role", label: "un poste", question: "ADC de T1" },
      { id: "roster-event", label: "un tournoi", question: "line-up de G2 au MSI 2019" },
      { id: "roster-subs", label: "avec remplaçants", question: "roster de SKT en 2015" },
    ],
  },
  {
    id: "team_leaderboard",
    title: "Classement d'équipes",
    variants: [
      { id: "teams-side", label: "winrate par côté", question: "Équipes au meilleur winrate côté bleu en LEC 2025" },
      { id: "teams-duration", label: "durée des parties", question: "Quelle équipe a les parties les plus courtes en LCK 2025" },
    ],
  },
  {
    id: "team_ingame_stats",
    title: "Stats in-game d'équipe",
    variants: [
      { id: "ingame-team", label: "first blood", question: "first blood de T1 aux Worlds 2023" },
      { id: "ingame-team-diff", label: "écart d'or", question: "écart d'or à 10 minutes de G2 aux Worlds 2022" },
    ],
  },
  {
    id: "dragon_stats",
    title: "Dragons",
    variants: [
      { id: "dragons-souls", label: "âmes d'un tournoi", question: "quelles âmes ont été prises aux Worlds 2026" },
      { id: "dragons-team", label: "une équipe", question: "types de dragons pris par T1 aux Worlds" },
    ],
  },
  {
    id: "champion_event_stats",
    title: "Fiche champion",
    variants: [
      { id: "champion", label: "fiche complète", question: "Stats d'Azir aux Worlds 2025" },
      { id: "champion-items", label: "items", question: "Items de Yunara aux Worlds 2026" },
      { id: "champion-runes", label: "runes", question: "Runes de Yunara aux Worlds 2026" },
      { id: "champion-spells", label: "sorts d'invocateur", question: "sorts d'invocateur de Yunara aux Worlds 2026" },
      { id: "champion-split", label: "un split de ligue", question: "stats de Lee Sin en LCK spring 2024" },
      { id: "champion-old", label: "avant les runes", question: "stats d'Ahri aux Worlds 2015" },
    ],
  },
  {
    id: "champion_ranking",
    title: "Classement de champions",
    variants: [
      { id: "champions-picks", label: "les plus joués", question: "Champions les plus joués aux Worlds 2024" },
      { id: "champions-bans", label: "les plus bannis", question: "Champions les plus bannis en LCK 2025" },
      { id: "champions-average", label: "moyenne par partie", question: "Champions avec le plus de morts par game aux Worlds 2026" },
      { id: "champions-total", label: "total", question: "champion avec le plus de morts au worlds 2026 avec plus de 4 parties" },
      { id: "champions-lane", label: "un poste, in-game", question: "Champions avec le meilleur écart d'or à 15 min en mid en LEC 2025" },
      { id: "champions-penta", label: "pentakills", question: "champions avec le plus de pentakills en LCK 2024" },
    ],
  },
  {
    id: "champion_matchup",
    title: "Matchup de champions",
    variants: [
      { id: "matchup", label: "deux champions", question: "Azir contre Orianna en mid" },
      { id: "matchup-event", label: "dans une ligue", question: "Azir contre Orianna en LCK 2024" },
      { id: "matchup-list", label: "tous les adversaires", question: "Matchups d'Azir en mid aux Worlds" },
    ],
  },
  {
    id: "series",
    title: "Série en BO",
    variants: [
      { id: "series-final", label: "une finale", question: "Finale des Worlds 2025" },
      { id: "series-phase", label: "une phase entière", question: "quarts de finale des Worlds 2025" },
      { id: "series-teams", label: "deux équipes", question: "T1 vs Gen.G finale LCK 2024" },
      { id: "series-schedule", label: "séries du calendrier seul", question: "Finales LCK AS 2020" },
    ],
  },
  {
    id: "game_timeline",
    title: "Récap de partie",
    variants: [
      { id: "game", label: "scoreboard et timeline", question: "Récap de la game 5 de la finale des Worlds 2024" },
      { id: "game-old", label: "ancienne partie (v4)", question: "comment s'est passée la game 1 de la finale des Worlds 2019" },
      { id: "game-lpl", label: "LPL, sans timeline", question: "timeline de Bilibili Gaming contre JD Gaming game 1 finale LPL 2023" },
    ],
  },
  {
    id: "tournament_standings",
    title: "Classement de tournoi",
    variants: [
      { id: "standings", label: "une édition", question: "Classement des Worlds 2023" },
      { id: "standings-titles", label: "palmarès d'une compétition", question: "palmarès des Worlds" },
      { id: "standings-era", label: "une période", question: "palmarès LEC entre 2016 et 2020" },
    ],
  },
  {
    id: "game_records",
    title: "Records sur une partie",
    variants: [
      { id: "records", label: "une compétition", question: "Record de kills en une partie aux Worlds" },
      { id: "records-player", label: "un joueur", question: "meilleure game de Faker en kills" },
    ],
  },
  {
    id: "states",
    title: "États de la console",
    variants: [
      { id: "state-loading-start", label: "en cours, début", question: "Faker contre Chovy", state: "loading-start" },
      { id: "state-loading-retry", label: "en cours, nouvel essai", question: "first blood de Fnatic aux Worlds 2016", state: "loading-retry" },
      { id: "state-feedback", label: "réponse avec avis", question: "Classement des Worlds 2023", state: "feedback" },
      { id: "state-empty", label: "aucune partie", question: "champion pool de Faker en LEC" },
      { id: "state-zero", label: "vrai zéro", question: "quel champion a le plus de pentakills aux Worlds 2024" },
      { id: "state-relaxed", label: "filtre relâché", question: "Faker aux Worlds 2014" },
      { id: "state-one-sided", label: "un seul côté a des parties", question: "Faker contre Caps en LEC" },
      { id: "state-self-correction", label: "auto-correction", question: "first blood de Fnatic aux Worlds 2016" },
      { id: "state-missing", label: "donnée absente", question: "pentakills de Ruler en LPL" },
      { id: "state-missing-mvp", label: "donnée jamais stockée", question: "qui a été MVP des Worlds 2024" },
      { id: "state-out-of-scope", label: "hors périmètre", question: "classement de la LLA 2023" },
      { id: "state-off-topic", label: "hors sujet", question: "quelle est la météo à Paris" },
      { id: "state-no-llm", label: "SQL sans LLM", question: "durée moyenne des games en LPL 2024" },
      { id: "state-error", label: "erreur de l'agent", question: "Faker contre Chovy", state: "error" },
      { id: "state-load-failed", label: "chargement impossible", question: "Faker contre Chovy", state: "load-failed" },
    ],
  },
];

export const LAB_VARIANTS = LAB_GROUPS.flatMap((g) => g.variants.map((v) => ({ ...v, group: g.id, groupTitle: g.title })));

export const LAB_FIXTURES = "/lab-fixtures";
