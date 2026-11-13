# Déploiement sur Vercel

Projet Vercel séparé (plan Hobby, quotas partagés avec le portfolio), domaine
`lolesport.enzoneault.dev`. Cette page décrit ce que le code fait déjà et les
réglages à faire à la main dans les dashboards Vercel et OpenRouter. Rien de
tout cela n'est automatisé.

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

`data/` n'est pas commité, donc un build Vercel lancé depuis Git n'a pas la
base. `next.config.ts` fait alors échouer le build (`VERCEL=1` sans
`data/lol.sqlite`) au lieu de déployer un agent sans données. Il faut donc
construire en local et envoyer le build :

```bash
bun run data:fetch            # met à jour le cache brut si besoin
bun run data:build            # data/lol.sqlite
vercel build --prod
vercel deploy --prebuilt --prod
```

Le job planifié (ajout des nouvelles parties, reconstruction mensuelle) et la
publication d'un fichier versionné restent à faire.

## Réglages du projet Vercel

- Framework : Next.js. Commande d'installation : `bun install`. Version de
  Node : 24.x.
- Variables d'environnement, en Production uniquement :
  - `OPENROUTER_API_KEY` : la clé dédiée (voir plus bas). Sans elle, l'agent
    reste en mode déterministe.
  - `OPENROUTER_MODEL` : facultatif.

## À faire à la main

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
