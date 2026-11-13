# Déploiement sur Vercel

Projet Vercel séparé (plan Hobby, quotas partagés avec le portfolio), domaine
`lolesport.enzoneault.dev`. Cette page décrit ce que le code fait déjà et les
réglages à faire à la main dans les dashboards GitHub, Vercel et OpenRouter.

## Ce que contient le déploiement

- **Fonction `/api/ask`** (Node 24, `engines.node` dans `package.json`) : la
  base `data/lol.sqlite` est ajoutée au bundle par `outputFileTracingIncludes`
  (`next.config.ts`), puis ouverte en lecture seule (`src/lib/db/index.ts`).
  - Taille mesurée sur le build local : base 67,8 Mo, bundle d'environ 101 Mo
    au total (fichiers tracés de la route et du serveur Next). La limite de
    Vercel est de 250 Mo décompressés.
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

1. `bun run data:fetch` : ingestion complète depuis Leaguepedia (environ 180
   requêtes Cargo, une à la fois, 3 s d'écart, User-Agent explicite, backoff),
   puis Data Dragon. Compter une dizaine de minutes.
2. `bun run data:build` : `data/lol.sqlite`, fini par
   `journal_mode=DELETE` et `VACUUM`.
3. `bun run data:package` : contrôles, puis assets de release. Le workflow
   s'arrête sans rien publier si l'un d'eux échoue :
   - `integrity_check`, `foreign_key_check`, mode de journal `delete`, aucun
     fichier `-wal`/`-shm`, `user_version` égal à `SCHEMA_VERSION` ;
   - toutes les tables et vues `v_*` lues par l'app présentes et lisibles,
     aucune ligne orpheline, au moins une partie dans chacune des 19 ligues ;
   - taille sous 200 Mo, et au moins 98 % des parties de la release
     précédente (garde contre une ingestion partielle).
4. Release `data-YYYYMMDD` (`-2`, `-3`… si le tag existe déjà) avec deux
   assets :
   - `lol.sqlite.zst` : la base compressée en zstd niveau 19 (environ 19 Mo
     pour 68 Mo) ;
   - `manifest.json` : version du schéma, date, commit, taille et sha256 de
     la base et de l'asset, nombre de parties, de ligues, de tournois, de
     joueurs et d'équipes, version Data Dragon.

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

## Réglages du projet Vercel

- Framework : Next.js. Commande d'installation : `bun install`. Commande de
  build : celle par défaut (`bun run build`, qui lance `data:pull`) ; ne pas
  la remplacer par `next build`. Version de Node : 24.x.
- Variables d'environnement :
  - `DATA_GITHUB_TOKEN` (Production **et** Preview, type Sensitive) : le
    token en lecture seule décrit plus bas. Sans lui, le build échoue.
  - `DATA_RELEASE` : facultatif, épingle une release (retour arrière).
  - `OPENROUTER_API_KEY` (Production) : la clé dédiée (voir plus bas). Sans
    elle, l'agent reste en mode déterministe.
  - `OPENROUTER_MODEL` : facultatif.

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
4. **Vérifier** : redéployer depuis Git. Le log de build doit afficher
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
