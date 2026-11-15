# Déploiement sur Vercel

Projet Vercel séparé (plan Hobby, quotas partagés avec le portfolio), domaine
`farsight.enzoneault.dev`. Cette page décrit ce que le code fait déjà et les
réglages à faire à la main dans les dashboards GitHub, Vercel et OpenRouter.

## Ce que contient le déploiement

- **Fonction `/api/ask`** (Node 24, `engines.node` dans `package.json`) : la
  base `data/lol.sqlite` est ajoutée au bundle par `outputFileTracingIncludes`
  (`next.config.ts`), puis ouverte en lecture seule (`src/lib/db/index.ts`).
  - Budget : base sous 190 Mo, fonction sous 250 Mo décompressés (limite de
    Vercel). `bun run size`, lancé à la fin de `bun run build`, additionne les
    fichiers tracés de la route et du serveur Next, avertit à partir de 225 Mo
    et fait échouer le build au-delà de 250 Mo (ou si la base dépasse 190 Mo).
    `data/raw` et `data/release` sont exclus du tracé (`next.config.ts`).
  - Mesuré le 14/11/2026 (schéma v5, 28 327 parties avec stats in-game) :
    base 98,6 Mo, fonction 132,4 Mo.
  - `DATABASE_PATH` ne doit pas être défini sur Vercel : le fichier tracé est
    `data/lol.sqlite`.
- **BotID Basic** : `src/instrumentation-client.ts` protège les `POST /api/ask`
  du chat, et la route appelle `checkBotId()` avant tout appel au modèle (403
  si c'est un bot). Hors Vercel (`bun run dev`, `next start` en local), la
  vérification répond « humain ». `bun run ask` et `bun run eval` appellent
  l'agent directement et ne passent pas par la route.
- **Quota OpenRouter** : une réponse 402, ou 403 « Key limit exceeded »,
  coupe le LLM pendant 15 minutes sur l'instance. La requête en cours et les
  suivantes repassent au niveau `rules` (mode déterministe), et la réponse
  affiche une note qui l'explique.

## Construire et déployer

`data/` n'est pas commité. La base versionnée vit dans les releases GitHub
du dépôt, et le build la télécharge avant `next build`.

### Publication : workflow « Data release »

`.github/workflows/data-release.yml` tourne chaque lundi à 05:23 UTC et à la
demande (**Actions** → **Data release** → **Run workflow**) :

1. Restaure `ingame.jsonl.zst` depuis la release précédente si elle a le même
   schéma (résumés in-game déjà calculés).
2. `bun run data:fetch --riot-budget=90` : tables Cargo complètes (environ 200
   requêtes, une à la fois, 3 s d'écart, User-Agent explicite, backoff), puis
   les JSON Riot des parties sans résumé : d'abord lus sur R2 (secrets `R2_*`,
   16 lectures en parallèle, hors budget et sans délai), puis, pour celles que
   R2 n'a pas, téléchargés depuis le wiki (2 par requête, 90 min au plus ; le
   reste passe à la semaine suivante) et envoyés sur R2. Le log sépare les
   compteurs `from R2` et `from the wiki`. Enfin Data Dragon.
3. `bun run data:build` : `data/lol.sqlite`, fini par
   `journal_mode=DELETE` et `VACUUM`.
4. `bun run data:package` : contrôles, puis assets de release. Le workflow
   s'arrête sans rien publier si l'un d'eux échoue :
   - `integrity_check`, `foreign_key_check`, mode de journal `delete`, aucun
     fichier `-wal`/`-shm`, `user_version` égal à `SCHEMA_VERSION` ;
   - toutes les tables et vues `v_*` lues par l'app présentes et lisibles,
     aucune ligne orpheline, au moins une partie dans chacune des 19 ligues ;
   - taille sous 190 Mo (avertissement dès 170 Mo), et au moins 98 % des
     parties, et des parties avec stats in-game, de la release précédente
     (garde contre une ingestion partielle).
5. Release `data-YYYYMMDD` (`-2`, `-3`… si le tag existe déjà) avec trois
   assets :
   - `lol.sqlite.zst` : la base compressée en zstd niveau 19 (environ 19 Mo
     pour 68 Mo) ;
   - `ingame.jsonl.zst` : les résumés in-game, une ligne par partie, relus
     par l'exécution suivante ;
   - `manifest.json` : version du schéma, date, commit, taille et sha256 de
     la base et des assets, nombre de parties (dont avec stats in-game), de
     ligues, de tournois, de joueurs et d'équipes, version Data Dragon.
6. Supprime les releases `data-*` au-delà des 4 plus récentes (tags compris),
   séparément pour les releases publiées et les prereleases.

Avant de publier, le workflow pose la question de référence (« résultats de
Chovy à tous les Worlds », `bun run eval --only=worlds-chovy --deterministic
--strict`) à l'agent sur la nouvelle base ; un échec arrête tout. Sur `main`,
une release réussie redéploie ensuite la production (voir « Déploiement
automatique »).

Lancé depuis une autre branche que `main`, le workflow publie une
**prerelease**, que `data:pull` ignore sauf si `DATA_RELEASE` l'épingle. Le
cron ne tourne que sur la branche par défaut.

### Téléchargement : `bun run data:pull`

Le script `build` lance `bun run data:pull && next build`. `data:pull` :

- choisit la release : celle de `DATA_RELEASE` (ou `--release=`), sinon la
  release publiée `data-*` à la date de publication la plus récente dont le
  manifeste a le `SCHEMA_VERSION` du code (`published_at` ; le `created_at`
  de GitHub est la date du commit tagué, identique pour deux releases faites
  sur le même commit). Une release d'un autre schéma est ignorée, donc
  publier une base v4 ne casse pas les builds de code v3 ;
- télécharge l'asset, vérifie sa taille et son sha256, le décompresse,
  vérifie le sha256 et la taille de la base, son `user_version`, son mode de
  journal et `quick_check`, puis remplace `data/lol.sqlite` d'un coup
  (renommage). Au moindre écart il s'arrête avec un message et le code 1, et
  laisse l'éventuelle base existante intacte ;
- sur Vercel (`VERCEL=1`), saute le téléchargement si la base locale a déjà
  le sha256 de la release ;
- hors Vercel, garde une base locale au bon schéma sans rien télécharger (elle
  peut venir d'un `data:build` plus récent). `--force` la remplace. Sans token,
  une base locale utilisable est aussi gardée avec `VERCEL=1` (cas d'un
  `vercel build` local) ; sans base utilisable et sans token, il s'arrête et
  propose `data:build`.

Le token n'est lu que depuis `DATA_GITHUB_TOKEN`, n'est jamais affiché, et
n'est pas envoyé au stockage vers lequel GitHub redirige le téléchargement.

`next.config.ts` garde un garde-fou : un build Vercel sans
`data/lol.sqlite` échoue au lieu de déployer un agent sans données.

### Déploiement automatique

`.github/workflows/deploy.yml` déploie la pointe de `main` en production avec
le CLI Vercel (`vercel deploy --prod`, build sur Vercel) :

- après le succès de `PR CI` sur le SHA courant de `main` (sauf un push qui ne touche que `*.md` ou
  `docs/`) ;
- à la fin d'un « Data release » réussi sur `main` (cron ou lancement à la
  main) : le job `deploy` dépend du job `release`, donc un contrôle, une
  publication ou un nettoyage en échec ne déploie rien ;
- à la demande : **Actions** → **Deploy** → **Run workflow** sur `main`.

Le job lance `lint`, `typecheck` et `test`, déploie, puis vérifie :

- la release lue par le build, d'après la ligne `data:pull: latest release …`
  du log. Après un « Data release », ce doit être le tag qui vient d'être
  publié, sinon le job échoue (c'est le cas si `DATA_RELEASE` est épinglée
  sur Vercel) ;
- que `https://farsight.enzoneault.dev/` répond 200.

La question Chovy n'est pas posée au domaine : `POST /api/ask` est derrière
BotID, qui refuse un client sans navigateur. Elle est posée à la nouvelle base
avant la publication.

Rien ne garde une ancienne base : `data/` n'est ni envoyé (`.vercelignore`)
ni dans le cache de build de Vercel (`node_modules`, `.next/cache`), et
`data:pull` relit la liste des releases à chaque build puis compare le sha256.

Un seul déploiement à la fois (groupe `deploy-production`). Les déploiements
de preview restent manuels (`vercel deploy`).

### Revenir à une base précédente

Définir `DATA_RELEASE=data-YYYYMMDD` sur Vercel, puis redéployer. Supprimer
la variable pour revenir à la plus récente.

### Sans release (dépannage)

```bash
bun run data:fetch            # met à jour le cache brut si besoin
bun run data:build            # data/lol.sqlite
vercel build --prod           # sans DATA_GITHUB_TOKEN, data:pull garde la base locale
vercel deploy --prebuilt --prod
```

## Données in-game (JSON Riot, R2)

Les stats in-game viennent des JSON Riot que Leaguepedia héberge (pages
`V4 data:…`/`V5 data:…` et leur `/Timeline`, listées par la table Cargo
`PostgameJsonMetadata`) : environ 28 300 parties du périmètre, **aucune en
LPL**. L'ingestion calcule les stats agrégées (golds, CS et XP à 10/15/20 min
et écarts avec l'adversaire direct, kills avant 10 min, solo kills, first
blood, multi-kills, wards, plaques, premiers objectifs) et les met en SQL. Le
JSON brut de chaque partie (stats + timeline minute par minute) reste hors
SQL : un objet gzip par partie, `games/<RiotPlatformGameId>.json.gz`, dans le
cache local `data/raw/riot` et dans un bucket R2.

Volumes : 28 342 objets, de 15 à 120 Ko chacun (1,2 Go au total), dans l'offre gratuite de R2 (10 Go, 1 M d'écritures et 10 M de
lectures par mois).

### Premier rattrapage (local, une fois)

```bash
LEAGUEPEDIA_DELAY_MS=2000 nohup caffeinate -i bun run data:fetch > data/catchup.log 2>&1 &
```

Environ 8 h (7 h 55 le 13/11/2026 : 14 150 requêtes, 2 parties par requête,
une requête toutes les 2 s, aucune page manquante). Reprenable :
relancer la même commande reprend là où le processus s'est arrêté. Ensuite
`bun run data:build`, puis, une fois R2 configuré, `bun run data:sync` pour
envoyer le cache sur R2 (n'envoie que les objets absents du bucket).

### Configurer R2 (à faire par Enzo)

1. Cloudflare → **R2 Object Storage** → activer R2 (offre gratuite ; Cloudflare
   demande un moyen de paiement, rien n'est facturé sous les quotas gratuits).
2. **Create bucket** : nom `lolesport-games`, emplacement automatique (ou
   juridiction EU, voir `R2_ENDPOINT`), classe Standard. Laisser l'accès
   public désactivé.
3. **Manage R2 API Tokens** → **Create API token** : permission
   **Object Read & Write**, limitée au bucket `lolesport-games`, sans
   expiration ou un an au plus. Noter l'*Access Key ID* et le *Secret Access
   Key* (affiché une seule fois) et l'*Account ID*.
4. En local, dans `.env` (jamais commité) : `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (et `R2_ENDPOINT` seulement pour
   la juridiction EU). Vérifier avec `bun run data:sync --dry-run`, puis
   lancer `bun run data:sync`.
5. GitHub → dépôt → **Settings** → **Secrets and variables** → **Actions** :
   les quatre mêmes secrets (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`). Sans eux le workflow marche, mais n'envoie pas les
   nouvelles parties sur R2.
6. Vercel : voir « Timeline d'une partie » ci-dessous. Le token d'écriture de
   l'ingestion ne va jamais sur Vercel.

### Timeline d'une partie (lecture R2 au runtime)

L'outil `game_timeline` (« timeline de T1 vs Gen.G finale Worlds 2024
game 3 ») trouve la partie dans la base (équipes, compétition, saison,
phase et numéro de game : colonnes `tab`, `match_n`, `game_n` de `v_games`,
schéma v5), puis la fonction lit le JSON Riot de cette seule partie sur R2,
côté serveur, et n'envoie au navigateur que la timeline calculée (écart d'or
par minute, événements clés). Définitions : `src/lib/sources/timeline.ts`.

- Accès : un token R2 à part, **Object Read only**, limité au bucket, lu
  uniquement depuis `R2_READ_ACCESS_KEY_ID` / `R2_READ_SECRET_ACCESS_KEY`.
  L'app ne lit jamais `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (écriture,
  ingestion seulement), donc une clé d'écriture ne peut pas servir au runtime.
- Cache : Vercel Runtime Cache (régional, partagé entre instances, conservé
  entre déploiements), clé `timeline:v<TIMELINE_FORMAT>:<partie>`, 30 jours ;
  une partie absente du bucket est mémorisée 1 h. Hors Vercel, cache en
  mémoire. Une panne du cache ne coûte qu'une lecture R2.
- Sans variables `R2_READ_*` : en local, lecture du cache `data/raw/riot`
  s'il existe ; sur Vercel, la réponse donne le résultat de la partie et dit
  que la timeline est indisponible, sans chiffre inventé.
- Coût : une lecture R2 (15 à 120 Ko) par partie et par région tous les
  30 jours au plus, très loin des 10 M de lectures gratuites par mois.

Créer le token (à faire par Enzo) : Cloudflare → **R2 Object Storage** →
**Manage R2 API Tokens** → **Create API token** → nom
`lolesport-vercel-read`, permission **Object Read only**, **Apply to specific
buckets only** → `lolesport-games`, TTL un an au plus. Noter l'*Access Key ID*
et le *Secret Access Key* (affiché une seule fois).

### Première release v4

Le workflow restaure les résumés in-game de la release précédente ; une
release v3 n'en a pas. Deux façons d'amorcer :

- R2 configuré et `bun run data:sync` fait : le premier workflow v4 lit les
  28 342 parties sur R2 au lieu du wiki (5,9 min mesurées en local le
  14/11/2026, 16 lectures en parallèle, aucune requête au wiki) ;
- sans R2 : le workflow télécharge depuis le wiki 90 min par exécution
  (environ 3 600 parties), donc 8 exécutions environ avant d'être complet ;
  chaque release intermédiaire est utilisable, avec une couverture partielle.

### Première release v5

Le schéma v5 ajoute `games.tab`, `match_n`, `game_n` et
`game_riot.side_swapped` (reconstruits depuis le cache brut, sans nouvelle
requête au wiki). `data:pull` ne prend que les releases du schéma du code :
tant qu'aucune release v5 n'existe, un build v5 échoue. Une fois le code sur
`main`, lancer **Data release** une fois avant le premier déploiement v5. Le
workflow ne restaure pas les résumés in-game d'une release v4 : avec les
secrets `R2_*` il relit les 28 342 parties sur R2 (environ 6 min).

## Réglages du projet Vercel

Versionnés dans `vercel.json`, rien à saisir dans le dashboard :

- Framework `nextjs`, installation `bun install --frozen-lockfile`, build
  `bun run build` (lance `data:pull`, ne pas la remplacer par `next build`).
  Node 24.x vient de `engines.node` dans `package.json`.
- Région des fonctions `cdg1` (Paris). Le plan Hobby n'en autorise qu'une.
- `git.deploymentEnabled: false` : même si le dépôt est connecté au projet,
  l'intégration Git ne déploie rien. La production est déployée par le
  workflow « Deploy » avec le CLI, les previews à la main (`vercel deploy`).
- `/api/ask` : `maxDuration = 90` (dans la route). Au pire cinq appels LLM de
  15 s ; le défaut de Vercel est 300 s.

`.vercelignore` : le CLI ne lit pas `.gitignore`. Sans ce fichier,
`vercel deploy` enverrait `.env` et `data/` (cache brut compris).

### Variables d'environnement

| Variable | Rôle | Secret | Utilisée au | Environnements |
|---|---|---|---|---|
| `DATA_GITHUB_TOKEN` | télécharge la release de données (`data:pull`) | oui, Sensitive | build | Production, Preview |
| `OPENROUTER_API_KEY` | clé OpenRouter dédiée et plafonnée ; absente, l'agent reste déterministe | oui, Sensitive | runtime | Production (Preview : voir plus bas) |
| `OPENROUTER_MODEL` | modèle (défaut `anthropic/claude-haiku-5.5`) | non | runtime | facultatif |
| `DATA_RELEASE` | épingle une release `data-*` (retour arrière) | non | build | facultatif |
| `DATA_REPO`, `DATA_GITHUB_API` | dépôt et API des releases (défauts corrects) | non | build | ne pas définir |
| `DATABASE_PATH` | chemin de la base | non | runtime | **ne pas définir** sur Vercel |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | compte et bucket R2 des JSON Riot (timeline d'une partie) | non | runtime | Production, Preview |
| `R2_READ_ACCESS_KEY_ID`, `R2_READ_SECRET_ACCESS_KEY` | token R2 **Object Read only**, bucket `lolesport-games` seulement | oui, Sensitive | runtime | Production, Preview |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | clés du projet Langfuse (traçage des questions) ; sans les trois variables `LANGFUSE_*` obligatoires, rien n'est tracé | secrète : oui, Sensitive ; publique : non | runtime | Production |
| `LANGFUSE_BASE_URL` | région du projet Langfuse : `https://cloud.langfuse.com` (UE) | non | runtime | Production |
| `LANGFUSE_SAMPLE_RATE` | part des questions tracées, de 0 à 1 (défaut 1) | non | runtime | facultatif |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `LEAGUEPEDIA_*`, `RIOT_GAMES_PER_REQUEST` | ingestion uniquement (local, workflow) ; `R2_ENDPOINT` seulement pour la juridiction EU | — | — | ne pas définir |

`VERCEL`, `VERCEL_GIT_REPO_OWNER` et `VERCEL_GIT_REPO_SLUG` sont fournies par
Vercel. Sans intégration Git, les deux dernières sont vides et `data:pull` lit
`AzaWoodyy/farsight`.

Preview : sans `OPENROUTER_API_KEY` en Preview, les déploiements de preview
répondent en mode déterministe et ne consomment pas de crédit. L'y ajouter
seulement pour tester le LLM avant la production.

## À faire à la main

### 0. Base de données : token, variable Vercel, première release

1. **Token GitHub** : [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (*Fine-grained token*) :
   - nom `lolesport-vercel-data`, propriétaire `AzaWoodyy` ;
   - expiration : un an au plus, noter la date de renouvellement ;
   - **Repository access** → *Only select repositories* →
     `AzaWoodyy/farsight`, et rien d'autre ;
   - **Permissions** → *Repository permissions* → **Contents : Read-only**
     (*Metadata : Read-only* s'ajoute tout seul). Aucune autre permission.
2. **Vercel** : projet → **Settings** → **Environment Variables** → ajouter
   `DATA_GITHUB_TOKEN` avec ce token, environnements *Production* et
   *Preview*, case *Sensitive* cochée. Ne le mettre ni dans le dépôt, ni dans
   `.env` commité, ni dans un ticket.
3. **Première release** : une fois le workflow sur `main`, **Actions** →
   **Data release** → **Run workflow** sur `main`. Vérifier la release
   `data-YYYYMMDD` et son `manifest.json`. Le workflow utilise le
   `GITHUB_TOKEN` fourni par Actions (permission `contents: write` déclarée
   dans le fichier), aucun secret à créer.
4. **Vérifier** : `vercel deploy` (preview). Le log de build doit afficher
   `data:pull: installed … from data-YYYYMMDD`.

Pour tester `data:pull` en local : `DATA_GITHUB_TOKEN=$(gh auth token) bun run data:pull --force`
(le token reste dans la commande, pas dans un fichier).

### 0 bis. Secrets du workflow « Deploy »

GitHub → dépôt → **Settings** → **Secrets and variables** → **Actions** :

| Secret | Valeur |
|---|---|
| `VERCEL_TOKEN` | token créé sur [vercel.com/account/tokens](https://vercel.com/account/tokens), nom `lolesport-github-deploy`, expiration un an au plus |
| `VERCEL_ORG_ID` | `orgId` de `.vercel/project.json` (après `vercel link`) |
| `VERCEL_PROJECT_ID` | `projectId` du même fichier |

Sur le plan Hobby, un token donne accès à tout le compte, portfolio compris :
il ne va que dans ce secret. `DATA_GITHUB_TOKEN` reste sur Vercel, le build
s'y fait.

### 1. Règle de rate limit du firewall Vercel

Projet → **Firewall** → **Configure** → **New Rule** :

| Champ | Valeur |
|---|---|
| Nom | `ask rate limit` |
| If | `Request Path` `equals` `/api/ask` |
| And | `Method` `equals` `POST` |
| Then | `Rate Limit` |
| Algorithme | `Fixed Window` |
| Fenêtre | `600` secondes (10 min) |
| Requêtes | `30` |
| Clé | `IP` |
| Action au dépassement | `Too Many Requests` (429) |

Puis **Save** et **Review Changes** → **Publish**. Le plan Hobby autorise
jusqu'à 3 règles personnalisées et inclut 1 M de requêtes autorisées par mois
pour le rate limiting.

La même règle en CLI, pour référence :

```bash
vercel firewall rules add "ask rate limit" \
  --condition '{"type":"path","op":"eq","value":"/api/ask"}' \
  --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit \
  --rate-limit-algo fixed_window \
  --rate-limit-window 600 \
  --rate-limit-requests 30 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit
```

Pour vérifier : 31 questions de suite depuis la même IP, la 31ᵉ doit recevoir
un 429. Le chat affiche alors une erreur.

Deuxième règle, contre un usage soutenu sur la durée (même formulaire) :
nom `ask hourly cap`, mêmes conditions, `Fixed Window`, `3600` secondes,
`40` requêtes, clé `IP`, action `Too Many Requests`. Elle laisse une règle
personnalisée libre sur les 3 du plan Hobby.

### 2. BotID

Le mode Basic n'a rien à activer : il marche dès le premier déploiement.
Laisser **Deep Analysis** désactivé (option payante). Les verdicts
apparaissent dans **Firewall** → trafic du projet.

### 3. Clé OpenRouter dédiée et plafond de crédit

Sur [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) :

1. **Create Key**, nom `lolesport-prod`, réservée à ce projet.
2. **Credit limit** : le budget prévu (20 à 50 €, saisi en dollars). Une fois
   le plafond atteint, OpenRouter répond 403 « Key limit exceeded » et l'agent
   bascule en mode déterministe.
3. Copier la clé dans `OPENROUTER_API_KEY` (Vercel, Production), jamais dans le
   dépôt.

Pour vérifier : le tableau de bord de la clé montre la consommation, et une
clé plafonnée à 0 $ doit produire la note « quota épuisé » dans la réponse.

### 4. Traçage Langfuse

Projet Langfuse Cloud (plan Hobby : 50 000 unités par mois, 30 jours de
rétention, 2 utilisateurs), région UE. Dans Vercel, environnement Production :
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (Sensitive) et
`LANGFUSE_BASE_URL=https://cloud.langfuse.com`, puis redéployer. Ne pas les
mettre en Preview : les essais y resteraient hors des traces de production.

Ce qui part chez Langfuse, une trace `answer-question` par question :

- la question (500 caractères au plus), la réponse en une phrase, et une
  observation par étape : `understand-question` (entités, mentions non
  résolues, mots non consommés, confiance), `build-query` (route, outil, SQL),
  `execute-query` (lignes, tentatives, corrections), `format-answer` ;
- sous l'étape concernée, chaque appel LLM (`extract-entities`, `pick-tool`,
  `generate-sql`, `repair-sql`, `write-summary`) en une génération : messages,
  modèle, jetons et coût ;
- des tags pour filtrer : `empty-result`, `error`, `out-of-scope`,
  `missing-data`, `no-query`, `sql-fallback`, `self-corrected`, `llm`,
  `llm-error`, `llm-quota`, `low-confidence`, `unresolved-mention`,
  `ambiguous-alias` ;
- le pouce haut ou bas de l'interface, en score booléen `response_rating`
  (`POST /api/feedback`).

Confidentialité : ni IP, ni cookie, ni en-tête, ni empreinte du navigateur.
Le seul identifiant est celui de la conversation : un UUID aléatoire, gardé en
mémoire de la page, qui ne permet pas de reconnaître un visiteur d'une visite
à l'autre. Les e-mails, adresses IP et numéros de téléphone tapés dans une
question sont masqués avant l'envoi. Les traces sont lisibles 30 jours.

Unités : 6 par question sans LLM (la trace et 5 observations), 1 de plus par
appel LLM, 1 par avis. Avec la clé OpenRouter, une question courante en
consomme 7 (la phrase de synthèse passe par le LLM) et le pire cas 12, soit
environ 7 000 questions par mois, 4 000 au pire. Au-delà, baisser
`LANGFUSE_SAMPLE_RATE` (0,5 trace une question sur deux ; une question non
tracée n'affiche pas les pouces).

Le coût est celui qu'OpenRouter facture : il figure sur chaque génération et,
en somme, dans les métadonnées de la trace (`llmCostUsd`).

#### Comment lire une question dans Langfuse

Chaque conversation du site est une **session** (un UUID tiré au hasard par
le navigateur à la première question, changé au rechargement de la page ou
par « nouvelle conversation »), et chaque question une trace nommée par le
début de la question.

1. **Suivre une conversation** : menu **Sessions**, filtre **Environment** =
   `production` (ou `development` en local). Une ligne par conversation, la
   plus récente en haut ; cliquer l'identifiant. La vue **Messages** déroule
   les questions dans l'ordre, avec pour chacune la question, la réponse et
   les messages échangés avec le LLM.
2. **Voir tous les appels d'une question** : dans la session, cliquer le
   titre de la question pour ouvrir sa trace. L'onglet **Tree** montre
   `answer-question`, ses quatre étapes et, sous chacune, ses appels LLM avec
   leur coût ; **Timeline** les montre dans le temps. Cliquer une observation
   affiche son entrée, sa sortie et, dans **Metadata**, le journal de l'étape.
   Le lien **session** en haut de la trace ramène à la conversation.
3. **Lister les questions** : menu **Tracing**. Cette page liste les
   observations, pas les questions : dans **Filters**, section **Is Root
   Observation**, ne garder que **True** pour avoir une ligne par question
   (à enregistrer dans **My Views**).
4. **Trouver les échecs** : avec ce filtre, section **Tags**, cocher
   `empty-result`, `error`, `no-query`, `out-of-scope`… ou filtrer **Level**
   sur `ERROR`. Les avis négatifs : menu **Scores**, `response_rating` =
   `False`.
5. **Retrouver une question précise** : chercher son texte dans la barre de
   recherche. Chaque observation porte la question en métadonnée
   (`question`).

L'envoi se fait après la réponse (`after`), borné à 3 s : Langfuse lent ou en
panne ne change rien pour le visiteur. BotID protège aussi `/api/feedback` ;
pour le limiter par IP, la troisième règle personnalisée du firewall est libre.

### 5. Web Analytics

Projet → **Analytics** → **Enable** (inclus dans le plan Hobby, dont le quota
d'événements est partagé avec le portfolio), puis redéployer : les routes `/_vercel/insights/*`
n'existent qu'à partir du déploiement suivant. Tant que ce n'est pas fait, le
script répond 404 et rien n'est compté, sans autre effet pour le visiteur.

`src/app/analytics.tsx` monte le composant de `@vercel/analytics`, en production
seulement. Le script est servi par le même domaine (la CSP reste en `'self'`),
injecté en `defer` après l'hydratation. Il ne pose aucun cookie et n'envoie que
des pages vues : l'URL réduite au chemin (`beforeSend` retire la query string et
le hash), le référent et l'appareil. Aucun événement personnalisé, donc jamais
le texte d'une question, qui ne passe que dans le corps de `POST /api/ask`.
Speed Insights n'est pas installé, comme sur le portfolio.

## Contrôles avant déploiement

`PR CI` exécute les contrôles sur les PR et main. Deploy ne consomme automatiquement que les runs réussis issus d’un push du dépôt sur main, et ignore un SHA dépassé. Les données de CI sont épinglées dans `ci/data.json` ; leur release est exclue de la rétention. Voir `ci/README.md`. Le CLI Vercel est verrouillé dans le lockfile.

`FEEDBACK_SECRET` (au moins 32 caractères aléatoires) signe les avis ; sans lui les contrôles sont masqués et la route refuse les avis. `LANGFUSE_TRACING_ENVIRONMENT` nomme l’environnement de traçage. Ces valeurs restent dans `.env` localement et dans les variables Vercel en déploiement. Les compteurs IP du code sont par instance : conserver les règles du pare-feu. Aucun changement de dashboard n’est effectué par la MR de nettoyage.
