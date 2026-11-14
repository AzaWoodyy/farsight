# Audit de sécurité avant passage en public et V1

- Date : 14/11/2026. Commit audité : `f166b7a` (branche `chore/audit-security`, arbre propre).
- Rapport non commité. À ne pas pousser dans le dépôt tant que B1 et B2 ne sont pas traités.
- Méthode : celle du skill `cloudflare/security-audit-skill` (copie locale identique à l'amont, commit `c1c8a8c`), en profil réduit. Écarts assumés en fin de document.

## Verdict

Aucun secret dans l'historique git, les logs de CI, les PR ni les fichiers suivis. La lecture seule de la base tient : toutes les tentatives de contournement du garde SQL ont été rejetées en local.

Deux points bloquent :

| # | Constat | Gravité | Bloque |
|---|---|---|---|
| B1 | Une requête générée coûteuse est acceptée par le garde et gèle le processus, sans moyen de l'interrompre | haute | le passage en public et la V1 |
| B2 | Adresse Gmail personnelle dans les métadonnées de 92 commits que GitHub détient | décision d'Enzo | le passage en public (irréversible ensuite) |

Le reste : 2 constats moyens, 6 bas, et 4 faits à valider dans des dashboards auxquels je n'ai pas eu accès.

## Bloquants

### B1. Le text-to-SQL n'a aucune borne de coût (haute)

**Où**
- `src/lib/agent/guard.ts:113-153` : le garde vérifie la lecture seule et la liste blanche, jamais le coût.
- `src/lib/agent/run.ts:235` : `db.prepare(guard.sql).all(plan.params)` est synchrone, sur le thread qui sert les requêtes.
- `src/lib/db/index.ts:29` : la base est ouverte sans `limits`.

**Ce qui a été observé en local** (base v5, 390 960 lignes dans `v_game_players`, un processus par cas, arrêté à 8 s) :

| SQL remis au garde | Résultat |
|---|---|
| `SELECT count(*) FROM v_game_players a, v_game_players b` | accepté, toujours en cours à 8 s |
| même requête, côté gauche limité à 1 000 lignes | accepté, toujours en cours à 8 s |
| `SELECT length(zeroblob(1000000000)) …` | accepté, 1 Go alloué |
| `SELECT length(printf('%.*c', 900000000, 'x')) …` | accepté, 900 Mo en 0,5 s |
| `group_concat` sur une jointure croisée | accepté, chaîne de 1,09 Go en 3 s |

Un worker thread ne règle rien : `worker.terminate()` ne rend pas la main tant que SQLite calcule (testé sur Node 26, le processus a dû être tué).

**Exploitabilité**
- Le SQL vient du modèle, et le modèle lit la question du visiteur (`query.ts:687`). Une consigne dans la question suffit en principe, et une question honnête peut aussi produire une auto-jointure (« pour chaque paire de joueurs… »).
- Effet attendu : la fonction est bloquée jusqu'à `maxDuration` (90 s, `route.ts:19`), avec les requêtes concurrentes de la même instance. Le temps CPU consommé sort du quota Hobby, partagé avec le portfolio.
- La limite de débit (30 questions par 10 min et par IP) laisse largement la place : une question toutes les 90 s suffit.
- Non vérifié : que le modèle de production émette bien ce SQL sur demande (aucun appel LLM fait), et le comportement exact de Vercel pendant le blocage.

**Correctif**
1. À l'ouverture : `new DatabaseSync(path, { readOnly: true, limits: { length: 1_000_000 } })`. Testé sur Bun 1.4.4 et Node 26 : les trois requêtes d'allocation échouent avec « string or blob too big », les requêtes normales passent. Effort : 15 min.
2. Exécuter le SQL généré dans un processus enfant tué après 3 à 5 s (connexion en lecture seule dans l'enfant). C'est la seule borne de temps fiable : `node:sqlite` n'expose ni `interrupt` ni `progress_handler` dans les types Node 24. Effort : une demi-journée à une journée, taille du bundle à remesurer.
3. En attendant le point 2 : refuser le SQL généré qui contient une jointure sans `ON`/`USING` (virgule, `CROSS JOIN`) ou plus de trois lectures de vues. C'est une heuristique, pas une borne. Effort : 1 h.

### B2. Adresse e-mail personnelle dans l'historique (décision)

**Où** : métadonnées auteur et committer. Sur les refs que GitHub détient (`main`, 3 branches, `refs/pull/1` à `14`) : 92 occurrences d'une adresse `@gmail.com`, 14 `@users.noreply.github.com`, 14 `@github.com`. Type : adresse personnelle, pas un secret.

**Exploitabilité** : dès que le dépôt est public, l'adresse est lisible par `git log` et reste dans les forks et les archives.

**Correctif, au choix**
- Accepter (l'adresse est peut-être déjà publique ailleurs).
- Réécrire avec `git filter-repo --mailmap` vers l'adresse `noreply` de GitHub. Les `refs/pull/*` ne se réécrivent pas : il faut publier l'historique réécrit dans un dépôt neuf et garder l'actuel privé en archive (les PR et les releases `data-*` sont à recréer, `DATA_REPO` par défaut pointe sur le nom actuel). Effort : 1 à 2 h.
- Dans les deux cas, régler `git config user.email` sur l'adresse `noreply` pour la suite. Effort : 2 min.

## Constats confirmés

### M1. Le `LIMIT` forcé se contourne (moyenne)

- **Où** : `guard.ts:58-61` (les commentaires non fermés ne sont pas retirés) et `guard.ts:113` (enrobage `SELECT * FROM (…) LIMIT n`).
- **Observé** : `SELECT player FROM v_game_players) /*` est accepté et rend 390 960 lignes, 8,7 Mo de JSON. SQLite accepte un `/*` non fermé en fin d'entrée, qui avale le `) LIMIT 200`.
- **Exploitabilité** : même chemin que B1 (SQL émis par le modèle). Réponse de plusieurs Mo en mémoire et dans le flux ; aggrave B1.
- **Correctif** : lire avec `stmt.iterate()` et s'arrêter à `MAX_ROWS`, quelle que soit la forme du SQL ; rejeter un SQL dont un commentaire reste ouvert ou dont les parenthèses passent sous zéro. Effort : 1 h.

### M2. `/api/feedback` accepte n'importe quel identifiant de trace (moyenne)

- **Où** : `src/app/api/feedback/route.ts:6-9,25`, `src/lib/tracing/langfuse.ts:146-178`.
- **Exploitabilité** : rien ne prouve que l'identifiant a été émis par `/api/ask`. Un client qui passe BotID peut envoyer des avis sur des identifiants inventés, sans limite de débit dans le code. Les avis des autres visiteurs ne sont pas atteignables (identifiants de 128 bits jamais exposés).
- **À valider** : que Langfuse accepte et compte un score sur une trace inexistante (aucun appel fait à Langfuse). Si oui : unités du plan Hobby brûlées (50 000 par mois) et statistiques d'avis faussées.
- **Correctif** : signer l'identifiant. `/api/ask` envoie `traceId` et `HMAC-SHA256(secret, traceId)` dans la part `data-trace` ; `/api/feedback` vérifie en temps constant. Ajouter la troisième règle du pare-feu sur `/api/feedback` (`docs/deploy.md:473`). Effort : 1 h, une variable `FEEDBACK_SECRET`.

### L1. Limite de débit et plafond de coût hors du dépôt (basse, à valider)

- **Où** : aucune limite dans `src/app/api/ask/route.ts` ; tout repose sur les réglages manuels de `docs/deploy.md:340-400`.
- **Coût d'une question** : au plus 5 appels LLM (`extract-entities`, `pick-tool`, `generate-sql`, deux `repair-sql`), 600 jetons de sortie chacun, un nouvel essai en cas d'erreur.
- **Exploitabilité** : la perte financière est bornée par le plafond de la clé OpenRouter. Le vrai effet est la coupure : quelques IP suffisent à épuiser le plafond hebdomadaire, et le LLM reste coupé pour tout le monde jusqu'à la remise à zéro.
- **Correctif** : passer le plafond de la clé en remise à zéro quotidienne (par exemple 1 $ par jour) ; ajouter un compteur quotidien d'appels LLM dans le Runtime Cache, au-delà duquel `getLlm()` rend `null`. Effort : 1 à 2 h.

### L2. Routes d'API sans contrôle d'origine ni de type de contenu (basse)

- **Où** : `route.ts:53` et `feedback/route.ts:21` lisent `req.json()` quel que soit le `Content-Type`.
- **Exploitabilité** : une page tierce peut envoyer un POST « simple » (`text/plain`, sans préflight) depuis le navigateur d'un visiteur, donc depuis son IP. BotID devrait le rejeter faute d'en-têtes de challenge : non vérifié.
- **Correctif** : 415 sans `application/json`, 403 si `Sec-Fetch-Site` vaut `cross-site`. Effort : 15 min.

### L3. En-têtes de sécurité absents (basse, durcissement)

- **Observé** (une requête `HEAD /`) : `strict-transport-security: max-age=63072000` et `access-control-allow-origin: *`. Ni CSP, ni `frame-ancestors`, ni `X-Content-Type-Options`, ni `Referrer-Policy`, ni `Permissions-Policy`. `next.config.ts` n'a pas de `headers()`.
- **Exploitabilité** : aucun point d'injection trouvé (pas de `dangerouslySetInnerHTML`, liens construits côté serveur par `wikiUrl`, `leaguepedia.ts:270`). C'est de la défense en profondeur.
- **Correctif** : en-têtes statiques dans `next.config.ts` (30 min). Une CSP stricte demande des nonces et l'origine du script BotID (une demi-journée).

### L4. Secrets du workflow « Data release » visibles par toutes les étapes (basse)

- **Où** : `.github/workflows/data-release.yml:49-54`. Les quatre secrets R2 en écriture et `GH_TOKEN` (`contents: write`) sont au niveau du job.
- **Exploitabilité** : nulle aujourd'hui (actions épinglées par SHA, lockfile gelé). Une dépendance compromise lue par `bun install`, `data:build` ou `eval` verrait la clé d'écriture R2.
- **Correctif** : `R2_*` sur l'étape `data:fetch` seulement, `GH_TOKEN` sur les trois étapes qui appellent `gh`. Effort : 15 min.
- **À regarder** : `package.json:54-61` liste `sharp` et `unrs-resolver` à la fois dans `ignoreScripts` et `trustedDependencies`. Garder une seule intention.

### L5. CLI Vercel téléchargé à l'exécution avec le jeton du compte (basse)

- **Où** : `.github/workflows/deploy.yml:49,78`.
- **Exploitabilité** : `bunx vercel@65.16.0` sort du lockfile, et reçoit un jeton qui, en Hobby, couvre tout le compte, portfolio compris (`docs/deploy.md:336`). Le jeton passe aussi en argument (`--token`).
- **Correctif** : ajouter `vercel` en `devDependencies` (intégrité par le lockfile) et laisser le CLI lire `VERCEL_TOKEN` dans l'environnement. Effort : 15 min.

### L6. Données personnelles : ce qui part chez des tiers (basse)

- **Où** : `src/lib/tracing/mask.ts:1-6`, `understand.ts:684`, `query.ts:657,687`, `src/app/page.tsx:35`.
- **Constat** : le masque couvre e-mails, IPv4, IPv6 et téléphones, sur tous les attributs texte des spans (prompts compris). Un nom, une adresse postale ou un pseudo tapé dans une question part tel quel chez Langfuse (30 jours). La question part aussi, non masquée, chez OpenRouter et le fournisseur du modèle.
- **`sessionId`** : UUID choisi par le navigateur, validé par `z.uuid()` (`route.ts:24`). Un client peut ranger ses propres traces sous l'identifiant de son choix ; ceux des autres ne sont jamais exposés. Pas de constat.
- **Correctif** : compléter la mention de `page.tsx:35` (« envoyées à un fournisseur de modèle de langage »). Vérifier dans OpenRouter que la journalisation des prompts est désactivée. Effort : 10 min.

## Points examinés sans constat

**Garde SQL, lecture seule et périmètre** : 27 cas remis à `guardQuery` avec la liste `VIEWS`.
- Rejetés : `INSERT`, `DELETE` derrière un CTE, `PRAGMA`, fonctions `pragma_*` (jointure à virgule, sous-requête), `ATTACH`, seconde instruction, `sqlite_master` (direct, virgule, `count(*)`), tables de base (virgule, étoile, sous-requête, guillemets, parenthèses), `game_riot`, `load_extension`, `readfile`, `sqlite_dbpage`.
- CTE récursifs : rejetés par l'authorizer, avec ou sans le mot-clé `RECURSIVE`. C'est un effet de bord heureux, pas une règle écrite : à couvrir par un test.
- Acceptés sans conséquence : `sqlite_version()`, une constante (`SELECT 'texte'`), un commentaire contenant une instruction.
- La passe regex se trompe souvent ; c'est l'authorizer et `prepare()` qui tiennent. La base ne contient que des données publiques : la liste blanche protège la justesse, pas un secret.

**Injection de prompt**
- `llmDecider` (`understand.ts:670-711`) : sortie contrainte par zod, noms résolus à nouveau contre les tables d'alias. L'effet se limite à la réponse du demandeur.
- `llmRouter` (`query.ts:637-681`) : arguments validés par zod puis normalisés contre la base, aucun outil à effet de bord.
- Synthèse (`run.ts:329-362`) : texte libre hors chiffres et périodes, affiché échappé, pour le seul demandeur. Aucune URL ne lance une question toute seule, donc pas de lien piégé.
- Fuite des prompts : ils sont dans le dépôt et ne contiennent aucun secret. Pas un constat.
- Injection indirecte : un nom de joueur ou d'équipe modifié sur Leaguepedia arrive dans les faits donnés à la synthèse. Effet borné à la phrase de synthèse. À garder en tête, pas à corriger.

**Secrets et historique**
- Tous les objets atteignables depuis les refs locales, qui contiennent toutes les refs distantes (`git ls-remote` : 22 refs, toutes présentes) : aucun motif de clé OpenRouter, Langfuse, GitHub, AWS/R2, Vercel, clé privée, JWT ni URL à identifiants.
- Seul `.env.example` a été commité (`dfad7dc`), valeurs vides. Les seuls e-mails sont des adresses `@example.com` dans `scripts/tracing.test.ts`.
- Logs de 8 exécutions Actions sur 9 (la neuvième tournait) : aucun motif de secret, toutes les lignes `R2_SECRET_ACCESS_KEY` masquées. Ils contiennent 10 URL de déploiement `*.vercel.app`.
- 14 PR et leurs commentaires : rien.

**GitHub Actions**
- Déclencheurs : `push` sur `main`, `schedule`, `workflow_dispatch`, `workflow_call`. Aucun `pull_request` ni `pull_request_target` : un fork ne lance rien et ne voit aucun secret.
- Actions épinglées par SHA (`checkout`, `setup-bun`). Jeton par défaut en lecture, `contents: write` déclaré pour le seul job de release.
- Aucune expression `github.event.*` dans un `run:`. Les entrées passent par `env`.

**R2** : le runtime ne lit que `R2_READ_*` (`storage/index.ts:192-200`, `timelines.ts:46`). Une clé en lecture seule suffit, et c'est déjà ce que le code impose. Les clés d'objet viennent de la base et passent par `checkKey` (`storage/index.ts:27-33`).

**Dépendances** : `bun audit` remonte une faille, GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6, haute). Elle touche `zod@4.1.11` sous `@vercel/cli-config` (via `@vercel/functions`), qui lit une configuration locale, pas une requête. Le zod de l'application est en 4.6.7. Non exploitable ici ; un `overrides` la fait disparaître (10 min).

## À valider par Enzo

| Fait | Où regarder |
|---|---|
| Les deux règles de limite de débit sur `/api/ask` sont publiées | Vercel → Firewall |
| `R2_ACCESS_KEY_ID` et `R2_SECRET_ACCESS_KEY` sont absents du projet Vercel | Vercel → Environment Variables |
| Le jeton `R2_READ_*` est bien « Object Read only », limité au bucket | Cloudflare → R2 API Tokens |
| Plafond et période de la clé OpenRouter, journalisation des prompts | OpenRouter → Keys, Privacy |
| Les URL `*.vercel.app` sont derrière la protection de déploiement | Vercel → Deployment Protection |

Le projet Vercel n'était pas visible avec l'accès dont je disposais (seul le portfolio l'était).

## Au moment de passer en public

1. Activer « Secret scanning » et « Push protection », puis les alertes Dependabot (gratuits sur un dépôt public, indisponibles aujourd'hui).
2. Protéger `main` par un ruleset (pas de push forcé ni de suppression) : un push sur `main` déploie la production.
3. Actions → « Require approval for all outside collaborators », avant d'ajouter un jour un workflow sur `pull_request`.
4. Supprimer les anciens logs d'exécution si les URL de déploiement gênent (`gh run delete`).
5. `DATA_GITHUB_TOKEN` n'a plus besoin de droit sur un dépôt privé : le remplacer par un jeton sans permission, ou adapter `data:pull` au téléchargement anonyme.
6. Hors sécurité : pas de fichier `LICENSE`, et les releases publieront une base dérivée de Leaguepedia (CC BY-SA 3.0) : attribution et partage à l'identique à mentionner.

## Ce qui n'a pas été vérifié

- Le comportement du modèle face à une injection (aucun appel LLM, pour ne pas consommer le quota).
- Toute la configuration hors dépôt : pare-feu et variables Vercel, jetons Cloudflare, clé OpenRouter, projet Langfuse.
- BotID face à une requête sans navigateur ou d'origine tierce, et le comportement de Langfuse sur un score orphelin : cela aurait demandé de solliciter la production.
- Les commits orphelins que GitHub garderait après un push forcé (inaccessibles sans leur SHA).
- La neuvième exécution Actions, en cours pendant l'audit.
- `scripts/data/*` (ingestion) n'a été lu que pour le jeton et les téléchargements, pas ligne à ligne. `tools.ts` : interpolations SQL et schémas d'entrée vérifiés, pas les 1 838 lignes.

## Écarts avec la méthode du skill

- Un seul rapport, ici, au lieu des artefacts du skill (`findings.json`, registre de couverture, validateurs) : c'était la consigne.
- Pas de vague d'agents ni de vérificateur indépendant. Chaque constat confirmé repose sur une trace dans le code et, pour B1 et M1, sur une exécution locale.
- Pas de bac à sable imposé par l'OS. Les essais ont tourné dans des processus séparés, environnement vide, sur une copie de la base, sans réseau ni clé.
- Sollicitations de la production : une seule requête `HEAD /` pour lire les en-têtes.
- Un constat non confirmé n'a pas de gravité ferme : L1 et M2 portent une gravité sous réserve des validations indiquées.
