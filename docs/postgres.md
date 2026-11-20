# Postgres (Neon)

L'app lit Postgres à `DATABASE_URL`, sur Neon en production, depuis le 20/11/2026 (#135). Les données se mettent à jour
chaque jour sans redéploiement. La Data release continue de publier chaque lundi un fichier SQLite versionné des mêmes
lignes. Ce document décrit le fonctionnement, l'exploitation et le passage depuis SQLite.

## Fonctionnement

- **Accès** : tout le code passe par l'interface asynchrone `Db` (`src/lib/db/index.ts`). Le schéma et les index
  d'alias sont lus une fois par connexion et gardés 5 minutes, les alias d'une question en une seule requête.
- **Driver** (`src/lib/db/postgres.ts`) : node-postgres (TCP) partout, y compris sur Vercel. C'est ce que Neon conseille
  sur Fluid compute, avec `attachDatabasePool` et l'hôte poolé (`-pooler`). Le driver serverless de Neon (pool WebSocket)
  reste disponible avec `DATABASE_DRIVER=neon`, pour un runtime sans TCP. COUNT/SUM (bigint) et AVG (numeric) sont lus
  comme des nombres.
- **Schéma** : migrations versionnées en SQL (`db/migrations/NNNN_nom.sql`), appliquées dans l'ordre, chacune dans sa
  transaction, avec une somme de contrôle dans `schema_migrations` (`scripts/db/migrations.ts`). L'app refuse une base
  dont la dernière migration n'est pas `PG_MIGRATION` (`src/lib/db/schema.ts`). Les colonnes texte sont en
  `COLLATE "C"` : mêmes tris et comparaisons qu'en SQLite, quelle que soit la locale du serveur.
- **Chargement** (`bun run db:load`, `scripts/db/load.ts`) : les lignes viennent de `scripts/data/derive.ts`, le même
  calcul que le fichier SQLite de la Data release. Elles sont copiées (`COPY`) dans un schéma neuf `farsight_next`
  construit par toutes les migrations, analysées et ouvertes aux rôles de l'app.
  - Avant la bascule, chaque ligue doit garder au moins ses tournois, parties, lignes de joueurs, parties in-game et
    classements. Sinon, le schéma préparé est supprimé et la base en place ne change pas ; `--allow-shrink` force le
    chargement.
  - La bascule tient en deux renommages dans une transaction : l'app voit l'ancienne base jusqu'au commit, puis la
    nouvelle.
  - `--in-place` (ou `DATABASE_SIZE_LIMIT_MB`, quand le stockage du plan ne tient pas deux copies) recharge sous le même
    nom, après la même comparaison. L'app n'a alors pas de données pendant le chargement.
  - `bun run db:migrate` applique une migration d'index ou de vue en place.
- **Rôles** (`db/roles.sql`) : le propriétaire charge ; `farsight_app`, celui de l'app, est en lecture seule avec un
  `statement_timeout` de 10 s ; `farsight_sql` ne lit que les vues `v_*`.
- **SQL généré** (`src/lib/db/generated-query.ts`, `src/lib/agent/guard.ts`) : transaction `READ ONLY`,
  `SET LOCAL ROLE farsight_sql`, `statement_timeout` de 4 s, au plus 200 lignes et 2 Mo, coupés côté serveur. C'est la
  base qui refuse une table de base, une écriture ou une fonction serveur.
  - La passe statique ne lit que les chaînes `'…'` et les commentaires `--`, terminés par un saut de ligne ou un retour
    chariot, comme Postgres. Elle refuse ce que Postgres lirait autrement (`E'…'`, `$`, commentaires `/* */`, `U&`)
    et les fonctions serveur (`pg_*`, `set_config`, `query_to_xml`…).
  - Limite connue : la session reste celle de `farsight_app`, qu'une fonction exécutant du SQL dynamique pourrait
    rétablir ; la passe statique refuse ces fonctions. Durcissement possible : une connexion dédiée, ouverte directement
    comme `farsight_sql`.
- **Runtime** : aucune base dans les fonctions (`/api/ask` pèse 37 Mo), région `fra1`, la même que Neon
  (`aws-eu-central-1`). `next.config.ts` lit les chiffres de la page « comment ça marche » et la date du sitemap dans
  Postgres au démarrage du build : `DATABASE_URL` doit être défini pour le build.
- **CI** : un Postgres 18 en conteneur de service, chargé par `db:load` depuis le snapshot épinglé (`ci/data.json` :
  `ci/raw.tar.zst` et `ingame.jsonl.zst` de la release épinglée). Mêmes données à chaque run, sans compte externe.

## En production

- **Neon** : projet Postgres 18 en région AWS Europe Central 1 (Francfort), base `neondb`, plan Launch. Le compute est
  toujours allumé (`suspend_timeout_seconds: -1`) et monte de 0,25 à 2 unités : environ 20 $ par mois au repos. Une
  base qui s'endort fait payer environ 1 s à la première question après 5 minutes de calme.
- **Vercel** : `DATABASE_URL` en Production et en Preview, chaîne poolée de `farsight_app` avec
  `sslmode=verify-full`. Une preview lit donc la base de production, en lecture seule. En Preview, Langfuse trace sous
  l'environnement `preview`.
- **GitHub** : `NEON_DATABASE_OWNER_URL` (propriétaire, hôte direct) charge, `NEON_DATABASE_URL` (`farsight_app`)
  vérifie.
- **Mise à jour** (`.github/workflows/postgres-update.yml`) : chaque jour à 05:23 UTC et à la demande, depuis `main`
  seulement. Elle reprend les résumés in-game de la dernière Data release, relit Leaguepedia en entier (environ
  17 minutes), complète le JSON Riot des nouvelles parties (R2 d'abord, puis le wiki, 30 minutes au plus) et Data
  Dragon, lance `db:load` puis pose la question de référence sur Neon. L'app lit les nouvelles données au plus
  5 minutes après le chargement. Elle partage le groupe de concurrence `leaguepedia-ingestion` avec la Data release :
  une seule ingestion à la fois. GitHub coupe un cron après 60 jours sans activité sur un dépôt public : le réactiver
  depuis l'onglet Actions.
- **Deploy** ne dépend plus des données : il déploie après la CI de `main`, ou à la demande.

## Opérations

Les chaînes de connexion ne vont que dans `.env` ou `.env.local` (ignorés par git), les secrets GitHub et les variables
Vercel.

- **Charger à la main** :

  ```sh
  DATABASE_OWNER_URL=… bun run db:load
  ```

- **Vérifier en lecture seule** :

  ```sh
  DATABASE_URL=… bun run eval --deterministic --strict --exclude-tags=timeline
  ```

- **Mesurer la latence** (règles seules, médiane par question et percentiles ; `first` est la première question) :

  ```sh
  DATABASE_URL=… bun scripts/bench/questions.ts --out=bench.json --passes=3
  bun scripts/bench/questions.ts --compare=a.json,b.json
  ```

- **Rebrancher un projet Neon neuf** :
  1. Créer le projet en Postgres 18, région Francfort.
  2. Créer les rôles, avec un mot de passe aléatoire d'au moins 16 caractères :

     ```sh
     psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -v app_password="'…'" -f db/roles.sql
     ```

  3. Lancer `db:load` avec la chaîne directe du propriétaire.
  4. Mettre à jour `DATABASE_URL` sur Vercel et les deux secrets GitHub.

## En local

```sh
docker run -d --name farsight-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_INITDB_ARGS="--locale=C.UTF-8" postgres:18
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE farsight_test"
psql postgres://postgres:postgres@localhost:5432/postgres -v app_password="'local'" -f db/roles.sql
DATABASE_OWNER_URL=postgres://postgres:postgres@localhost:5432/postgres bun run db:load
export DATABASE_URL=postgres://farsight_app:local@localhost:5432/postgres
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/farsight_test
bun run verify
```

## Revenir en arrière

- **Données** : relancer `db:load` depuis un cache brut plus ancien, ou restaurer la base Neon à un instant donné, dans
  la fenêtre d'historique du plan.
- **Code** : revenir avant #135 remet le fichier SQLite embarqué, téléchargé depuis la Data release par `data:pull`.

## Passage depuis SQLite (20/11/2026)

Éval déterministe 303/303 sur SQLite, Postgres et Neon. Sur les 307 questions, 244 réponses sont identiques à celles de
SQLite ; les 63 autres ne diffèrent que par :

- l'ordre des ex aequo (une question de suite sur un coéquipier qui a autant de parties qu'un autre) ;
- l'ordre des pages sources agrégées (`json_agg(DISTINCT …)` trie, SQLite gardait l'ordre de lecture) ;
- 10 arrondis à la demi-unité : Postgres calcule les moyennes en décimal exact (6,145 → 6,15), SQLite en flottant
  (6,14).

| | SQLite | Postgres 18 local | Neon depuis Paris |
|---|---|---|---|
| Latence par question, p50 | 14 ms | 23 ms | 254 ms |
| p95 | 73 ms | 127 ms | 538 ms |
| p99 | 1 282 ms | 208 ms | 650 ms |
| max | 2 422 ms | 212 ms | 715 ms |
| Taille de la base | 169 Mo (fichier) | 577 Mo | 575 Mo |
| Chargement complet | 11,6 s (`data:build`) | 24,6 s | 33,7 à 44 s |
| Taille de `/api/ask` | ≈ 175 Mo | 37 Mo | 37 Mo |

Depuis Paris, chaque requête paie l'aller-retour vers Francfort (une quinzaine par question) : c'est un majorant. En
production, depuis `fra1`, une question est comprise en environ 45 ms et exécutée en environ 20 ms ; la phrase écrite
par le LLM prend environ 1 s.
