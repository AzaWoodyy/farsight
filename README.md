# lol-esports-agent

Agent de recherche en langage naturel sur les données esport de League of Legends.

On pose une question (« résultats de Chovy à tous les Worlds »), un graphe
[LangGraph](https://langchain-ai.github.io/langgraphjs/) la traite étape par
étape, et l'interface affiche en direct la trace du graphe, puis un tableau
triable, une phrase de synthèse, les sources et des questions de suivi.

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

Next.js 16 (App Router) · Bun · Tailwind CSS 4 · Geist · `@langchain/langgraph` ·
SQLite (`node:sqlite`, aucune dépendance native).

## Lancer en local

Prérequis : [Bun](https://bun.sh) 1.3+ et Node.js 22.13+ (pour `node:sqlite`).

```bash
bun install
cp .env.example .env          # facultatif : configuration du LLM
bun run ingest:worlds         # remplit data/lol.sqlite (Worlds 2011 → aujourd'hui)
bun run dev                   # http://localhost:3000
```

En ligne de commande, sans serveur :

```bash
bun run ask "résultats de Chovy à tous les Worlds"
```

### Ingestion

`scripts/ingest-worlds.ts` lit les tables Cargo de Leaguepedia
(`Tournaments`, `TournamentResults`, `ScoreboardPlayers`, `Players`,
`PlayerRedirects`) et les icônes de champions de Data Dragon, puis écrit le
tout dans `data/lol.sqlite` en une transaction.

- Une requête à la fois, 2 s entre deux requêtes (`LEAGUEPEDIA_DELAY_MS`),
  backoff exponentiel en cas d'erreur.
- Chaque réponse brute est mise en cache dans `data/raw/` : relancer
  l'ingestion ne refait aucun appel. Supprimer `data/raw/` pour rafraîchir.
- L'API `action=cargoquery` est fortement limitée pour les clients anonymes ;
  le script passe par `Special:CargoExport`, qui sert les mêmes données.
- Le schéma (`src/lib/db/schema.ts`) porte déjà une colonne `league` : MSI et
  les ligues (LCK, LPL, LEC, LCS) pourront s'y ajouter sans migration.

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
scripts/ingest-worlds.ts     ingestion Worlds -> SQLite
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
