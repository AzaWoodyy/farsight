# lol-esports-agent

Agent de recherche en langage naturel sur les données esport de League of Legends.

On pose une question (« résultats de Chovy à tous les Worlds »), l'agent la
traite en quatre étapes visibles, et l'interface affiche en direct la trace,
puis un tableau triable, une phrase de synthèse, les sources et des questions
de suivi.

```
question
  ├─ 1 understand  entités joueur / compétition / période, alias (Chovy, 정지훈, Jihun)
  ├─ 2 build       outil typé paramétré, ou text-to-SQL de secours
  ├─ 3 execute     garde-fou de schéma, exécution, auto-correction si vide ou en erreur
  └─ 4 format      tableau triable, synthèse, sources, questions de suivi
```

Les étapes sont écrites à la main (pas de framework de graphe) et envoyées à
l'interface en streaming, sous forme de data parts typées de l'AI SDK.

## Stack

Next.js 16 (App Router) · Bun · Tailwind CSS 4 · Geist · AI SDK 7
(`ai`, `@ai-sdk/react`) + OpenRouter (`@openrouter/ai-sdk-provider`) · SQLite
(`node:sqlite`, aucune dépendance native).

## Lancer en local

Prérequis : [Bun](https://bun.sh) 1.3+ et Node.js 22.13+ (pour `node:sqlite`).

```bash
bun install
cp .env.example .env          # facultatif : clé OpenRouter
bun run data:fetch            # Leaguepedia + Data Dragon -> data/raw (~3 min la première fois)
bun run data:build            # data/raw -> data/lol.sqlite (~80 Mo, quelques secondes)
bun run dev                   # http://localhost:3000
```

En ligne de commande, sans serveur :

```bash
bun run ask "résultats de Chovy à tous les Worlds"
```

### Ingestion

Deux commandes, dans `scripts/data/` :

- `data:fetch` lit les tables Cargo de Leaguepedia (`Tournaments`,
  `TournamentResults`, `ScoreboardGames`, `ScoreboardPlayers`, `Players`,
  `PlayerRedirects`) pour les 19 ligues du périmètre (voir `scope.ts`), et
  Data Dragon (champions, objets, runes, sorts, plus les objets des anciens
  patchs pour les icônes des objets retirés).
  - Une requête à la fois, au moins 2 s d'écart (`LEAGUEPEDIA_DELAY_MS`,
    2,5 s par défaut), backoff exponentiel en cas d'erreur, par ligue et par
    pages de 5 000 lignes via `Special:CargoExport`.
  - Chaque réponse brute est gardée dans `data/raw/cargo/` : relancer ne refait
    aucun appel. `--refresh` ignore ce cache (reconstruction mensuelle).
  - `--incremental [--days=14]` ne récupère que les tournois en cours ou
    terminés depuis moins de `days` jours, et les fusionne dans les jeux de
    données existants (`data/raw/*.json`).
- `data:build` reconstruit `data/lol.sqlite` de zéro à partir de `data/raw/`
  (schéma normalisé à ids entiers, tables de correspondance, vues `v_*` qui
  remettent les noms), puis `journal_mode=DELETE` et `VACUUM`.
  - Chaque tournoi est classé d'après son nom de page (`tournaments.stage` :
    `event`, `main_event`, `play_in`, `qualifier`, `season`, `playoffs`), car
    Leaguepedia range les qualifications régionales sous le label
    `World Championship`. `event_page` pointe vers la page des classements.
  - `ingest_runs` garde l'historique des récupérations et la construction
    (date, nombre de lignes, version du schéma, aussi dans `PRAGMA user_version`).
  - Les objets absents de Data Dragon gardent une icône de repli
    (`public/icons/item-fallback.svg`, `items.icon_source = 'fallback'`).

`data/` n'est jamais commité.

### Agent

`runAgent()` (`src/lib/agent/run.ts`) enchaîne les quatre étapes. Chaque point
de décision passe par `decide()` (`src/lib/agent/decide.ts`), une cascade du
moins cher au plus cher qui renvoie un résultat, une confiance (0 à 1) et le
niveau utilisé :

| Niveau  | Contenu                                                    | Coût        |
|---------|------------------------------------------------------------|-------------|
| `rules` | regex, table d'alias, outils typés, corrections déterministes | 0, ~1 ms |
| `model` | petit modèle local (classifieur, NER) : réservé, pas encore branché | CPU |
| `llm`   | OpenRouter                                                  | tokens      |

La cascade s'arrête au premier résultat assez sûr ; sinon le plus confiant
l'emporte. Un niveau indisponible (pas de clé) ou en erreur est sauté, et la
trace affiche le niveau et la confiance de chaque décision.

| Étape      | `rules`                                         | `llm` (si la règle hésite)            |
|------------|-------------------------------------------------|----------------------------------------|
| understand | n-grammes contre la table d'alias, regex de ligue et d'années | extraction structurée des entités, résolues ensuite contre la table d'alias |
| build      | outil typé `player_event_history`               | text-to-SQL sur les vues autorisées    |
| execute    | retirer le filtre de période, essayer un homonyme, reconstruire le modèle | réparer la requête rejetée |
| format     | phrase construite à partir des agrégats         | phrase rédigée, sans fait ajouté       |

Garde-fou (`src/lib/agent/guard.ts`), appliqué à toute requête, typée ou
générée : base ouverte en lecture seule, `SELECT`/`WITH` uniquement, une seule
instruction, tables limitées aux vues `v_*` et à quelques tables de
correspondance, colonnes connues, `LIMIT 200` forcé, puis `prepare()` comme
validateur final. Les requêtes excluent `stage = 'qualifier'` (et les pages
`event`, qui ne portent que les classements).

Streaming : `POST /api/ask` reçoit la requête de `useChat` et renvoie un flux
de messages UI avec une part `data-step` par étape (mise à jour sur place,
`id` = nom de l'étape) et une part `data-answer` finale. `bun run ask` lit les
mêmes événements en CLI.

### LLM

Uniquement via OpenRouter, configuré par variables d'environnement (voir
`.env.example`). La clé va dans `.env`, jamais commité.

- Sans `OPENROUTER_API_KEY` : agent entièrement déterministe. Seul le niveau
  `rules` répond ; une question hors des outils typés reçoit une réponse vide
  expliquée.
- Avec une clé (plafonnée côté OpenRouter) : le LLM n'est appelé que lorsque
  les règles ne sont pas assez sûres, plus la phrase de synthèse. Modèle
  `OPENROUTER_MODEL`, par défaut `anthropic/claude-haiku-5.5`. Chaque appel est
  borné (600 jetons de sortie, 15 s, une seule relance).

## Structure

```
scripts/data/                data:fetch (sources -> data/raw) et data:build (-> SQLite)
scripts/ask.ts               agent en CLI
src/lib/sources/             clients Leaguepedia (Cargo) et Data Dragon
src/lib/db/                  accès SQLite en lecture seule
src/lib/agent/run.ts         les quatre étapes et leur streaming
src/lib/agent/decide.ts      cascade rules -> model -> llm
src/lib/agent/understand.ts  entités et alias
src/lib/agent/query.ts       outil typé, text-to-SQL, auto-correction
src/lib/agent/guard.ts       garde-fou de schéma
src/lib/agent/llm.ts         client OpenRouter
src/app/api/ask/route.ts     flux de messages UI (data parts) pour useChat
src/app/                     interface (étapes, tableau triable)
```

## Périmètre actuel

Outil typé : historique d'un joueur dans une compétition du périmètre (Worlds,
MSI, ligues régionales) : équipe, place finale, bilan V-D en parties, champions
joués. Les autres questions (comparaisons, historique d'équipe) passent par le
text-to-SQL si une clé OpenRouter est configurée, sinon elles ne sont pas encore
prises en charge.

## Sources et licences

- Données : [Leaguepedia](https://lol.fandom.com) (licence
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). Chaque
  réponse renvoie vers les pages Leaguepedia utilisées.
- Noms et icônes de champions : [Riot Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon).
- Projet non affilié à Riot Games. League of Legends est une marque de Riot Games, Inc.
