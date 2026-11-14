# Déploiement sur Vercel

Projet Vercel séparé (plan Hobby, quotas partagés avec le portfolio), domaine
`lolesport.enzoneault.dev`. Cette page décrit ce que le code fait déjà et les
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
  - Mesuré le 14/11/2026 (schéma v4, 28 327 parties avec stats in-game) :
    base 98,1 Mo, fonction 131,8 Mo.
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

Lancé depuis une autre branche que `main`, le workflow publie une
**prerelease**, que `data:pull` ignore sauf si `DATA_RELEASE` l'épingle. Le
cron ne tourne que sur la branche par défaut.

### Téléchargement : `bun run data:pull`

Le script `build` lance `bun run data:pull && next build`. `data:pull` :

- choisit la release : celle de `DATA_RELEASE` (ou `--release=`), sinon la
  plus récente release publiée `data-*` dont le manifeste a le
  `SCHEMA_VERSION` du code. Une release d'un autre schéma est ignorée, donc
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
6. Vercel : rien pour l'instant, l'app ne lit pas encore le détail par partie.
   Le jour où une route le lira, ajouter les mêmes variables (Production,
   Sensitive), de préférence avec un token **Object Read only**.

### Première release v4

Le workflow restaure les résumés in-game de la release précédente ; une
release v3 n'en a pas. Deux façons d'amorcer :

- R2 configuré et `bun run data:sync` fait : le premier workflow v4 lit les
  28 342 parties sur R2 au lieu du wiki (5,9 min mesurées en local le
  14/11/2026, 16 lectures en parallèle, aucune requête au wiki) ;
- sans R2 : le workflow télécharge depuis le wiki 90 min par exécution
  (environ 3 600 parties), donc 8 exécutions environ avant d'être complet ;
  chaque release intermédiaire est utilisable, avec une couverture partielle.

## Réglages du projet Vercel

Versionnés dans `vercel.json`, rien à saisir dans le dashboard :

- Framework `nextjs`, installation `bun install --frozen-lockfile`, build
  `bun run build` (lance `data:pull`, ne pas la remplacer par `next build`).
  Node 24.x vient de `engines.node` dans `package.json`.
- Région des fonctions `cdg1` (Paris). Le plan Hobby n'en autorise qu'une.
- `git.deploymentEnabled: false` : même si le dépôt est connecté au projet,
  un push ne déploie rien. Les déploiements passent par le CLI
  (`vercel deploy`, puis `vercel deploy --prod`). Supprimer la clé le jour où
  les déploiements depuis Git sont voulus.
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
| `R2_*`, `LEAGUEPEDIA_*`, `RIOT_GAMES_PER_REQUEST` | ingestion uniquement (local, workflow) | — | — | ne pas définir |

`VERCEL`, `VERCEL_GIT_REPO_OWNER` et `VERCEL_GIT_REPO_SLUG` sont fournies par
Vercel. Sans intégration Git, les deux dernières sont vides et `data:pull` lit
`AzaWoodyy/lol-esports-agent`.

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
     `AzaWoodyy/lol-esports-agent`, et rien d'autre ;
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
| Requêtes | `15` |
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
  --rate-limit-requests 15 \
  --rate-limit-keys ip \
  --rate-limit-action rate_limit
```

Pour vérifier : 16 questions de suite depuis la même IP, la 16ᵉ doit recevoir
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
