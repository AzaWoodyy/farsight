# lol-esports-agent

Agent de recherche en langage naturel sur les données esport de League of Legends.

On pose une question (« résultats de Chovy à tous les Worlds »), l'agent la
traite en quatre étapes visibles, et l'interface affiche en direct la trace,
puis un tableau triable, une phrase de synthèse, les sources et des questions
de suivi.

> **État** : ce dépôt contient le POC, encore basé sur LangGraph. La cible
> retenue est l'[AI SDK 7](https://ai-sdk.dev) avec OpenRouter (voir
> [AGENTS.md](AGENTS.md)). Cette page sera mise à jour avec la migration.

```
question
  └─ understand    entités joueur / compétition / période, alias (Chovy, 정지훈, Jihun)
  └─ build_query   requête SQL contre le cache SQLite local
  └─ guard         garde-fou de schéma : lecture seule, tables et colonnes connues
  └─ execute       exécution
       └─ correct  auto-correction si vide ou en erreur (visible dans la trace)
  └─ format        tableau, synthèse, sources, suggestions
```

## Stack

Next.js 16 (App Router) · Bun · Tailwind CSS 4 · Geist · AI SDK 7 + OpenRouter
(cible ; le POC utilise encore `@langchain/langgraph`) · SQLite (`node:sqlite`,
aucune dépendance native).

## Lancer en local

Prérequis : [Bun](https://bun.sh) 1.3+ et Node.js 22.13+ (pour `node:sqlite`).

```bash
bun install
cp .env.example .env          # facultatif : configuration du LLM
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

> L'agent du POC lit encore l'ancien schéma : il sera adapté au nouveau lors de
> la migration vers l'AI SDK.

### LLM

Le fournisseur se configure uniquement par variables d'environnement (voir
`.env.example`). Les clés vont dans `.env`, qui n'est jamais commité.

- `LLM_PROVIDER=none` (défaut) : graphe entièrement déterministe. Les entités
  sont reconnues par règles et par la table d'alias, la synthèse vient d'un
  modèle de phrase.
- `LLM_PROVIDER=anthropic` ou `openai` (tout endpoint compatible OpenAI via
  `OPENAI_BASE_URL`) : le LLM extrait les entités, répare une requête rejetée et
  rédige la synthèse. La résolution des joueurs reste faite contre la table
  d'alias locale.

## Structure

```
scripts/data/                data:fetch (sources -> data/raw) et data:build (-> SQLite)
scripts/ask.ts               agent en CLI
src/lib/sources/             clients Leaguepedia (Cargo) et Data Dragon
src/lib/db/                  schéma et accès SQLite
src/lib/agent/               graphe LangGraph, compréhension, requêtes, garde-fou
src/app/api/ask/route.ts     trace du graphe en streaming (NDJSON)
src/app/                     interface (chat, trace, tableau triable)
```

## Périmètre actuel

Premier jalon : historique d'un joueur sur toutes les éditions des Worlds
(équipe, place finale, bilan V-D en parties, champions joués). Les autres
questions (comparaisons, MSI, ligues régionales, historique d'équipe) ne sont
pas encore prises en charge.

## Sources et licences

- Données : [Leaguepedia](https://lol.fandom.com) (licence
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). Chaque
  réponse renvoie vers les pages Leaguepedia utilisées.
- Noms et icônes de champions : [Riot Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon).
- Projet non affilié à Riot Games. League of Legends est une marque de Riot Games, Inc.
