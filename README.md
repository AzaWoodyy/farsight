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
bun run data:build            # data/raw -> data/lol.sqlite (~68 Mo, quelques secondes)
bun run dev                   # http://localhost:3000
```

Au lieu de `data:fetch` + `data:build`, `bun run data:pull` télécharge la
dernière base publiée (il faut `DATA_GITHUB_TOKEN`, voir
[docs/deploy.md](docs/deploy.md)).

En ligne de commande, sans serveur :

```bash
bun run ask "résultats de Chovy à tous les Worlds"
bun run eval                  # questions de référence, score par question et global
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
  - La base ne garde que les colonnes, tables et index lus par les vues `v_*`
    et par les outils (budget : 100 Mo). Le cache brut garde tout le reste
    (objectifs par partie, runes secondaires, sorts, trinket…) : une
    reconstruction suffit pour en remettre une colonne.
  - Chaque tournoi est classé d'après son nom de page (`tournaments.stage` :
    `event`, `main_event`, `play_in`, `qualifier`, `season`, `playoffs`), car
    Leaguepedia range les qualifications régionales sous le label
    `World Championship`. `event_page` pointe vers la page des classements.
  - `ingest_runs` garde l'historique des récupérations et la construction
    (date, nombre de lignes, version du schéma, aussi dans `PRAGMA user_version`).
  - Les objets absents de Data Dragon gardent une icône de repli
    (`public/icons/item-fallback.svg`) ; le décompte par origine d'icône est
    gardé dans `ingest_runs`.

`data/` n'est jamais commité. La base versionnée est publiée en release
GitHub par le workflow « Data release », et `data:pull` la récupère au build
(voir [docs/deploy.md](docs/deploy.md)).

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
| understand | n-grammes contre les tables d'alias (joueurs, équipes, champions), regex de ligue, d'années et de split | extraction structurée des entités, résolues ensuite contre les tables d'alias |
| build      | routage vers un outil typé (`src/lib/agent/tools.ts`) | choix d'outil par appel d'outil AI SDK, sinon text-to-SQL sur les vues `v_*` |
| execute    | corrections propres à l'outil : retirer la période, le split ou la compétition, essayer un homonyme | réparer la requête rejetée, en erreur ou vide (text-to-SQL) |
| format     | phrase construite à partir des agrégats         | la même phrase reformulée ; rejetée si elle ajoute un chiffre ou une période |

Outils typés (`src/lib/agent/tools.ts`) : chaque outil a un schéma zod
d'entrée (partagé avec le LLM via `tool()` de l'AI SDK, sans `execute` : la
requête passe toujours par le garde-fou), une requête paramétrée, ses
corrections déterministes, sa mise en forme et ses sources Leaguepedia.

| Outil                  | Question type                                   | Sortie |
|------------------------|-------------------------------------------------|--------|
| `player_event_history` | « résultats de Chovy à tous les Worlds »       | par édition : équipe, place finale, V-D, champions joués |
| `team_history`         | « historique de T1 aux Worlds »                | par tournoi : place, V-D ; titres (hors saison régulière) ; noms successifs fusionnés (SK Telecom T1 → T1) |
| `head_to_head`         | « T1 contre Gen.G en LCK », « Faker vs Chovy » | victoires de chaque côté en parties, par tournoi |
| `champion_event_stats` | « stats d'Ahri aux Worlds 2024 »               | picks, bans, présence, % de victoires, joueurs |
| `tournament_standings` | « qui a gagné les Worlds 2023 », « palmarès du MSI » | classement complet d'une édition, ou vainqueur et finaliste de chaque édition |

Sans compétition précisée, les outils joueur, champion et palmarès cherchent
sur les Worlds (et le disent). « LCS 2016 », « LEC 2017 » et « LCK 2014 »
pointent vers la ligue de l'époque (NA LCS, EU LCS, OGN Champions). Les
statistiques que les outils ne calculent pas (kills, or, durées, classements
ouverts) partent en text-to-SQL ; les compétitions et jeux hors périmètre
(LJL, VCT…) reçoivent une réponse « hors périmètre » sans requête.

Données absentes : quand la question demande une donnée que la base ne
contient pas (pentakills, solo kills, first blood, wards, objectifs par partie, sorts
d'invocateur, MVP), l'agent répond « Donnée absente de la base » sans requête
ni chiffre. La règle associe chaque notion à la colonne de vue qui la
porterait : elle cesse de s'appliquer d'elle-même si une reconstruction ajoute
cette colonne. Pour les autres notions, le text-to-SQL signale lui-même la
donnée manquante au lieu de renvoyer une constante (une requête du type
`WHERE 0 = 1` est traitée de la même façon).

Synthèse LLM : le modèle ne reçoit que la phrase de faits de l'outil (agrégats
du périmètre de la question), pas les lignes brutes. Une phrase qui contient
un chiffre ou un mot de période (« saison », « cette année »…) absent de ces
faits est rejetée, et la phrase des règles est gardée.

Les mots d'une expression de stats ou de jeu connue (« solo kills », « first
blood », « mid lane »…) ne sont jamais pris pour des alias : « solo » dans
« solo kills » n'est pas le joueur Solo, qui reste reconnu seul (« Solo aux
Worlds »).

Alias ambigus : quand un alias désigne plusieurs joueurs (정지훈 → Chovy ou
Pullbae, Caps / caPs), l'agent retient le plus probable (casse exacte du
pseudo, puis parties dans la compétition et la période de la question, puis
parties au total), le signale dans une note avec les autres candidats, et
propose la même question pour les autres en questions de suivi.

Garde-fou (`src/lib/agent/guard.ts`), appliqué à toute requête, typée ou
générée : base ouverte en lecture seule, `SELECT`/`WITH` uniquement, une seule
instruction, colonnes connues, `LIMIT 200` forcé, puis `prepare()` comme
validateur final, sous l'autorisateur SQLite qui refuse toute lecture d'une
table hors liste (jointures par virgule, sous-requêtes, CTE). Le text-to-SQL
ne lit que les vues `v_*` ; les outils typés lisent aussi quelques tables de
correspondance (icônes de champions). Les requêtes excluent
`stage = 'qualifier'` (et les pages `event`, qui ne portent que les
classements).

Streaming : `POST /api/ask` reçoit la requête de `useChat` et renvoie un flux
de messages UI avec une part `data-step` par étape (mise à jour sur place,
`id` = nom de l'étape) et une part `data-answer` finale. `bun run ask` lit les
mêmes événements en CLI.

### LLM

Uniquement via OpenRouter, configuré par variables d'environnement (voir
`.env.example`). La clé va dans `.env`, jamais commité.

- Sans `OPENROUTER_API_KEY` : agent entièrement déterministe. Seul le niveau
  `rules` répond ; une question hors des outils typés reçoit une réponse vide
  expliquée (text-to-SQL requis mais désactivé).
- Avec une clé (plafonnée côté OpenRouter) : le LLM n'est appelé que lorsque
  les règles ne sont pas assez sûres, plus la phrase de synthèse. Modèle
  `OPENROUTER_MODEL`, par défaut `anthropic/claude-haiku-5.5`. Chaque appel est
  borné (600 jetons de sortie, 15 s, une seule relance).
- Clé épuisée (402, ou 403 « Key limit exceeded ») : le LLM est coupé pendant
  15 minutes, l'agent repasse en mode déterministe, et la réponse le dit dans
  une note.

## Déploiement

Vercel (Hobby), avec la base incluse dans la fonction `/api/ask`, BotID Basic
sur le chat et un rate limit par IP dans le firewall. La production est
redéployée par GitHub Actions après chaque push sur `main` et chaque release
de données réussie. Procédure et réglages
manuels : [docs/deploy.md](docs/deploy.md).

## Structure

```
scripts/data/                data:fetch (sources -> data/raw), data:build (-> SQLite),
                             data:package (contrôles + assets de release), data:pull (release -> data/)
.github/workflows/           data-release.yml : ingestion hebdo et release data-YYYYMMDD
                             deploy.yml : déploiement de main en production (push, release réussie)
scripts/ask.ts               agent en CLI
src/lib/sources/             clients Leaguepedia (Cargo) et Data Dragon
src/lib/db/                  accès SQLite en lecture seule
src/lib/agent/run.ts         les quatre étapes et leur streaming
src/lib/agent/decide.ts      cascade rules -> model -> llm
src/lib/agent/understand.ts  entités et alias
src/lib/agent/tools.ts       outils typés (schémas zod, requêtes, corrections, mise en forme)
src/lib/agent/query.ts       routage vers les outils, text-to-SQL, auto-correction
src/lib/agent/guard.ts       garde-fou de schéma
src/lib/agent/llm.ts         client OpenRouter
src/app/api/ask/route.ts     flux de messages UI (data parts) pour useChat
src/app/                     interface (étapes, tableau triable)
src/instrumentation-client.ts  BotID côté client (protège POST /api/ask)
docs/deploy.md               déploiement Vercel et réglages manuels
eval/questions.json          questions de référence et attentes vérifiables
scripts/eval.ts              bun run eval
```

## Évaluation

`eval/questions.json` liste 31 questions de référence (Worlds, MSI, LCK, LPL,
LEC, LCS, alias Chovy / 정지훈 / Ji hun / Lee Sang-hyeok, alias ambigus,
confrontations, auto-correction, text-to-SQL, donnée absente, hors périmètre) avec leurs
attentes : outil ou route, entités résolues, entrée de l'outil, nombre de
lignes, totaux clés (bilan V-D, titres, picks…), ambiguïté signalée, notes,
sources, contenu de la synthèse (mots attendus ou interdits) et absence de
chiffre pour les données absentes. `bun run eval` les rejoue et affiche un score par question et un
score global :

- sans clé, en mode déterministe ; les vérifications qui demandent un résultat
  de text-to-SQL sont ignorées (la route reste vérifiée) ;
- avec `OPENROUTER_API_KEY` dans l'environnement, le même jeu passe par le LLM
  quand les règles hésitent, et le text-to-SQL est vérifié ;
- `--deterministic` ignore la clé, `--only=id1,id2` filtre, `--verbose`
  affiche chaque vérification, `--strict` sort en erreur si une question
  échoue.

Les valeurs attendues viennent de la base complète (schéma v3) ; les totaux
clés ont été recoupés par des requêtes indépendantes sur les tables de base.
Une reconstruction de la base qui change ces chiffres (nouvelle édition,
correction du wiki) demande de mettre à jour le fichier.

## Périmètre actuel

Cinq outils typés (voir plus haut) : historique d'un joueur, historique d'une
équipe, confrontations, stats d'un champion, palmarès et classements. Les
autres questions passent par le text-to-SQL si une clé OpenRouter est
configurée, sinon l'agent explique qu'elles ne sont pas encore prises en
charge.

## Sources et licences

- Données : [Leaguepedia](https://lol.fandom.com) (licence
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)). Chaque
  réponse renvoie vers les pages Leaguepedia utilisées.
- Noms et icônes de champions : [Riot Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon).
- Projet non affilié à Riot Games. League of Legends est une marque de Riot Games, Inc.
