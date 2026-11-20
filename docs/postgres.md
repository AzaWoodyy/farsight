# Postgres (Neon) : essai

Sur cette branche, l'app lit Postgres à `DATABASE_URL` au lieu du fichier SQLite embarqué. La production (`main`) garde
le fichier et la Data release tant que l'essai n'est pas validé. Ce document décrit ce qui change, comment brancher
Neon, et comment refaire les mesures.

## Ce qui change

- **Accès** : tout le code passe par l'interface asynchrone `Db` (`src/lib/db/index.ts`). Le schéma est lu une fois par
  connexion (une requête sur `information_schema`), les alias d'une question en une seule requête.
- **Drivers** (`src/lib/db/postgres.ts`) : le driver serverless de Neon (pool WebSocket) pour un hôte `*.neon.tech`,
  node-postgres (TCP) ailleurs (local, CI, chargement). `DATABASE_DRIVER=neon|pg` force le choix. COUNT/SUM (bigint) et
  AVG (numeric) sont lus comme des nombres, comme SQLite les donnait.
- **Schéma** : migrations versionnées en SQL (`db/migrations/NNNN_nom.sql`), appliquées dans l'ordre, chacune dans sa
  transaction, avec une somme de contrôle dans `schema_migrations` (`scripts/db/migrations.ts`, sans dépendance).
  L'app refuse une base dont la dernière migration n'est pas `PG_MIGRATION` (`src/lib/db/schema.ts`). Les colonnes
  texte sont en `COLLATE "C"` : mêmes tris et comparaisons qu'en SQLite, quelle que soit la locale du serveur.
- **Chargement** (`bun run db:load`, `scripts/db/load.ts`) : les lignes viennent de `scripts/data/derive.ts`, le même
  calcul que le fichier SQLite (`data:build` produit un fichier identique à celui de `main`). Elles sont copiées
  (`COPY`) dans un schéma neuf `farsight_next` construit par toutes les migrations, analysées, ouvertes aux rôles de
  l'app, puis basculées par deux renommages dans une transaction : l'app voit l'ancienne base jusqu'au commit, puis la
  nouvelle. `bun run db:migrate` applique une migration d'index ou de vue en place.
- **Rôles** (`db/roles.sql`) : le propriétaire charge ; `farsight_app` (celui de l'app) est en lecture seule, avec un
  `statement_timeout` de 10 s ; `farsight_sql` ne lit que les vues `v_*`.
- **SQL généré** (`src/lib/db/generated-query.ts`) : transaction `READ ONLY`, `SET LOCAL ROLE farsight_sql`,
  `statement_timeout` de 4 s, au plus 200 lignes et 2 Mo, coupés côté serveur. C'est la base qui refuse une table de
  base, une écriture ou une fonction serveur, y compris ce que la passe statique du garde-fou ne voit pas. Le
  processus enfant SQLite disparaît. Limite connue : la session reste celle de `farsight_app`, qu'une fonction
  exécutant du SQL dynamique pourrait rétablir ; la passe statique refuse ces fonctions et les noms échappés (`U&"…"`).
  Durcissement possible si l'essai est retenu : une connexion dédiée, ouverte directement comme `farsight_sql`.
- **Runtime** : plus de base dans les fonctions (35 à 39 Mo au lieu d'environ 175 Mo), région `fra1` (Francfort, comme
  la région Neon `aws-eu-central-1`). `next.config.ts` lit les chiffres de la page « comment ça marche » dans Postgres
  au démarrage du build : `DATABASE_URL` doit aussi être défini pour le build.
- **CI** : un Postgres 17 en conteneur de service, chargé depuis le snapshot épinglé (`ci/data.json` : `ci/raw.tar.zst`
  et `ingame.jsonl.zst` de la release épinglée) par `db:load`. Mêmes données à chaque run, sans compte externe.
- **Mise à jour** : `.github/workflows/postgres-update.yml`, en déclenchement manuel seulement (le cron est commenté) :
  la même ingestion que la Data release, puis `db:load` dans Neon et la question de référence sur Neon.

### Écarts avec SQLite, mesurés sur les 307 questions de l'éval

Éval déterministe identique : 303/303 sur Postgres comme sur SQLite. 244 réponses sur 307 sont identiques octet pour
octet ; les 63 autres diffèrent seulement par :

- l'ordre des ex aequo (une suggestion de question sur un coéquipier qui a autant de parties qu'un autre) ;
- l'ordre des pages sources agrégées (`json_agg(DISTINCT …)` trie, SQLite gardait l'ordre de lecture) ;
- 10 arrondis à la demi-unité exacte : Postgres calcule les moyennes en décimal exact (6,145 → 6,15), SQLite en
  flottant (6,14).

## Mesures (Postgres 17 local, Docker, MacBook)

| | SQLite (main) | Postgres local |
|---|---|---|
| Latence par question, p50 | 14 ms | 26 ms |
| p95 | 73 ms | 120 ms |
| p99 | 1 282 ms | 198 ms |
| max | 2 422 ms | 201 ms |
| Taille de la base | 169 Mo (fichier) | 569 Mo (tables et index) |
| Chargement complet depuis le cache brut | 11,6 s (`data:build`) | 17,6 s (`db:load` : dérivation 7,8 s, COPY 8,2 s, ANALYZE 1,6 s) |
| Taille de `/api/ask` | ≈ 175 Mo | 35,5 Mo |

Latence : règles seules (sans LLM), médiane de deux passages après un passage d'échauffement, puis percentiles sur les
307 questions (`scripts/bench/questions.ts`).

**Stockage sur le plan gratuit** : la bascule garde deux copies le temps du chargement (≈ 1,1 Go), plus que le 1 Go du
plan gratuit. `DATABASE_SIZE_LIMIT_MB=1024` fait alors charger en place (`--in-place`) : le schéma est supprimé, puis
rechargé sous le même nom ; l'app n'a pas de données pendant le chargement (quelques dizaines de secondes). Pistes si
l'essai est retenu : ranger objets et draft en tableaux (environ −250 Mo, ce qui rend la bascule possible), ou le plan
payant.

## Brancher Neon (à faire par Enzo)

Aucune URL ni clé n'est dans le dépôt. Les chaînes de connexion ne vont que dans `.env` (local), les secrets GitHub et
les variables Vercel.

1. **Compte et projet** : créer un compte gratuit sur neon.com, puis un projet **Postgres 17** dans la région
   **AWS Europe Central 1 (Frankfurt)**. Base par défaut `neondb`, rôle propriétaire `neondb_owner`.
2. **Chaînes de connexion** (bouton *Connect* du projet) : copier
   - la chaîne **directe** (sans `-pooler` dans l'hôte) du propriétaire → `DATABASE_OWNER_URL` ;
   - plus tard, la chaîne **poolée** (avec `-pooler`) où l'on remplace l'utilisateur et le mot de passe par
     `farsight_app` → `DATABASE_URL`.
3. **Rôles** (une fois), avec un mot de passe généré pour l'app (au moins 16 caractères aléatoires : Neon refuse un
   mot de passe faible) :

   ```sh
   psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -v app_password="'<mot de passe généré>'" -f db/roles.sql
   ```

4. **Premier chargement** (depuis le Mac, qui a le cache brut complet dans `data/raw`, ou après
   `bun scripts/ci/data.ts --raw` pour le snapshot épinglé) :

   ```sh
   DATABASE_OWNER_URL=… DATABASE_SIZE_LIMIT_MB=1024 bun run db:load
   ```

   La sortie donne la durée (dérivation, COPY, ANALYZE) et la taille de la base.
5. **Vérifier en lecture seule** :

   ```sh
   DATABASE_URL=… bun run eval --deterministic --strict --exclude-tags=timeline
   ```

6. **Mesurer la latence** depuis le Mac (Paris → Francfort : majorant de ce que verra une fonction `fra1`) :

   ```sh
   DATABASE_URL=… bun scripts/bench/questions.ts --out=bench-neon.json --passes=3
   bun scripts/bench/questions.ts --compare=bench-sqlite.json,bench-neon.json
   ```

   Le réveil : relancer après plus de 5 minutes sans requête (Neon s'endort, réglage imposé en gratuit) ; `first` dans
   la sortie est la première question, celle qui réveille la base. La référence SQLite se mesure en copiant ce script
   sur un checkout de `main`.
7. **Preview Vercel** (après accord) : dans le projet Vercel, ajouter `DATABASE_URL` (chaîne poolée de `farsight_app`,
   Sensitive) pour **Preview** seulement, puis déployer la branche à la main (`vercel deploy`, sans `--prod`). La
   production n'est pas touchée tant que la variable n'existe pas en Production et que la PR n'est pas mergée.
8. **Mise à jour automatique** (après accord) : secrets GitHub `NEON_DATABASE_OWNER_URL` et `NEON_DATABASE_URL`, puis
   **Actions → Postgres update → Run workflow** ; décommenter le `schedule` une fois l'essai validé.

## En local

```sh
docker run -d --name farsight-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_INITDB_ARGS="--locale=C.UTF-8" postgres:17
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE farsight_test"
psql postgres://postgres:postgres@localhost:5432/postgres -v app_password="'local'" -f db/roles.sql
DATABASE_OWNER_URL=postgres://postgres:postgres@localhost:5432/postgres bun run db:load
export DATABASE_URL=postgres://farsight_app:local@localhost:5432/postgres
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/farsight_test
bun run verify
```

## Revenir en arrière

- Données : relancer `db:load` depuis un cache brut plus ancien, ou la restauration à un instant donné de Neon (fenêtre
  d'historique du plan).
- Code : la production reste sur SQLite tant que la PR n'est pas mergée ; après un merge, revenir au commit précédent
  et redéployer remet le fichier embarqué (la Data release continue de publier la base SQLite).
