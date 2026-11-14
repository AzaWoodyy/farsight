# Audit performance et CI des PR

14 novembre 2026 — révision auditée : `f166b7a3106874934ac4e5a10ba878731bcae591`, branche `chore/audit-perf-ci`, cible `main`. Audit en lecture seule : ce rapport est la seule modification suivable créée lors de la reprise ; aucun code, workflow, commit, push ou PR. Les variantes SQL sont des expériences sur copies locales, pas des changements proposés comme déjà validés en production.

## Décisions proposées

1. Installer une CI de PR avant les micro-optimisations : un check requis stable, sélection prudente des étapes, lint, typecheck, tests métier, eval déterministe et build. Un seul job GitHub, commandes indépendantes en parallèle avec une limite de deux processus sur le dépôt privé.
2. Réécrire l’agrégation des apparitions d’équipes au premier appel : **34–35 → 12,5–12,6 ms**, environ 22 ms gagnées sans ajouter de cache. Vérifier l’égalité des comptes par équipe avant adoption.
3. Étudier le regroupement des six objets par joueur et partie : prototype complet **98,6 → 77,6 MB**, soit 21 MB / 21 % de moins. Le gain est la taille, pas la vitesse de toutes les requêtes : certaines lectures de la vue deviennent plus lentes.
4. Garder les dictionnaires `Map`, SQLite et les caches utiles. Le pipeline déterministe chaud est déjà à **p50 ≈ 6 ms** ; ni SoA généralisée, ni bit packing, ni nouveau cache de résultats ne sont justifiés.
5. Passer le typecheck séparé à `bun check` après explicitation des types ambiants et validation de compatibilité ; **1,72–1,74 → 0,12 s** pour le contrôle seul. Conserver le contrôle TypeScript de Next dans le build au début.

## Mesures et limites

Les mesures des runs précédents ont été récupérées dans leurs sorties et journaux, sans les relancer. Machine locale macOS arm64 ; Bun **1.4.4**, Node **26.13.0**, Next **16.4.6**, TypeScript installé **5.9.3**. La production cible Node **24** : les résultats Node locaux ne sont pas une mesure de Vercel. MB désigne ici 10⁶ octets. Les timings courts dépendent des caches OS, des imports et de la concurrence de la machine ; pas d’intervalle de confiance calculé.

| Étape actuelle | Résultat local conservé | Interprétation |
|---|---:|---|
| `bun run lint` | 0,75 s premier appel ; 0,28 s ensuite | Oxlint est déjà installé |
| `bun run typecheck` | 3,33 s premier appel ; 0,94 s ensuite | Inclut `next typegen`, puis tsc incrémental |
| tsc 5.9.3 sans incrémental | 1,72–1,74 s | Base comparable pour les nouveaux checkers |
| `next typegen` seul | 0,28 puis 0,17 s | Nécessaire avant le contrôle des routes |
| `bun run test` | 0,18–0,22 s ; 31/31 | Quatre fichiers, ordre normal |
| Tests aléatoires | 3 ou 4 échecs sur six seeds conservées | Dépendances d’ordre, voir diagnostic |
| Eval complète déterministe stricte | 1,34 s | 97/97 questions entièrement réussies ; 52 vérifications ignorées ; 12 questions demandent le LLM |
| Eval `worlds-chovy` seule | 0,15 s | Insuffisante comme seule protection des PR |
| **Construction SQLite `data:build`** | 7,63 puis 6,99 s ; RSS max 3,14 puis 3,37 GB | Le « build 7 s / 3,1 Go » du handoff concerne cette étape |
| **Build Next à froid**, journal antérieur | 6,31 s ; RSS max 1,48 GB | Compilation 2,7 s ; TypeScript 2,1 s ; génération 277 ms |
| Build Next à chaud, reprise | **Non mesuré** | Une seule tentative, timeout 35 s : erreur Turbopack / `Operation not permitted` après 18,08 s, code 1 ; ce n’est pas un timing de build réussi |
| Cold start HTTP, reprise | **Non mesuré** | Une seule tentative, disponibilité bornée à 10 s et requête à 8 s : `listen EPERM 127.0.0.1:3941`, avant tout appel HTTP |
| Cold start HTTP, sorties antérieures retrouvées | Prêt en 0,268–0,278 s ; première question 130–131 ms ; suivantes 18–21 ms ; RSS 162–165 MB | Trois sorties existaient déjà. Processus neuf, caches disque OS chauds, BotID en mode local ; ni cold start disque ni mesure serverless |

La reprise n’a relancé ni le build à froid, ni l’ingestion, ni les benches précédents. Les deux tentatives nouvelles ont échoué sous les restrictions de l’environnement ; conformément à la demande, aucune relance hors sandbox. Le packaging n’a pas de durée exploitable : l’ancien essai `--tag=ci-audit` avait été rejeté, car le préfixe exigé est `data-`.

## 1. Chemins chauds et conception orientée données

### Répartition du coût réel

Ancien bench : **109 questions × 20**, sans OpenRouter, sur la même base. Les mesures instrumentées incluent les coûts de validation et SQL ; elles ne représentent pas un temps de réponse avec LLM.

| Par question chaude | Bun | Node 26 |
|---|---:|---:|
| Compréhension complète, dont `detectMentions` | 0,268 ms | 0,334 ms |
| Lecture du schéma | 0,386 ms | 0,460 ms |
| Routage, avec ses consultations SQL | 0,313 ms | 0,279 ms |
| Pipeline complet moyen | 9,70 ms | 9,24 ms |
| Pipeline p50 / p90 / p99 | 5,93 / 20,45 / 43,09 ms | 6,10 / 20,07 / 38,65 ms |
| SQL à l’intérieur du pipeline | 8,41 ms | 8,08 ms |
| Préparation SQL à l’intérieur du pipeline | 0,688 ms | 0,525 ms |

Le pipeline fait environ 61 préparations et 60 exécutions SQL par question, notamment les `PRAGMA table_info` du schéma. Le SQL représente l’essentiel du coût déterministe ; les petites allocations de `detectMentions` ne sont pas le premier levier. `detectMentions` n’a pas été chronométré isolément : ne pas lui attribuer les 0,27 ms de toute la compréhension.

### `detectMentions`, alias et `routeQuestion`

Dans `src/lib/agent/understand.ts`, les mentions sont des fenêtres de un à quatre tokens. Le code construit `span`, `slice`, `join`, normalise, interroge les alias SQLite et marque les tokens utilisés dans un `Set<number>`. Les joueurs restent indexés par la clé `(alias, player_id)` : **16 627 alias**, 3 891 joueurs, 173 champions, 1 701 équipes. L’index d’alias ne pèse que **0,455 MB** dans SQLite.

Les `Map<string, …>` des équipes et champions font des recherches par chaînes : remplacer cela par un tableau plat impose un scan ou un autre index chaîne → entier. Aucun gain mesuré ; rejet. Le SQL d’alias utilise sa clé primaire et `gp_player` pour compter les apparitions, environ **0,011–0,019 ms par exécution** dans l’ancien bench : charger tous les alias et les objets joueurs dans le heap pour éviter ces recherches n’est pas justifié.

Un bitset pour les tokens utilisés est techniquement possible. Une opération bitwise JS ne couvre que 32 bits ; la question acceptée peut faire 500 caractères, donc davantage de 32 tokens. Il faudrait plusieurs mots `Uint32Array`, ou un autre compromis. Remplacer `Set` et les petits tableaux temporaires peut simplifier une boucle, mais aucun gain indépendant n’a été démontré. Même statut pour SoA, tableaux typés de candidats, indices contenant des flags et capacités inline : pas de contrôle d’allocation sur la pile en TypeScript, risque de complexifier Unicode, ambiguïtés et ordre des mentions pour quelques microsecondes.

`routeQuestion` manipule quelques entités, consulte la couverture et applique les règles prioritaires. Ses **≈ 0,3 ms** ne justifient ni trie d’intentions ni flags empaquetés. Garder la priorité timeline / absence de données / outils typés et le fallback SQL gardé. Les contrôles LPL sans données restent obligatoires.

### Gain simple : agrégation des équipes au cold start

`getIndexes()` calcule aujourd’hui les apparitions avec une jointure `t.id IN (g.blue_team_id, g.red_team_id)`. `EXPLAIN QUERY PLAN` montre un parcours de `games`, des recherches de teams par clé primaire et un B-tree temporaire pour le regroupement. Cette seule requête coûte environ 30–35 ms, dans une première compréhension à 36–43 ms.

Variante mesurée, à intégrer seulement après comparaison des comptes de chaque équipe :

```sql
SELECT t.name, x.games
FROM (
  SELECT team_id, COUNT(*) AS games
  FROM (
    SELECT blue_team_id AS team_id FROM games
    UNION ALL
    SELECT red_team_id AS team_id FROM games
  )
  GROUP BY team_id
) x
JOIN teams t ON t.id = x.team_id
ORDER BY x.games DESC;
```

Deux passages SQL précédents : **34,49 / 35,30 → 12,52 / 12,64 ms**, même nombre d’équipes présentes (**832**) et somme (**78 192**). Les totaux ne prouvent pas seuls l’égalité ligne par ligne. Si une partie contenait deux fois la même équipe, `UNION ALL` compterait deux apparitions là où la jointure actuelle n’en compte qu’une ; en faire un invariant contrôlé, ou traiter ce cas. Gain à retenir : environ **22 ms au premier index**, pas sur chaque requête chaude. Aucun nouveau cache.

### SQLite : plans, index et disposition physique

La base est déjà orientée données : identifiants entiers, tables de faits, lookup tables, vues lisibles par l’agent et clés composites `WITHOUT ROWID`. Ne pas remettre les noms répétés dans les tables de faits.

`champion_stats` : `EXPLAIN QUERY PLAN` utilise déjà `gp_champion` et `tournaments_league_year`, mais la CTE `bans` fait **`SCAN d`** sur les 752 989 lignes de `game_draft`. Deux variantes antérieures sur copies :

| Variante | Temps de la requête champion | Taille / compromis |
|---|---:|---|
| Base actuelle | 39,45 ms | Draft : 10,29 MB |
| Ajouter `(champion_id, kind, game_id)` puis `ANALYZE` | 13,97 ms | **+10,29 MB** ; base 108,85 MB |
| Réordonner la PK du draft, champion d’abord | 13,80 ms | Table 11,71 MB, soit +1,43 MB ; lecture d’un draft par partie 0,40 → 1,39 ms |

Le plan indexé évite le scan intégral des bans ; gain environ **25 ms / 65 % sur cette requête**, pas sur le pipeline entier. La question utilisée a été auto-relâchée : le résultat de huit lignes concerne toutes les années ; la variante strictement limitée à 2024, zéro ligne dans ce jeu de données, passe de 34,68 à 8,3–8,5 ms. Ne pas présenter cela comme une mesure de résultat 2024 réussi.

L’index additionnel est simple, mais ajoute 10 MB pour une question peu fréquente ; priorité basse. Réordonner la PK est plus économe mais change l’invariant d’unicité : inclure `champion_id` dans la clé peut autoriser deux champions au même slot. La proposition doit préserver l’unicité `(game_id, side, kind, slot)` ; le coût de cette protection n’a pas été mesuré. Ne pas adopter la PK expérimentale telle quelle.

Les historiques joueurs utilisent `gp_player` ; les stats in-game rejoignent les clés de `game_player_stats`. Les B-trees temporaires de `GROUP BY` / JSON ordonné ne prouvent pas un index manquant. Pas d’index supplémentaire recommandé sans mesure de la requête correspondante et de son coût disque.

### Réduire la répétition des objets équipés

`game_player_items` représente **2 122 746 lignes / 30,53 MB** : les mêmes `(game_id, player_id)` sont répétés pour six slots au maximum. Prototype : une ligne par joueur et partie, six colonnes nullable `i1…i6`, clé `(game_id, player_id)`, vue longue compatible via six slots et jointure items. La table expérimentale fait **10,57 MB**, pour 387 261 paires.

La copie complète expérimentale, comprenant aussi le draft réordonné et un `VACUUM`, passe de **98 562 048 à 77 557 760 octets**. Ce chiffre est le résultat du prototype combiné, pas un A/B isolant exclusivement les objets. Compression zstd : **32,46 → 28,74 MB** ; le gain de transfert est seulement **3,72 MB**.

Les lectures comparées gardent les mêmes comptes testés : 2 122 746 objets, 9 240 objets / 245 objets distincts pour Faker, 54 objets pour la partie 30000, Control Ward en tête avec 95 911 occurrences. Mais :

| Lecture | Ancienne vue | Vue sur six colonnes |
|---|---:|---:|
| Compter tous les objets | 342 ms | 414 ms |
| Compter pour Faker | 29 ms | 81 ms |
| Partie précise | 0,369 ms | 0,411 ms |
| Agréger par objet | 986 ms | 1 056 ms |

À retenir comme optimisation de **taille de déploiement**, si la marge devient nécessaire. Le fallback SQL peut lire `v_player_items` : préserver ses colonnes, multiplicité, positions, nulls et icônes ; comparer toutes les lignes et toutes les questions concernées avant adoption. Bump de schéma et rebuild depuis le cache, sans migration. Pas de suppression de ces données pour réduire le bundle.

### Ingestion et identité

`build.ts` utilise déjà une transaction, des statements préparés réutilisés et des dictionnaires nom → id. `identity.ts` maintient des ensembles d’identités exactes et repliées, pour distinguer les handles ambigus. Garder ces index : un tableau plat ne remplace pas la recherche par nom et les collisions d’identités sont des règles métier.

Le problème potentiel est la mémoire du rebuild : chargement complet, `JSON.parse`, validation Zod et tableaux/Map de `lines` et des résumés in-game simultanément. **7 s et 3,1–3,4 GB** restent acceptables sur le runner privé de 8 GB, à condition de ne pas faire deux rebuilds ou un rebuild et Next en parallèle. Libérer/itérer les gros jeux et lire le JSONL progressivement sont des pistes raisonnables, mais aucun prototype mesuré : pas de promesse de gain, pas de refonte SoA cette fois. Le hash du fichier reconstruit peut changer à cause des timestamps d’ingestion : comparer les données métier, pas imposer le SHA de l’ancien fichier à un rebuild.

Terminer chaque rebuild par **`PRAGMA journal_mode=DELETE; VACUUM;`**, comme actuellement. Conserver le contrôle de taille et les contrôles d’intégrité.

### Chargement, caches et bundle

`openDb()` ouvre en lecture seule et conserve un handle par instance ; **1,1 ms sous Bun / 3,2 ms sous Node** dans le bench. Le fichier de 98,6 MB n’est pas intégralement désérialisé en objets JS : SQLite lit des pages. Garder le singleton de connexion ; ne pas copier la base en mémoire, ne pas ajouter une Map de tous ses résultats.

| Cache existant | Décision et raison |
|---|---|
| Handle SQLite | Garder : ressource réutilisable et page cache SQLite |
| `WeakMap<DatabaseSync, Indexes>` équipes/champions | Garder : coût initial 36–43 ms, puis compréhension < 1 ms ; clé attachée à la base immuable |
| Cache des réponses Cargo/Data Dragon et raw Riot | Garder : reprise d’ingestion, throttle wiki et reproductibilité ; ce sont aussi les entrées d’un rebuild |
| Vercel Runtime Cache des timelines | Garder : calcul et transfert évités pour une donnée immuable, TTL 30 jours, absence 1 h, clé versionnée par `TIMELINE_FORMAT` |
| Cache CI des dépendances / données | Conditionner au gain réel, avec clés de contenu ; voir CI |

Échantillon antérieur de **202 parties** : gzip 47 KB en moyenne ; lecture locale 0,40 ms ; gunzip + JSON + Zod 6,24 ms ; `parseTimeline` 0,65 ms ; maximum decode + parse 15 ms ; timeline finale 2,2 KB. Conserver ce cache évite du calcul et surtout la lecture R2, dont la latence réelle n’a pas été mesurée ici. Supprimer les caches pour appliquer littéralement « caching is cope » dégraderait cette architecture.

Pas de cache de schéma proposé : la lecture chaude coûte 0,4–0,5 ms, et le guard utilise `prepare()` pour valider le SQL. Éviter un cache de statements illimité pour des requêtes text-to-SQL variables ; la préparation totale ne coûte que 0,5–0,7 ms par question.

Les **132,9 MB** de `/api/ask` sont une union locale des traces Next : **98,6 MB SQLite**, **18,2 MB sharp/libvips Darwin**, environ **12,1 MB Next** et le reste. La trace de route seule fait **101,6 MB**, le serveur minimal **0,7 MB** avec recouvrement : ne pas annoncer 133 MB comme taille cloud exacte. L’assemblage Vercel réel n’a pas été mesuré dans cette reprise. Les dépendances LLM/tracing sont en grande partie dans les chunks ; sommer tout `node_modules` serait incorrect.

Garder `outputFileTracingIncludes` de la base, les exclusions `data/raw/**` et assets de release, et `bun run size` après build. Budgets inchangés : DB 190 MB, fonction 250 MB non compressés. Le prototype de disposition SQLite est le levier mesuré sur la taille ; retirer des bibliothèques ou changer de runtime n’a pas de gain démontré.

## 2. Pourquoi les tests échouent en ordre aléatoire

Reproduction ciblée à la reprise, sans nouveau benchmark de durée :

```sh
bun test scripts/tracing.test.ts --randomize --seed=2380133667
# 8 pass, 3 fail ; reproduit dans le fichier seul
```

Les trois erreurs sont déterministes pour cette seed :

1. **Feedback**, `scripts/tracing.test.ts:393` : `sendFeedback()` retourne false. Ce test définit seulement `LANGFUSE_BASE_URL` et dépend des clés factices posées par le test « without the three… » à ses lignes 151–152. Si ce dernier n’a pas tourné, la configuration est absente.
2. **Exception tracée**, ligne 363 : le span est `undefined`. Le test « a failing export never throws », lignes 370–372, a remplacé `exporter.export` par une fonction qui lève, sans restaurer l’original. Un `exporter.reset()` vide les spans, mais ne rétablit pas la méthode ; les exports suivants échouent.
3. **Tracing off**, ligne 146 : `startTracing()` retourne true au lieu de false. Le module garde `processor` ; dès qu’un précédent test l’a initialisé, `startTracing()` retourne true avant de lire l’environnement. En ordre normal, « off » arrive avant « on ».

La quatrième panne observée selon la seed est cohérente avec les autres tests d’export qui supposent l’initialisation effectuée par « a question is one trace… ». Sa combinaison exacte n’a pas été rejouée dans la reprise. Le fichier seul reproduisant déjà trois pannes, l’interférence entre fichiers n’est pas nécessaire pour expliquer le problème principal.

**Correction à faire dans un futur changement** : donner à chaque scénario sa configuration complète ; sauvegarder/restaurer les variables modifiées ; restaurer `exporter.export` en `finally` ; vider les spans avant chaque cas. Isoler le scénario sans fournisseur dans un sous-processus frais, ou prévoir une vraie remise à zéro du traçage pour tests : shutdown/flush, fournisseur Langfuse, contexte OpenTelemetry, callbacks de télémétrie et singleton `processor`. Réinitialiser seulement les variables d’environnement ne suffit pas. Éviter de réenregistrer plusieurs fois les callbacks au fil des tests.

`timeline.test.ts` a également une configuration et un serveur dans `beforeAll`, un compteur partagé `seen` et un cache Vercel en mémoire. `resetTimelineStore()` oublie le store, **pas ce cache**. Pour des workers réutilisés : clés de cache propres au scénario ou invalidation explicite, reset des compteurs, restauration ciblée des variables, fermeture du serveur et suppression des fichiers temporaires en fin de fichier. Ne pas remplacer tout `process.env` par une copie ancienne pour effacer l’état d’autres suites.

**Avant correction**, garder `bun run test` séquentiel, sans `--concurrent` ni `--randomize` bloquant en CI. **Après correction**, valider les six seeds conservées puis essayer `bun test scripts --parallel=2 --no-isolate`, avec reset après chaque fichier et avant chaque scénario partageant un état. Les flags existent dans Bun 1.4.4 (`bun test --help` vérifié), mais le gain n’a pas été mesuré : à 0,2 s pour quatre fichiers, ne pas ajouter de sharding, Vitest ou grosses machines. Aucun test de frontend à ajouter ; l’interface se vérifie en lançant et regardant l’application.

## 3. Adapter le guide d’Owen au dépôt

Guide [How I made our CI 20x faster](https://x.com/owengretzinger/article/2116291924219060319), lu via sa [reproduction du texte d’Owen](https://teapaw.org/owengretzinger/article/2116291924219060319) car X répond 403. Les principes retenus sont la mesure du setup, les outils rapides, le partage des workers seulement avec reset d’état, le cache amorcé par main, l’historique Git disponible, le parallélisme borné et la sélection des tâches. Le dépôt n’a ni son volume de tests ni ses attentes de machines : aucun facteur ×20 crédible à promettre ici.

### Runners et budget

Les anciens logs du run Deploy **43609403961** donnent : attente 3 s, checkout 1 s, setup Bun 2 s, installation 2 s, lint 3 s, typecheck 9 s, tests 1 s, déploiement Vercel 47 s, job 72 s. Les 47 s de déploiement ne sont pas un temps de build CI. Aucun historique suffisant pour un p95 de queue.

| Option | Décision |
|---|---|
| GitHub `ubuntu-24.04` | Retenir. Standard privé : 2 vCPU / 8 GB ; public : 4 vCPU / 16 GB. Pas de serveur à entretenir. [Spécifications GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) |
| Blacksmith | Offre réelle, intégration GitHub et quota gratuit annoncé ; utile si attente ou CPU deviennent dominants. Ici la queue mesurée est de 3 s et les tests de 1 s : pas de migration justifiée. Promesse fournisseur non benchmarkée. [Offre](https://www.blacksmith.sh/pricing) |
| Vercel CI | Offre réelle. Ajouter une seconde orchestration et une configuration de tâches pour cette app unique ne résout pas un goulot mesuré. Conserver GitHub pour CI et le workflow de déploiement actuel ; ne pas supposer le service gratuit sur Hobby sans vérification contractuelle. [Produit](https://vercel.com/ci) |
| boat.dev | VM sandbox persistante, pas un remplacement gratuit sans exploitation à prévoir. Offre affichée avec minimum 20 $/mois, hors essai. Aucun intérêt mesuré pour cette CI ; pas de runner persistant exécutant des forks non fiables. [Offre](https://boat.dev/) |

### Lint, format et types

**Oxlint 1.93.0 existe déjà**, avec règles anti-slop, React, Next et TypeScript. Aucun remplacement ESLint à faire. Conserver les règles du dépôt et rendre les warnings bloquants (`--deny-warnings`). Élargir progressivement aux règles utiles de correctness/suspicious ; pas de `-D all` aveugle : le test antérieur correctness+suspicious+perf remontait 202 diagnostics, dont 149 `react-in-jsx-scope` inadaptés au JSX moderne et 31 `no-await-in-loop`, dont des boucles qui doivent respecter le throttle wiki.

Le lint type-aware essayé avec `oxlint-tsgolint` : **0,97 puis 0,45 s**, cinq avertissements (trois promesses non attendues dans `agent-console.tsx`, deux conversions vers string dans les tests de traçage). À traiter avant d’en faire un contrôle bloquant. Le format check Oxfmt était à 10 ms de moteur / 1,46 s avec première résolution de l’outil, mais signalait **40 fichiers** non conformes : épingler la version, décider du style et aligner le dépôt dans une modification dédiée ; ne pas ajouter maintenant un check dont le HEAD échoue.

Comparaison précédente à configuration identique non incrémentale avec `types: ["bun", "node"]` :

| Checker | Résultat | Décision |
|---|---:|---|
| tsc 5.9.3 | 1,74 / 1,72 s, succès | Référence actuelle |
| TypeScript 7.0.2 natif, commande `tsc` | 0,94 / 0,35 s, succès | Alternative simple si incompatibilité Bun ; `tsgo` était le nom de la preview |
| `bun check -p …` | 0,12 / 0,12 s, succès | Le plus rapide mesuré ; 50 fichiers contrôlés, 934 chargés |

`bun check` **existe bien dans Bun 1.4.4**, [documenté officiellement](https://bun.com/docs/runtime/check). Sans types explicites, il échouait notamment sur `bun:test` / `Bun`, malgré `@types/bun` installé. Une erreur témoin `number = "x"` était détectée par Bun et tsc ; cela vérifie un cas, pas une équivalence totale des checkers. Ajouter les types explicites dans `tsconfig.json` lors de l’implémentation, garder `next typegen` avant le contrôle, et conserver Next/tsc comme filet au build. TypeScript 7 utilise désormais `tsc` ; ne pas installer une preview ancienne pour obtenir le nom `tsgo`. [Référence Microsoft](https://github.com/microsoft/typescript-go)

### Sélection des tâches et test de la sélection

Pas de Nx/Turborepo nécessaire pour une application. Une fonction pure prend les noms de fichiers changés et produit `lint`, `typecheck`, `test`, `eval`, `build`, `database`. Toujours lancer la garde des métadonnées et le test de cette fonction. Chemin inconnu : **tout lancer**. Tenir compte des fichiers supprimés et des anciens noms lors d’un renommage (`git diff --no-renames --name-only -z`).

| Changement | Contrôles |
|---|---|
| Markdown uniquement | Métadonnées + sélection |
| App/UI/public/Next config | Lint, types, build ; pas de tests UI |
| Agent, DB runtime, storage | Lint, types, tests métier, eval, build |
| Tests métier seuls | Lint, types, tests |
| Questions d’eval | Lint, types, eval |
| Construction, identité, normalisation des alias, schéma, sources partagées | Tout, **dont rebuild SQLite offline** |
| Fetch/sync ingestion | Lint, types, tests métier ; fixture d’ingestion concernée, pas de fetch complet wiki |
| Lockfile, package, tsconfig, CI, outils inconnus | Tout par prudence |

L’ancien prototype temporaire `affected.ts` avait **13 tests / 27 assertions verts**, incluant chemins inconnus et fichiers suivis. Il n’est pas adopté tel quel : il ignorait trop largement `.githooks/**`, et ne lançait que lint/types pour certains scripts d’ingestion. Le YAML ci-dessous inclut une version conservatrice et ses assertions. Pour une extraction ultérieure en script, garder ces tests, ajouter suppression/renommage, chemin contenant espace, changement de schéma et union docs+code ; les changements de la fonction et de ses tests déclenchent tout. Le check requis doit exister même si toutes les étapes produit sont sautées ; éviter `paths-ignore` au niveau du workflow requis.

### Données, caches et reproductibilité

- **Épingler un snapshot d’eval**, indépendant de la dernière release hebdomadaire, dans un futur `ci/data.json` : dépôt, tag, SHA-256 des archives et de SQLite décompressé. Les attentes numériques restent attachées à ce snapshot ; une PR explicite met les deux à jour. `now` est déjà figé dans `eval/questions.json`.
- PR runtime/UI : restaurer SQLite, jamais `data:fetch`. PR ingestion : restaurer les sources normalisées et les résumés puis `data:build` dans le workspace éphémère ; ensuite `data:package` et eval complète sur la base **nouvellement reconstruite**. Attendre la fin de ce rebuild avant eval/build ; ne pas laisser le wrapper `bun run build` remplacer cette base par une release.
- La release actuelle publie SQLite **32,49 MB compressés**, `ingame.jsonl.zst` **10,76 MB** et le manifest. Il manque un asset des datasets Cargo/Data Dragon pour le rebuild offline : archive expérimentale **18,38 MB**, compression 0,49 s / extraction 0,22 s. Le publier dans une future modification autorisée de Data release ; le YAML seul ne peut pas le créer rétroactivement.
- Ne pas mettre les **28 342 raw Riot** dans chaque PR. Les tests utilisent déjà des JSON synthétiques V4/V5 et un faux R2. Pour modifier `ingame.ts`, ajouter un petit corpus réel versionné et ses résultats attendus, recalculé offline ; `data:build` sur un ancien `ingame.jsonl` ne prouve **pas** que la nouvelle dérivation est correcte. Une re-dérivation complète R2 reste une opération de data release approuvée, hors CI de forks.
- Cache de données à clé exacte contenant tag/hash et format, pas `latest`, pas de restore key mélangeant les schémas. Vérifier SHA, schéma, intégrité et mode DELETE même après un hit. Ne pas mettre la base reconstruite d’une PR dans le cache partagé.
- Dépendances : `bun install --frozen-lockfile`. Les logs GitHub montrent **2 s sans cache**, alors que le cache Bun compressé mesuré faisait **103,4 MB**. Recommandation initiale : installation directe. Si le cache est activé, le préremplir sur main, restaurer côté PR, sauvegarder uniquement depuis main ; clé OS/arch/Bun/lockfile. Comparer restauration + install à ces 2 s, puis supprimer si plus lent. Pas de transfert de `node_modules` Darwin vers Linux.
- Le YAML montre ce cache **désactivé par défaut** (`CACHE_DEPS=false`), activable après mesure. Aucun cache `.next` initialement : Next froid est court et la mesure chaude a échoué ; si ajouté, ne restaurer que `.next/cache`, jamais types/BUILD_ID/traces d’un ancien build.

Les PR peuvent lire les caches de la branche par défaut, y compris depuis des forks ; ne jamais y mettre `.env`, tokens ni données sensibles. La disponibilité et les restrictions sont celles de la [documentation GitHub des caches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching). Un cache est évictable : la release épinglée doit rester téléchargeable, même au-delà de la rétention actuelle de quatre releases. Prévoir une release de fixture dédiée non supprimée par le nettoyage `data-*`, ou une exclusion de rétention explicite.

## 4. YAML proposé, à conserver dans le rapport

**Conception, pas workflow installé ni exécuté.** Les actions checkout et setup-bun ci-dessous reprennent les SHA déjà utilisés dans le dépôt. Épingler également les actions setup-node et cache par SHA vérifié avant installation. Prérequis explicitement absents aujourd’hui : `ci/data.json`, `scripts/ci/data.ts`, l’asset source offline, le corpus de dérivation et les corrections de tests. La configuration actuelle reste inchangée.

Contrat du futur `scripts/ci/data.ts` : lire le descripteur épinglé ; imposer le dépôt attendu, un tag et des noms d’assets sûrs ; télécharger les archives manquantes par l’API GitHub avec le token read-only ; vérifier les SHA-256 après restauration et téléchargement ; extraire uniquement les fichiers attendus sans traversée de chemin ni symlink ; vérifier le SHA décompressé et l’intégrité SQLite. Avec `--raw`, restaurer aussi les datasets et `ingame.jsonl` nécessaires au rebuild. Aucun fetch wiki/R2, aucune publication. Écrire un résumé des données utilisées ; échouer clairement si le snapshot n’est pas disponible. La clé de cache inclut le hash de son descripteur.

```yaml
name: PR CI
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, edited, ready_for_review]
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

env:
  CI: "true"
  NEXT_TELEMETRY_DISABLED: "1"
  CACHE_DEPS: "false"

jobs:
  checks:
    name: PR checks
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          filter: blob:none
          fetch-depth: 0
          persist-credentials: false

      - name: Métadonnées et sélection (avec tests)
        id: changes
        shell: bash
        run: |
          python3 - <<'PY'
          import json, os, re, subprocess
          from pathlib import Path
          jobs = set("lint typecheck test eval build database".split())
          code = {"lint", "typecheck"}
          def affected(paths):
              out = set()
              for p in paths:
                  if re.fullmatch(r"docs/.*|[^/]+\.md|LICENSE", p):
                      selected = set()
                  elif p in {"package.json", "bun.lock", "tsconfig.json", "ci/data.json"} or p.startswith((".github/", "scripts/ci/", ".githooks/")):
                      selected = jobs
                  elif p.endswith(".test.ts") and p.startswith("scripts/"):
                      selected = code | {"test"}
                  elif p.startswith("scripts/data/"):
                      selected = code | {"test"} if p.endswith(("/fetch.ts", "/sync.ts")) else jobs
                  elif p == "src/lib/aliases.ts" or p.startswith("src/lib/sources/"):
                      selected = jobs
                  elif p.startswith("src/lib/"):
                      selected = jobs - {"database"}
                  elif p.startswith("eval/") or p == "scripts/eval.ts":
                      selected = code | {"eval"}
                  elif p == "scripts/size.ts":
                      selected = code | {"build"}
                  elif p.startswith(("src/", "public/")) or p in {"next.config.ts", "vercel.json"}:
                      selected = code | {"build"}
                  elif p == "oxlint.config.ts" or p.startswith("tools/oxlint/"):
                      selected = {"lint"}
                  else:
                      selected = jobs  # chemin inconnu : aucune omission
                  out |= selected
              return out
          assert affected([]) == set()
          assert affected(["README.md", "docs/audits/perf-ci.md"]) == set()
          assert affected(["src/app/page.tsx"]) == code | {"build"}
          assert affected(["src/lib/agent/query.ts"]) == jobs - {"database"}
          assert affected(["scripts/data/build.ts"]) == jobs
          assert affected(["scripts/data/identity.ts"]) == jobs
          assert affected(["scripts/data/ingame.ts"]) == jobs
          assert affected(["scripts/data/fetch.ts"]) == code | {"test"}
          assert affected(["scripts/tracing.test.ts"]) == code | {"test"}
          assert affected(["eval/questions.json"]) == code | {"eval"}
          assert affected([".githooks/pre-push"]) == jobs
          assert affected(["ci/data.json"]) == jobs
          assert affected(["new dir/deleted.ts"]) == jobs
          assert affected(["docs/x.md", "src/lib/db/index.ts"]) == jobs - {"database"}
          assert affected(["src/app/old.tsx", "scripts/data/new.ts"]) == jobs
          tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
          assert all(affected([p]) for p in tracked if p and re.search(r"\.(ts|tsx|json|ya?ml|css)$", p) and not p.startswith("docs/"))

          event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
          attribution = re.compile(
              r"co-authored-by:.*(?:claude|anthropic|copilot|cursor|codex|openai|chatgpt|gemini|devin|aider)|"
              r"generated (?:with|by).*(?:claude|copilot|cursor|codex|chatgpt|openai|gemini|\bAI\b)|"
              r"noreply@anthropic\.com|claude\.com/claude-code", re.I)
          assert attribution.search("Co-Authored-By: Claude <noreply@anthropic.com>")
          assert attribution.search("Generated with Codex")
          assert not attribution.search("Support OpenRouter and Claude models")
          if "pull_request" in event:
              pr = event["pull_request"]
              base, head = pr["base"]["sha"], pr["head"]["sha"]
              assert re.fullmatch(r"[0-9a-f]{40}", base)
              assert re.fullmatch(r"[0-9a-f]{40}", head)
              text = subprocess.check_output(["git", "log", "--format=%an <%ae>%n%cn <%ce>%n%B", f"{base}..{head}"]).decode()
              text += "\n" + (pr.get("title") or "") + "\n" + (pr.get("body") or "")
              if attribution.search(text):
                  raise SystemExit("Attribution de génération dans les commits ou la PR")
              paths = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", f"{base}...{head}"]).decode().split("\0")
              chosen = affected([p for p in paths if p])
          else:
              chosen = jobs  # main : tous les contrôles et amorçage caches
          with open(os.environ["GITHUB_OUTPUT"], "a") as out:
              for j in sorted(jobs):
                  print(f"{j}={str(j in chosen).lower()}", file=out)
              print(f"any={str(bool(chosen)).lower()}", file=out)
          Path(os.environ["RUNNER_TEMP"], "ci-jobs.json").write_text(json.dumps(sorted(chosen)))
          PY

      - if: steps.changes.outputs.any == 'true'
        uses: actions/setup-node@v4 # épingler par SHA avant installation
        with:
          node-version: "24"
      - if: steps.changes.outputs.any == 'true'
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version-file: package.json

      - if: steps.changes.outputs.any == 'true' && env.CACHE_DEPS == 'true'
        uses: actions/cache/restore@v4 # épingler par SHA
        id: deps
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ runner.arch }}-1.4.4-${{ hashFiles('bun.lock') }}
      - if: steps.changes.outputs.any == 'true'
        run: bun install --frozen-lockfile
      - if: github.event_name == 'push' && env.CACHE_DEPS == 'true' && steps.deps.outputs.cache-hit != 'true'
        uses: actions/cache/save@v4 # épingler par SHA
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ runner.arch }}-1.4.4-${{ hashFiles('bun.lock') }}

      - if: steps.changes.outputs.build == 'true' || steps.changes.outputs.eval == 'true' || steps.changes.outputs.database == 'true'
        uses: actions/cache/restore@v4 # épingler par SHA
        id: snapshot
        with:
          path: .ci-data
          key: snapshot-v1-${{ hashFiles('ci/data.json') }}
      - name: Données épinglées et vérifiées (helper à créer)
        if: steps.changes.outputs.build == 'true' || steps.changes.outputs.eval == 'true' || steps.changes.outputs.database == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          REBUILD: ${{ steps.changes.outputs.database }}
        run: |
          args=()
          if [ "$REBUILD" = true ]; then args+=(--raw); fi
          bun scripts/ci/data.ts --snapshot=ci/data.json --cache=.ci-data "${args[@]}"
      - if: github.event_name == 'push' && steps.snapshot.outputs.cache-hit != 'true'
        uses: actions/cache/save@v4 # épingler par SHA
        with:
          path: .ci-data
          key: snapshot-v1-${{ hashFiles('ci/data.json') }}

      - name: Rebuild offline, seulement si nécessaire
        if: steps.changes.outputs.database == 'true'
        run: |
          bun run data:build
          bun run data:package --tag=data-20000101-ci --out=data/ci-package
          # Ajouter ici le contrôle du corpus de dérivation Riot, à créer.

      - name: Générer les types Next avant le parallélisme
        if: steps.changes.outputs.typecheck == 'true' || steps.changes.outputs.build == 'true'
        run: bunx --no-install next typegen

      - name: Contrôles indépendants en parallèle, tous les codes de sortie vérifiés
        if: steps.changes.outputs.any == 'true'
        run: |
          python3 - <<'PY'
          import concurrent.futures, json, os, signal, subprocess
          from pathlib import Path
          selected = json.loads(Path(os.environ["RUNNER_TEMP"], "ci-jobs.json").read_text())
          commands = {
              # typecheck actuel conservé au départ ; voir migration bun check ci-dessous
              "build": ["bash", "-e", "-o", "pipefail", "-c", "bunx --no-install next build && bun run size"],
              "lint": ["bun", "run", "lint", "--deny-warnings"],
              "typecheck": ["bunx", "--no-install", "tsc", "--noEmit", "--incremental", "false"],
              "test": ["bun", "run", "test"],
              "eval": ["bun", "run", "eval", "--deterministic", "--strict"],
          }
          def run(name):
              log = Path(os.environ["RUNNER_TEMP"], f"ci-{name}.log")
              with log.open("w") as out:
                  try:
                      process = subprocess.Popen(commands[name], stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
                      return name, process.wait(timeout=180), log
                  except subprocess.TimeoutExpired:
                      os.killpg(process.pid, signal.SIGTERM)
                      try:
                          process.wait(timeout=3)
                      except subprocess.TimeoutExpired:
                          os.killpg(process.pid, signal.SIGKILL)
                          process.wait()
                      return name, 124, log
          # Next démarre tôt, le second worker exécute les contrôles courts.
          names = [n for n in commands if n in selected]
          failed = False
          with concurrent.futures.ThreadPoolExecutor(max_workers=min(2, os.cpu_count() or 1)) as pool:
              for name, code, log in pool.map(run, names):
                  print(f"::group::{name} (exit {code})", flush=True)
                  print(log.read_text(), flush=True)
                  print("::endgroup::", flush=True)
                  failed |= code != 0
          raise SystemExit(1 if failed else 0)
          PY
```

Ce premier YAML conserve tsc et les tests en ordre normal pour pouvoir partir du HEAD actuel une fois le chargement de données implémenté. Après correction des suites : remplacer le typecheck par `bun check --types bun,node --threads=1` (ou modifier les types dans tsconfig), puis essayer les workers Bun sans isolation. Ajouter le check Oxfmt seulement après alignement du format. Le contrôle TypeScript de Next reste actif ; les erreurs de compilation ne sont jamais ignorées.

`next typegen` précède les processus pour éviter une génération concurrente des mêmes types. Le tsc séparé n’écrit pas de `.tsbuildinfo` ; Next peut faire son contrôle. **La concurrence build + typecheck sur les fichiers Next générés reste à valider sur Linux** ; si Next réécrit des types pendant le contrôle, exécuter les types dans une copie temporaire dédiée ou les placer avant le build. Pas de suppression du typecheck pour gagner artificiellement du temps.

Le timeout de workflow arrête tout le job en dernier recours ; le lanceur termine aussi le groupe des sous-processus d’une commande expirée. Les sorties de tous les contrôles doivent être lisibles et tous les codes de sortie propagés. Ne pas utiliser `cmd & cmd & wait` sans récolter chaque statut.

### Sécurité lors du passage public

Utiliser **`pull_request`**, token `contents: read`, aucun secret OpenRouter/R2/Langfuse/Vercel, pas de `pull_request_target` exécutant le contenu de la PR. Checkout éphémère, sans credentials persistés. Les métadonnées de PR viennent du fichier d’événement et ne deviennent jamais du shell interpolé. Les forks exécutent le code de la PR avec un token limité à la lecture ; ne jamais leur transmettre le PAT de production. Garder l’approbation GitHub des premiers contributeurs.

Le check stable `PR checks` est à rendre requis sur `main` après son installation, y compris pour une PR de workflow. Protéger aussi main contre les pushs directs : sinon Deploy, déclenché au push, peut démarrer avant cette nouvelle CI. Vérifier que le plan GitHub du dépôt privé permet ces protections ; à défaut, les checks restent informatifs jusqu’à leur activation effective. Une PR peut modifier ses propres scripts de CI : revue/CODEOWNERS sur `.github`, `scripts/ci` et les descripteurs ; exiger les checks n’annule pas ce besoin. Les forks ne sauvegardent pas les caches partagés. Aucun artifact de PR ne doit être utilisé ensuite par un workflow privilégié pour publier ou déployer.

Le helper de données et les scripts d’installation peuvent exécuter du code non fiable : token de lecture seulement, disponible uniquement à l’étape nécessaire, pas de token d’écriture ou secret longue durée. Les données de fixture sont des données publiques Leaguepedia/Riot, pas les données d’un compte. Tester séparément un premier fork public sans secrets avant de considérer ce support validé.

### Garde des attributions

Interdire les trailers et crédits de génération dans l’auteur/committer, les messages, titre et description de PR ; ne pas interdire le mot `AI` ou `Claude` partout : le produit parle précisément de modèles et de SDK. Le prototype antérieur passait sur 14 commits, rejetait une attribution Claude et acceptait un titre parlant du modèle. Le YAML vérifie des motifs ciblés, sans afficher tout le contenu en cas d’échec. Ce n’est pas un détecteur d’origine du code ; compléter la liste des motifs si nécessaire. Une politique interdisant toute mention de modèle rendrait les descriptions techniques inutilisables.

### Hook pre-push proposé

Un simple `.githooks/pre-push`, activé explicitement avec `git config core.hooksPath .githooks` lors de la future implémentation. Lire les refs envoyées sur stdin et comparer **la branche réellement poussée** à sa base, pas toujours `HEAD` ; nouvelle branche : merge-base avec `origin/main`. Diff NUL, fichiers existants ACMR, noms passés comme tableau d’arguments, aucun `eval` shell. Refuser un arbre sale ou contrôler un snapshot des commits poussés pour ne pas vérifier seulement des modifications locales non commitées.

Sur TS/TSX modifiés : format `--check` et Oxlint, sans `--fix`. Sur code/config TS : `next typegen` puis contrôle du **projet entier**, car un type exporté peut casser un importeur inchangé. Bun peut checker des fichiers et leurs imports, mais cela ne suffit pas à vérifier leurs consommateurs. Sur docs uniquement : garde d’attribution, pas de build. Le hook reste un raccourci, la CI fait autorité.

Mesures antérieures : Oxlint sur les 13 fichiers TS/TSX du dernier commit **0,22 s**, `bun check` projet **0,16 s** mais avec la configuration actuelle insuffisante ; seul le bench avec types explicites était vert. Estimation après migration : **0,5–1 s** avec typegen/format chaud ; non validée comme hook complet. Ne pas installer de hook qui bloque tous les pushs sur les 40 divergences de format existantes.

## 5. Durées et coût attendus

Estimations, pas des runs de la nouvelle CI. Le seul historique GitHub exploité reste celui du Deploy existant ; les chiffres Linux des nouvelles commandes, du snapshot et du rebuild sont à vérifier après implémentation.

| Étape | Runner GitHub privé, estimation |
|---|---:|
| Queue + checkout + setup Node/Bun + sélection | 8–20 s |
| Dépendances directes | 2–5 s (2 s observés avant ajout explicite Node 24) |
| Restauration/téléchargement + validation snapshot | 3–12 s avec cache, 5–20 s sans cache |
| Lint | 1–3 s (3 s observés) |
| Typecheck tsc actuel | 3–9 s ; `bun check` futur ≈ 0,5–2 s + typegen |
| Tests métier | 1–2 s (1 s observé) |
| Eval complète déterministe | 2–5 s |
| Next + garde de taille | 12–30 s à confirmer |
| Rebuild + contrôle/package données, si ingestion | 20–60 s supplémentaires, compression incluse, **non mesuré sur Linux** |

Objectif réaliste : **PR docs 10–25 s**, **PR UI/runtime 30–70 s** avec installation/setup et étapes indépendantes bornées à deux processus ; **PR ingestion 60–150 s**, sans réseau wiki. Cache manquant et queue peuvent dépasser ces fourchettes. Le gain principal est d’obtenir un signal avant fusion, et d’éviter l’ingestion complète ; pas de promesse de division par 20 d’une CI qui n’existe pas encore sur PR.

Un job privé est arrondi à la minute supérieure : environ **1–2 minutes facturables par PR ordinaire**, **2–3 pour l’ingestion**. Cinq jobs + sélection augmenteraient ce minimum à environ 6–8 minutes même pour quelques secondes d’exécution ; pas nécessaire ici. Après passage public, le standard GitHub est gratuit et les jobs séparés deviennent une option pour lisibilité et absence de contention. [Règle d’arrondi et tarifs](https://docs.github.com/en/billing/reference/actions-runner-pricing)

GitHub Free inclut **2 000 minutes/mois** pour le privé ; vérifier le plan réel et l’usage partagé du compte. Exemple de budget : 100 exécutions de PR à 1–2 min = 100–200 min, 20 validations main à 1–2 min = 20–40 min, quatre Data release à 15–90 min = 60–360 min, 20 Deploy à environ 2 min = 40 min, soit **220–640 min/mois**. Ce sont des hypothèses, hors autres dépôts, reprises et phases de rattrapage. Limiter les runs obsolètes avec `cancel-in-progress`, et ne pas ajouter une seconde CI identique à côté du Deploy sans prévoir cette duplication. [Quotas GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Vérification avant livraison de cet audit

- Mesures historiques réutilisées, sorties SQL et logs de build retrouvés ; aucune optimisation prétendue déployée.
- Cause principale des tests aléatoires reproduite dans le fichier de traçage seul, seed consignée ; pas de modification pour les corriger.
- Une tentative nouvelle de build à chaud et une de cold start, toutes deux bornées et échouées pour raisons de permissions ; arrêt sans relance.
- YAML proposé conservé ici : parsing YAML réussi (13 étapes), syntaxe de tous les blocs shell/Python contrôlée, 15 assertions de sélection et couverture des fichiers suivis réussies, trois assertions de garde d’attribution et contrôles permissions/timeout réussis. Aucun workflow, cache, fork ou check requis installé/testé sur GitHub.
- Non vérifiés : cold start Vercel, bundle Vercel assemblé actuel, Node 24 en local, timings de la CI proposée, latence R2, coût réel du compte, compatibilité exhaustive Bun/tsc, intégrité exhaustive de la variante objets et effet réel du parallélisme sans isolation.
