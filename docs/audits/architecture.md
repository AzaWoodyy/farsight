# Audit d'architecture avant la V1

Audit en lecture seule du 14/11/2026, sur `chore/audit-architecture` à `f166b7a` (identique à `main`). Aucun fichier du dépôt n'a été modifié en dehors de ce rapport, qui n'est pas commité.

## Résumé

Aucun P0 : je n'ai trouvé ni faille exploitable ni réponse fausse systématique. Le garde SQL tient sur tous les contournements essayés.

Les problèmes se ramènent à quatre causes :

1. **Les constantes de domaine vivent dans `scripts/`**, que `src/` n'a pas le droit d'importer. `SCHEMA_VERSION` et `LEAGUES` sont donc recopiés ou absents côté application : la liste des ligues existe en sept exemplaires et l'app ne vérifie jamais la version de la base qu'elle ouvre.
2. **Le vocabulaire d'une métrique ou d'un outil est éclaté.** Ajouter un outil demande neuf modifications, ajouter une métrique en demande une dizaine, et rien ne signale un oubli.
3. **L'issue d'une question n'a pas de type.** Elle est recalculée à quatre endroits à partir de `route`, `plan`, `rows` et de deux tableaux mutés en paramètre. Conséquence visible : une requête qui échoue trois fois est annoncée comme « Aucun résultat dans la base ».
4. **Les garanties reposent sur l'eval, qui ne tourne pas en CI.** Il n'y a aucun workflow sur les pull requests, et ni le garde SQL, ni le routeur, ni le contrôle des chiffres de la synthèse n'ont de test unitaire.

### Les dix constats à traiter en premier

| # | Constat | Gravité | Effort |
|---|---|---|---|
| 1 | Aucune CI sur les PR : lint, typecheck et tests ne tournent qu'après le merge, dans `deploy.yml` | P1 | S |
| 2 | Le contrôle des chiffres de la synthèse LLM accepte des chiffres échangés, une autre équipe et un superlatif inventé | P1 | S |
| 3 | « LCS depuis 2015 » ne lit que la LCS 2019+ : une période à cheval sur un renommage de ligue est tronquée sans note | P1 | M |
| 4 | L'app ne vérifie pas `user_version` à l'ouverture ; `SCHEMA_VERSION` n'est lié au DDL par rien | P1 | S |
| 5 | Une requête rejetée ou en erreur trois fois donne « Aucun résultat … dans la base » | P2 | M |
| 6 | Liste des ligues en sept exemplaires, dont deux dérivables seulement à la main | P2 | M |
| 7 | Un outil typé est défini à neuf endroits, une métrique à une dizaine | P2 | M |
| 8 | « Worlds 2010 » ou « 2031 » : l'outil typé échoue en silence, la réponse dit « aucun outil ne couvre la question » | P2 | S |
| 9 | `data:build` mélange des résumés in-game de deux `DERIVE_VERSION` ; le contrôle de régression in-game saute lors d'un changement de schéma | P2 | S |
| 10 | Garde SQL, routeur et `data:pull` sans test ; une auto-jointure croisée passe le garde et bloque l'instance | P2 | M |

## Méthode et vérifications

- Lecture complète de `src/`, `scripts/`, des deux workflows, de `eval/`, `docs/deploy.md`, `README.md`, `AGENTS.md`, `.env.example`. `tools/oxlint/` (règles de lint vendues) est hors audit.
- Le skill `untangle-codebase` a été lu et appliqué pour ses étapes 2 et 3 (liste des problèmes, refonte depuis les principes). Les étapes 1 (demander quels compléments faire), 4 (corriger) et 5 (boucle de sous-agents) ne s'appliquent pas à un fil en lecture seule.
- Preuves empiriques, lancées depuis le dossier temporaire sur une base SQLite en mémoire construite avec le DDL de `scripts/data/build.ts` :
  - 17 requêtes contre `guardQuery` ;
  - `understandQuestion` → `routeQuestion` → `buildQuery` sur cinq questions ;
  - huit phrases contre une copie de `claimsBeyondFacts` (la fonction n'est pas exportée).
- Graphe d'imports et co-changements git calculés par script.

Gravité : P0 réponse fausse ou faille en production aujourd'hui, P1 à corriger avant la V1, P2 dette qui coûtera au prochain changement, P3 cosmétique. Effort : S moins d'une heure, M une demi-journée, L plus d'une journée.

---

## 1. Source unique de vérité

### S1. Ligues du périmètre : sept exemplaires (P2, M)

| Copie | Emplacement | Contenu |
|---|---|---|
| a | `scripts/data/scope.ts:63` `LEAGUES` | nom, abrégé, région, international |
| b | `src/lib/agent/types.ts:12` `LEAGUE_NAMES` | les 19 noms, dans l'ordre de spécificité des regex |
| c | `src/lib/agent/understand.ts:24` `LEAGUE_CUES` | regex par ligue, ordre significatif |
| d | `src/lib/agent/understand.ts:567` `eraLeague` | renommages LCS / LEC / LCK, années en dur |
| e | `src/lib/agent/run.ts:367` et `query.ts:294` | périmètre en prose dans les réponses |
| f | `src/lib/agent/query.ts:285,389`, `tools.ts:564` | `"World Championship"`, `"Mid-Season Invitational"` en dur, alors que `leagues.is_international` existe |
| g | `AGENTS.md` (Scope), `README.md:56` (« 19 ligues ») | doc |

S'y ajoute l'accord français de chaque ligue (« aux Worlds », « du MSI », « la LCK »), recalculé par `=== "Worlds"` à huit endroits : `query.ts:127-129`, `tools.ts:287,454,488,564,810,931,1464`.

Rien ne lie (a) et (b) : une ligue ajoutée dans `scope.ts` est ingérée mais jamais reconnue, sans erreur. Seul `data:package` compare `LEAGUES.length` au nombre de ligues en base (`package.ts:147`).

**Source canonique** : un module `src/lib/domain/leagues.ts`, importé par `src/` et par `scripts/`. Chaque entrée porte `name`, `short`, `region`, `international`, `cue` (regex), `fr` (les formes « de », « à ») et `family` avec ses bornes d'années. On en dérive `LEAGUE_NAMES`, `LEAGUE_CUES` (triées par longueur de motif plutôt que par position), le texte du périmètre, `eraLeague` et l'énumération zod des outils. `AGENTS.md` renvoie au fichier au lieu de recopier la liste.

### S2. Schéma SQL : le DDL et cinq listes recopiées (P1, M)

| Copie | Emplacement |
|---|---|
| DDL | `scripts/data/build.ts:61-129` (tables), `591-674` (index et vues) |
| Nombre de colonnes par insertion | `build.ts:256` (`Array(23)`), `318` (`Array(15)`), `486` (`PLAYER_STATS = 36`), `488` (`Array(19)`), `225`, `485` |
| Tables comptées | `build.ts:677` `TABLES` |
| Objets requis | `scripts/data/package.ts:52` `REQUIRED` |
| Vues autorisées | `src/lib/agent/guard.ts:19` `VIEWS`, `:32` `ALLOWED_OBJECTS` |
| Colonnes in-game | `scripts/data/ingame.ts:28-60`, `build.ts:565-575`, `build.ts:630-642`, `src/lib/agent/metrics.ts:64-93` |
| Description en prose pour le LLM | `src/lib/agent/query.ts:547-561` `SQL_RULES` |
| Lignes typées | schémas zod par outil, `tools.ts:306-365`, `1024`, `1164`, `1432` |

Les insertions sont positionnelles : ajouter une colonne au milieu d'une table décale toutes les valeurs suivantes sans erreur, parce que SQLite ne type pas les colonnes.

`SCHEMA_VERSION` (`scope.ts:8`) est incrémenté à la main. Un changement de DDL sans incrément produit une release que `data:pull` accepte pour un code qui attend l'ancienne forme.

**Source canonique** : `src/lib/db/schema.ts` exporte `SCHEMA_VERSION`, `createSchema(db)` et la liste des vues lue dans le DDL. `REQUIRED`, `TABLES` et `VIEWS` s'en dérivent par `sqlite_master` sur une base en mémoire. Les insertions passent en colonnes nommées. Un test compare l'empreinte du DDL à une valeur commitée avec la version : changer l'un sans l'autre fait échouer le test. Le schéma envoyé au LLM est déjà lu en direct (`query.ts:541`), il n'y a rien à changer là.

Ne vaut pas la peine : générer les types de lignes depuis le SQL. Les schémas zod par outil valident déjà à la frontière.

### S3. Un outil typé : neuf endroits (P2, M)

`ToolName` (`types.ts:116`), le schéma d'entrée (`tools.ts:53-132`), l'union `ToolCall` (`tools.ts:153`), la définition, le `switch` de `bindTool` (`tools.ts:1746`), `aiTools` (`tools.ts:1769`), le `switch` de `normalizeToolCall` (`tools.ts:1783`), `TOOL_WORDS` (`query.ts:435`), les règles du routeur. Trois de ces listes sont vérifiées par le compilateur (`Record<ToolName, …>`), les autres non.

**Source canonique** : un registre `TOOLS = { player_event_history: defineTool({ input, plan, format, … }), … }`. `ToolName = keyof typeof TOOLS`, `ToolCall` devient un type mappé, `aiTools` un `mapValues`, `bindTool` et `normalizeToolCall` deviennent génériques et les deux `switch` de 9 cas disparaissent. Les mots de l'outil (`TOOL_WORDS`) vont dans sa définition.

### S4. Une métrique in-game : une dizaine d'endroits (P2, M)

Pour `first_blood` : le calcul (`ingame.ts:225,264`), la colonne (`build.ts:106,112`), les vues, `PLAYER_METRICS`/`TEAM_METRICS` et leurs `DEFS` (`metrics.ts:12-93`), la regex de question (`metrics.ts:125`), `DATA_CONCEPTS` (`query.ts:41`), `UNSUPPORTED` (`query.ts:25`), `TERM_PHRASES` et `STAT_WORDS` (`understand.ts:91,119`), les libellés de colonne (`tools.ts:1000,1293`), la phrase de faits (`tools.ts:1102-1120`, `1356-1360`), la description de l'outil recopiée à la main (`tools.ts:104-105`, `1033`, `1192`, `1307`) et `SQL_RULES`.

Même constat pour les minutes 10, 15 et 20 : `ingame.ts:24`, `metrics.ts:8`, `tools.ts:87`, la regex `metrics.ts:106`, les noms de colonnes.

**Source canonique** : `MetricDef` porte aussi le libellé de colonne, la phrase de faits et le motif de question. La description de `LeaderboardInput` se construit avec `PLAYER_METRICS.join(", ")`. `TERM_PHRASES` se compose des motifs des métriques.

### S5. Autres doublons

| # | Donnée | Emplacements | Canonique proposé | Gr. | Eff. |
|---|---|---|---|---|---|
| S5a | Rôles `Top…Support` | `tools.ts:91`, `build.ts:471`, `roles.ts:6`, `query.ts:557` | `roles.ts` exporte `ROLES`, le reste dérive | P3 | S |
| S5b | Stades (`event`, `main_event`…) | type `scope.ts:98`, commentaire DDL `build.ts:69`, littéraux `tools.ts:44,47`, `understand.ts:202`, `query.ts:558` | `STAGES` dans le module de schéma | P3 | S |
| S5c | Splits | `types.ts:96`, `tools.ts:82`, `understand.ts:56` | `SPLITS` dans `types.ts`, `z.enum(SPLITS)` | P3 | S |
| S5d | Bornes d'années | regex `20[1-3]\d` en `understand.ts:114,553,554` ; `min(2011).max(2030)` en `tools.ts:50` | une constante, borne haute dérivée de `now` (voir I7) | P2 | S |
| S5e | Limite de lignes | `guard.ts:34` `MAX_ROWS = 200` ; « under 200 rows » dans `query.ts:558` | interpoler `MAX_ROWS` dans le prompt | P3 | S |
| S5f | Seuils de confiance | `0.8` en `understand.ts:715`, `query.ts:704`, `run.ts:503`, `trace.ts:200` ; `0.75` en `decide.ts:47`, `query.ts:766` ; `UNSURE = 0.5` « sous une requête générée (0.6) », lié à la main à `query.ts:696` | constantes nommées dans `decide.ts` ; `trace.ts:200` importe le seuil de `understand.ts` | P2 | S |
| S5g | Aide regex « mot entier » | `query.ts:16`, `metrics.ts:103`, `understand.ts:94` ; échappement regex en `query.ts:482`, `understand.ts:738` | un `src/lib/agent/text.ts` | P3 | S |
| S5h | Mots vides | `STOPWORDS` (`understand.ts:62`) et `FUNCTION_WORDS` (`query.ts:406`), deux listes proches aux rôles différents | les garder séparées, les ranger dans le même fichier et documenter la différence | P3 | S |
| S5i | Exemples de questions | `run.ts:56`, `agent-console.tsx:17` et le `placeholder` `:146`, deux listes différentes | une liste partagée dans `types.ts` | P3 | S |
| S5j | Libellés d'événements de timeline | `game-timeline.tsx:12-33`, `tools.ts:1474` | `EVENT_LABELS` à côté de `EVENT_KINDS` (`sources/timeline.ts:31`) | P3 | S |
| S5k | Noms d'assets et préfixe de tag | `artifact.ts:13-21` ; en dur dans `data-release.yml:67,77,79,85,87,117,131` | le workflow lit un JSON produit par `bun scripts/data/release-meta.ts` (voir M5) | P2 | S |
| S5l | Ligne de log comme contrat | `pull.ts:259` écrit `data:pull: latest release X` ; `deploy.yml:84-86` la lit par `grep` | `data:pull` écrit le tag retenu dans un fichier ou dans `$GITHUB_OUTPUT` | P2 | S |
| S5m | Budgets de taille | `artifact.ts:24-25`, `size.ts` (250 et 225 Mo), prose dans `package.ts:12`, `build.ts:724`, `AGENTS.md`, `deploy.md:12` | déjà correct en code ; la doc cite les constantes | P3 | S |
| S5n | Version du projet | `package.json` `0.1.0`, bannière `page.tsx:4` « v0.1 », User-Agent `leaguepedia.ts:26` « 0.4 », `data-release.yml:45` « 1.0 » | lire `package.json` | P3 | S |
| S5o | Chemin de la base | `db/index.ts:9` (relatif à `process.cwd()`), `scope.ts:24` (relatif à la racine du dépôt), `next.config.ts:8,17` (`data/lol.sqlite` en dur, ignore `DATABASE_PATH`) | un seul résolveur | P3 | S |
| S5p | Durée maximale de la route | `route.ts:19` `maxDuration = 90`, justifié en commentaire par « cinq appels de 15 s » ; les termes sont `LLM_CALL.timeoutMs` (`llm.ts:18`) et `MAX_ATTEMPTS` (`run.ts:14`) | le calcul est exact aujourd'hui (5 appels au pire) ; ajouter un test qui le recalcule | P3 | S |
| S5q | Modèle par défaut | `llm.ts:15`, `.env.example:9`, `README.md:191` | acceptable | P3 | — |
| S5r | `KEEP_RELEASES`, délai, budget Riot | `data-release.yml:44-48`, prose `AGENTS.md`, `deploy.md` | acceptable : une seule valeur en code | P3 | — |

### S6. Variables d'environnement (P2, S)

`AGENTS.md` pose que `.env.example` liste toutes les variables. Écart trouvé : `LANGFUSE_TRACING_ENVIRONMENT`, lue en `src/lib/tracing/langfuse.ts:90`, est absente de `.env.example` et de `docs/deploy.md`.

Les lectures sont dispersées dans 11 fichiers, chacune avec sa valeur par défaut (`llm.ts:37-40`, `langfuse.ts:41-50,90`, `leaguepedia.ts:25,32`, `riot.ts:190`, `pull.ts:35-45`, `storage/index.ts:174-198`, `db/index.ts:11`, `scope.ts:24`).

**Proposition** : un test qui extrait les `process.env.X` du code et vérifie que chaque nom figure dans `.env.example`. Un module `env.ts` central ne vaut pas la peine pour 20 variables.

### S7. Prompts (P3, S)

Cinq prompts en ligne : `understand.ts:681`, `query.ts:547` (`SQL_RULES`), `query.ts:628` (`UNREAD_RULES`), `query.ts:652`, `run.ts:341`. Ils ne sont pas dupliqués. Leur lien caché est avec les données : `SQL_RULES` décrit des colonnes et la liste des rôles à la main (voir S2, S5a, S5e). Les `functionId` (`extract-entities`, `pick-tool`, `generate-sql`, `repair-sql`, `write-summary`) sont recopiés dans `docs/deploy.md:417` et ciblés par les filtres Langfuse : les regrouper dans une constante à côté de `STEP_SPANS` (`trace.ts:32`).

### S8. Attentes de l'eval et documentation (P2, S)

- `README.md:247` annonce 92 questions ; `eval/questions.json` en contient 109.
- `README.md:269` dit que les valeurs attendues viennent du « schéma v3 » ; le `$comment` du fichier dit v5.
- `AGENTS.md` (Decisions) : « The POC on `main` […] still runs LangGraph with Anthropic/OpenAI providers ». Faux depuis `e3fe6fb` : aucune trace de LangGraph dans le dépôt.
- `scripts/data/fetch.ts:17` parle de 15 000 parties, `AGENTS.md:35` et `data-release.yml:12` de 28 000, `deploy.md:17` de 28 327.
- `docs/deploy.md:235-254` (« Première release v4 », « Première release v5 ») décrit des amorçages terminés.
- `scripts/eval.ts:40` accepte `route: z.string()` : une faute de frappe dans une attente donne un échec au lieu d'une erreur de schéma. Utiliser l'union de `AnswerMeta["route"]`.
- Les valeurs de `totals.timeline` (`ok`, `absent`, `no_such_game`, `missing`, `unconfigured`, `error`) sont des chaînes libres en `tools.ts:1638-1691`, attendues telles quelles par l'eval.

README a changé dans 10 commits sur 15 et `AGENTS.md` dans 9 : la doc recopie des faits que le code porte déjà. Remplacer chaque chiffre par un renvoi au fichier source.

---

## 2. Machines à états implicites

### M1. Cycle d'une question côté navigateur (P2, S)

**États réels** : `useChat.status` (`ready`, `submitted`, `streaming`, `error`) × parties reçues (`data-trace`, quatre `data-step`, `data-answer`) × `error`. Tout est recalculé à chaque rendu (`agent-console.tsx:113-125`).

**Transitions** : `ask` → `submitted` → `streaming` → `ready` ; `stop()` ou erreur à tout moment ; `restart` vide tout.

**États illégaux atteignables** :

- Une étape reste en `running` après `stop()` ou une erreur de flux. `Steps` lit `part.state` sans regarder `running` (`agent-console.tsx:224`) : l'étape clignote indéfiniment à côté du message d'erreur.
- `answer` et `error` peuvent être affichés ensemble (`:185-190`) si le flux casse après `data-answer`.
- La question est tronquée à 500 caractères côté serveur (`route.ts:63`) sans `maxLength` sur le champ : la question affichée n'est pas celle qui a été traitée.

**Modèle proposé** :

```ts
type Run =
  | { kind: "idle" }
  | { kind: "running"; question: string; steps: StepPart[] }
  | { kind: "answered"; question: string; steps: StepPart[]; answer: Answer; traceId: string | null }
  | { kind: "failed"; question: string; steps: StepPart[]; message: string };
```

Une fonction pure `runOf(messages, status, error)` produit cet état. Dans `failed`, les étapes encore `running` sont rendues « interrompue ».

### M2. Cycle d'une question côté API (P2, S à M)

**États** : `403 bot` | `400 invalide` | flux : `start` → `data-trace`? → `data-step`* → `data-answer` → `finish`, ou erreur de flux.

**Transitions illégales possibles** :

- **Le client part, l'agent continue.** `runAgent` ne reçoit pas `req.signal` (`route.ts:80`). Après un `stop()` du navigateur, jusqu'à cinq appels OpenRouter se poursuivent sur la clé plafonnée. Effort S : passer un `AbortSignal` et le combiner aux `AbortSignal.timeout` des appels (`understand.ts:688`, `query.ts:589,662`, `run.ts:349`).
- **Une étape n'est jamais fermée si elle lève.** `Step` (`run.ts:33`) n'a pas de `finally`. Un `ZodError` dans `plan.tool.format` (`run.ts:498`) laisse `format` en `running` et le flux se termine en erreur générique.
- Le plafond de débit par IP, exigé par `AGENTS.md`, n'existe que dans le tableau de bord Vercel (`docs/deploy.md:340`). Le dépôt ne peut ni le prouver ni le rejouer.

### M3. Étapes et tentatives du pipeline (P2, M)

**États** : `understand` → `build` → `execute` (tentatives 1 à 3) → `format`. Les quatre étapes sont toujours émises.

L'issue d'une question a six formes, mais aucun type ne les nomme. Elle est recalculée à partir de `route.kind`, `plan`, `rows.length` et de deux tableaux mutés par référence (`notes`, `missing`, `run.ts:148,256,410`) :

| Lieu | Calcul |
|---|---|
| `run.ts:428` | `meta.route`, chaîne de quatre opérateurs |
| `run.ts:442,459,477` | trois branches de `format` |
| `run.ts:364-387` | `emptySummary` |
| `trace.ts:189-203` | `outcomeTags`, dont `no-query = !queried && route ≠ …` |

**États illégaux représentables** :

- `QueryPlan` porte `intent` et `tool` (`types.ts:129`), redondants : `intent === tool?.call.tool ?? "sql"`. Rien n'empêche `intent: "sql"` avec un `tool`. `sql` et `params` sont copiés depuis `tool` par `toolPlan` (`query.ts:535`).
- `StepPart` a `state` et `status` (`types.ts:50`) : `status` vaut `"ok"` tant que l'étape tourne.
- `execute` renvoie `{ rows: [], plan }` aussi bien pour un résultat vide que pour trois rejets du garde ou trois erreurs SQLite (`run.ts:270-282`). `format` ne voit que `!raw.length` (`run.ts:459`) et répond « Aucun résultat pour X dans la base » (`run.ts:386`). **L'affirmation est fausse** : la base n'a pas été lue.
- `leaderboardMetric` remplace en silence une métrique invalide pour le sujet par `first_blood` ou `solo_kills` (`tools.ts:1168,1173`).
- `describeLlmError` (`llm.ts:74`) modifie l'état global `exhaustedUntil` alors que son nom annonce une description. `llmStatus()` est relu à cinq moments (`run.ts:169,373,429,583`, `trace.ts:199`) et peut changer entre deux lectures de la même question.

**Modèle proposé** :

```ts
type QueryPlan =
  | { kind: "tool"; tool: BoundTool; attempt: number; relaxed: string[] }
  | { kind: "sql"; sql: string; attempt: number };

type Outcome =
  | { kind: "out_of_scope"; reason: string }
  | { kind: "missing_data"; concepts: string[]; coverage: boolean }
  | { kind: "no_query"; reason: string; llm: LlmStatus }
  | { kind: "empty"; plan: QueryPlan }
  | { kind: "failed"; plan: QueryPlan; problem: Problem }
  | { kind: "rows"; plan: QueryPlan; rows: SqlRow[] };

type StepPart =
  | { step: StepName; state: "running"; title: string; entries: TraceEntry[] }
  | { step: StepName; state: "done"; status: TraceStatus; title: string; entries: TraceEntry[] };

type LeaderboardInput =
  | { subject: "player"; metric: PlayerMetric; role: Role | null; … }
  | { subject: "team"; metric: TeamMetric; … };
```

`build` renvoie un `Outcome` partiel au lieu de `null` plus deux effets de bord. `format`, `meta.route`, les tags Langfuse et l'eval font un `switch` exhaustif sur `outcome.kind`. Le cas `failed` reçoit sa propre phrase.

### M4. Session Langfuse, conversation et avis (P3, S)

**Conversation** : `sessionId` passe de `null` à un UUID au premier `ask`, revient à `null` sur « nouvelle conversation » (`agent-console.tsx:85,102,110`). Chaque `ask` vide les messages : la « conversation » est une suite de questions indépendantes, ce qui est voulu. Rien d'illégal.

**Trace** : désactivée | active et échantillonnée | active et non échantillonnée. `traceId` vaut `null` hors du deuxième cas (`trace.ts:258`), et les pouces ne s'affichent pas. Correct.

**Avis** : `sent ∈ {null, up, down}` × `state ∈ {idle, sending, failed}` (`agent-console.tsx:325-326`), soit neuf combinaisons dont quatre ont un sens. Défaut : après un premier avis enregistré, un second clic qui échoue remet `sent` à `null` (`:338`), alors que Langfuse garde le premier.

```ts
type FeedbackState =
  | { kind: "idle"; recorded: Rating | null }
  | { kind: "sending"; rating: Rating; recorded: Rating | null }
  | { kind: "failed"; recorded: Rating | null };
```

Côté serveur, `/api/feedback` accepte tout identifiant de 32 chiffres hexadécimaux sans vérifier que la trace existe (`feedback/route.ts:7`). L'identifiant n'est pas devinable : ne vaut pas la peine.

### M5. Pipeline de release (P2, S)

**États** : tag choisi → résumés restaurés ou non → fetch → build → contrôles → question de référence → publiée → anciennes supprimées → déployée (sur `main`).

**Transitions à risque** :

| Transition | Aujourd'hui | Lieu |
|---|---|---|
| Publiée, suppression des anciennes en échec | Le job `deploy` est sauté, la release reste la plus récente et sera prise au prochain push. Documenté, mais l'état « publiée, non déployée » n'apparaît nulle part | `data-release.yml:124-145` |
| Changement de `DERIVE_VERSION` avec budget wiki épuisé | `data:build` insère toute ligne `status: "ok"` sans lire `line.derive` : la base mélange deux définitions | `build.ts:494-498`, `riot.ts:300` |
| Changement de schéma avec ingestion Riot partielle | Le contrôle « au moins 98 % des parties in-game » est neutralisé : `previousIngame` vaut 0 quand les versions diffèrent | `package.ts:161-164` |
| Code avancé pendant les 2 h 30 du run | Le déploiement prend la pointe de `main` ; si `SCHEMA_VERSION` a changé, `data:pull` échoue et le contrôle du tag aussi. Bruyant, donc correct | `deploy.yml:54-56,86` |
| Deux déploiements en file | GitHub ne garde qu'un job en attente par groupe : le déploiement d'une release peut être annulé par un push plus récent. Sans conséquence, le suivant prend la même release | `deploy.yml:44-46` |
| Tag déjà pris | Boucle `-2`, `-3` et groupe de concurrence : correct | `data-release.yml:67-73` |

**Modèle proposé** : pas de machine à états, deux gardes.

1. `data:build` compte les lignes dont `derive !== DERIVE_VERSION` dans `ingest_runs.details` ; `data:package` refuse si ce compte dépasse zéro, et le manifeste gagne `derive_version`.
2. `data:package` compare le nombre de parties in-game à la release précédente quelle que soit la version du schéma, avec un drapeau explicite `--allow-ingame-drop` pour l'amorçage.

### M6. `data:pull` et choix de la release au build (P2, S)

**Entrées** : base locale (absente, inutilisable, utilisable) × Vercel × jeton × release épinglée × `--force`.

**Décisions** : garder la base locale, échouer, ou résoudre une release puis garder (même sha256) ou installer.

Le code les exprime par trois `if` qui se recouvrent (`pull.ts:238,245,251`), puis un quatrième après l'appel réseau (`:261`). Points faibles :

- `usabilityProblems` (`artifact.ts:147`) ne lit que `user_version` et le mode de journal. Une base locale à la bonne version mais à l'ancien DDL est acceptée.
- Hors Vercel, une base locale utilisable est gardée indéfiniment, même vieille de plusieurs mois. Le message le dit, sans donner l'âge.
- Aucun test, alors que c'est le point de passage obligé de chaque build de production.

**Modèle proposé** :

```ts
type PullPlan =
  | { kind: "keep_local"; reason: "offline_build" | "no_token" }
  | { kind: "fail"; message: string }
  | { kind: "resolve"; pinned: string | null };

function planPull(facts: { local: "absent" | "unusable" | "usable"; onVercel: boolean; token: boolean; pinned: string | null; force: boolean }): PullPlan
```

Fonction pure, testée sur ses douze combinaisons utiles. `install` (`pull.ts:179`) est déjà atomique et vérifié : ne rien y changer.

---

## 3. Invariants supposés mais non imposés

### I1. Chiffres de la synthèse LLM (P1, S)

**Supposé en** : `run.ts:313-321` (`claimsBeyondFacts`), appelé en `run.ts:355`.

**Règle actuelle** : tout nombre de la phrase doit figurer parmi les nombres des faits ; sept mots de période sont interdits s'ils sont absents des faits.

**Contre-exemples**, sur des faits réalistes de `team_ingame_stats` :

| Phrase du modèle | Verdict |
|---|---|
| first blood 61.2 % et première tourelle 55.3 % (valeurs échangées) | acceptée |
| « T1 a gagné 120 parties sur 80 » (termes inversés) | acceptée |
| « Gen.G a pris le first blood… » (autre équipe) | acceptée |
| « plus de deux parties sur trois » (nombre en lettres) | acceptée |
| « T1 est la meilleure équipe de LCK au first blood » | acceptée |
| « T1 prend le 1er dragon… » | acceptée, parce que « T1 » met « 1 » dans les nombres connus |
| « 55,3 % » (virgule française) | rejetée à tort |

Deux causes : la règle teste l'appartenance à un ensemble et non la position, et la regex `\d+(?:[.,]\d+)?` (`run.ts:304`) n'a pas de frontière de mot, donc « T1 », « G2 », « C9 » et « 100 Thieves » ajoutent 1, 2, 9 et 100 aux nombres permis.

Je n'ai pas retrouvé dans l'historique un commit nommé « first blood ». Les deux correctifs proches sont `46d3a2d` (la saison inventée) et `c80fb1b` (donnée absente). Le premier tableau montre que la même classe de bug reste ouverte pour les métriques in-game.

**Imposer** :

1. Frontière de mot et normalisation de la virgule avant comparaison.
2. Égalité de multi-ensemble et ordre : la suite des nombres de la phrase doit être une sous-suite de celle des faits.
3. Tout mot capitalisé de la phrase doit figurer dans les faits ou la question.
4. Exporter la fonction et la tester avec le tableau ci-dessus.

Variante plus sûre, effort M : remplacer les nombres des faits par des jetons (`⟦1⟧`) avant l'appel et les réinjecter après, en exigeant chaque jeton une fois. Le modèle ne peut alors plus écrire de chiffre.

À décider par Enzo : le modèle de phrase a une confiance de 0,7 sous un seuil de 0,8 (`run.ts:326,503`). Avec une clé, chaque réponse d'outil paie donc un appel LLM pour reformuler une phrase déjà écrite.

### I2. Version de la base et code (P1, S)

**Supposé en** : `db/index.ts:25-35` (`openDb` ouvre sans rien vérifier), tous les schémas zod de `tools.ts`.

**Si violé** : avec `DATABASE_PATH` ou une base locale ancienne, soit un `ZodError` au milieu d'une réponse, soit pire, un routage dégradé sans bruit. `query.ts:301` (`schema.v_games?.includes("game_n")`) et `query.ts:309` (`schema.v_game_player_stats ?`) désactivent la timeline et l'in-game quand les colonnes manquent, et `DATA_CONCEPTS` (`query.ts:38-51`) transforme alors la question en « donnée absente ».

**Imposer** : `openDb` lit `PRAGMA user_version` et lève si elle diffère de `SCHEMA_VERSION` (déplacé dans `src/`, voir S2). Les deux conditions de `query.ts:301,309` et les cinq premières lignes de `DATA_CONCEPTS` deviennent du code mort à supprimer : en v5 leurs colonnes existent toujours.

### I3. Périodes à cheval sur un renommage de ligue (P1, M)

**Supposé en** : `understand.ts:567-577`. `eraLeague` ne regarde que `yearTo`.

**Contre-exemple mesuré** :

```
« Faker en LCS depuis 2015 »        -> League of Legends Championship Series, 2015–∅
« Faker en LCS entre 2016 et 2020 » -> League of Legends Championship Series, 2016–2020
« Faker en LCS en 2016 »            -> North America League Championship Series, 2016–2016
```

Les deux premières ne lisent que la LCS 2019+. Les années 2015 à 2018 (NA LCS) manquent, sans note. Même effet pour « LEC depuis 2016 » et « LCK 2014-2020 ».

**Imposer** : la notion de famille de ligues dans le module canonique (S1) : `{ family: "LCS", members: [{ name: "North America League…", to: 2018 }, { name: "League of Legends Championship Series", from: 2019 }] }`. Le filtre devient `league IN (…)` pour les membres que la période recoupe, avec `inList` qui existe déjà (`tools.ts:214`). Une note signale la fusion. Trois cas d'eval à ajouter.

### I4. Bornes d'années (P2, S)

**Supposé en** : `understand.ts:114` lit 2010 à 2039 ; `tools.ts:50` accepte 2011 à 2030.

**Contre-exemple mesuré** : « Faker aux Worlds 2010 » et « … 2031 » routent vers `player_event_history`, puis `PlayerHistoryInput.parse` lève dans `bindTool`. `decide` avale l'erreur (`decide.ts:57`). Sans clé, la réponse est « Aucun outil typé ne couvre cette question ». En 2031 toute question datée de l'année en cours échouera ainsi.

**Imposer** : `YEAR_MIN = 2011` et une borne haute calculée depuis `now`. Une année hors bornes donne une réponse dédiée (« la base commence en 2011 ») au lieu d'une exception avalée.

Lié : l'année d'une partie est celle du tournoi (`tournaments.year`, `build.ts:196-206`), et « cette saison » vaut `now.getUTCFullYear()` (`understand.ts:542`). Un tournoi à cheval sur deux années civiles est classé dans la première. Acceptable, à documenter dans `SQL_RULES`.

### I5. Lecture seule, une instruction, liste blanche, `LIMIT` (P2, M)

**Imposé aujourd'hui** : base ouverte en lecture seule (`db/index.ts:29`), contrôle statique, `authorizer` SQLite, enveloppe `LIMIT` (`guard.ts:113`).

**Mesuré** : rejetés comme attendu : table de base directe, jointure par virgule sur une table de base (avec ou sans colonne), sous-requête sur `ingest_runs`, `sqlite_master`, identifiant entre guillemets, `pragma_table_info`, deux instructions, écriture. Le garde tient.

**Failles restantes** :

| Cas | Verdict | Conséquence |
|---|---|---|
| `SELECT COUNT(*) FROM v_game_players a, v_game_players b, v_game_players c` | accepté | Produit cartésien. `node:sqlite` est synchrone : l'instance est bloquée jusqu'aux 90 s de `maxDuration`, pour toutes les requêtes concurrentes |
| `SELECT REPLACE(player, 'a', 'b') …` | rejeté à tort (`FORBIDDEN`, `guard.ts:36`) | Coûte une tentative de réparation |
| `SELECT patch AS release …` | rejeté à tort | idem |
| `WITH c(x) AS (…)` | rejeté à tort (`guard.ts:73` ne lit pas la liste de colonnes) | idem ; rejette aussi `WITH RECURSIVE`, ce qui protège par accident |

Le commentaire `guard.ts:4` dit « appliqué à toute requête ». Les requêtes secondaires des outils (`tools.ts:1097,1243,1244,1249,1354`), de `understand.ts` et de `coverageLookup` ne passent pas par le garde. Elles sont écrites par l'application et paramétrées, donc sûres : c'est le commentaire qu'il faut corriger.

**Imposer** :

1. Des tests du garde sur une base en mémoire (rendus possibles par S2). Les 17 cas de cet audit en sont la première table.
2. Refuser explicitement `SQLITE_RECURSIVE` pour le SQL généré (`guard.ts:119`) au lieu de compter sur la regex.
3. Borner le coût : refuser plus de deux références à une vue `v_game_*` sans `JOIN … ON` ou `USING`. La solution complète (thread dédié et délai) ne vaut pas la peine ici.
4. Retirer `replace` et `release` de `FORBIDDEN` : l'`authorizer` refuse déjà toute action autre que lecture, fonction et sélection (`guard.ts:122-126`).

### I6. Unicité et canonicité des joueurs (P2, S)

**Imposé** : `players.page UNIQUE` (`build.ts:74`), fusion par `canonical()` (`identity.ts:38`), testée unitairement.

**Supposé sans contrôle** :

- `players.page` est une page Leaguepedia. Faux pour les liens `unknown`, `ambiguous` et `same_game` (`build.ts:353-354`) : la page vaut alors le lien brut, et `wikiUrl(player)` cite une page qui peut ne pas exister (`tools.ts:1138`).
- Les compteurs `identity` (`build.ts:315`) vont dans `ingest_runs.details` et dans la console. `data:package` ne les lit pas.
- `INSERT OR IGNORE` sur `game_players`, `game_player_items`, `game_draft`, `tournament_results`, `game_player_stats`, `game_team_stats` (`build.ts:236,257,318,319,487,488`) : une ligne en double est perdue sans être comptée.
- Aucune clé étrangère n'est déclarée sauf `tournaments.league_id` et `PRAGMA foreign_keys` n'est jamais activé. Le `foreign_key_check` de `package.ts:134` ne peut donc rien trouver. Les dix requêtes `ORPHANS` (`package.ts:61`) font le vrai travail.

**Imposer** :

1. `data:package` compare `identity.unknown + identity.ambiguous` à la release précédente et refuse une hausse au-delà d'un seuil.
2. Une liste d'identités de référence vérifiée dans `data:package` : `caPs` et `Caps` distincts, `ZionSpartan` → `Darshan`, `정지훈` → `Chovy`. L'eval en couvre sept (tag `identity`), mais après publication.
3. Compter les `changes` des `INSERT OR IGNORE` et les ajouter à `skipped`.
4. Supprimer `foreign_key_check` ou déclarer les clés.

### I7. Noms d'équipes et de joueurs écrits à la main (P2, S)

**Supposé en** : `NICKNAMES` (`understand.ts:156`), `FRANCHISES` (`:294`), `TEAM_SHORTHANDS` (`:304`), `CHAMPION_SHORTHANDS` (`:336`), `PHASE_SQL` et `TAB_LABELS` (`tools.ts:1385,1403`).

**Si violé** : `if (gamesOf.has(name))` (`understand.ts:395`) retire en silence un raccourci dont l'équipe a été renommée sur le wiki. « KDF » ou « BRO » cessent de marcher sans erreur. Un onglet de finale nommé autrement que `'Finals'` vide la requête, puis la relaxation retire la phase et montre une autre partie.

**Imposer** : `data:package` avertit pour chaque nom écrit à la main absent de `teams`, `players` ou `champions`, et pour chaque valeur de `games.tab` hors de `TAB_LABELS`. Ces dictionnaires vont dans `src/lib/domain/` à côté des ligues.

À ne pas faire dans cette MR : la canonicité des équipes par `TeamRedirects`, comme pour les joueurs. C'est une fonctionnalité, effort L.

### I8. Ordre des règles du routeur (P2, M)

**Supposé en** : `routeByRules` (`query.ts:292-401`), 14 `if` ordonnés ; `LEAGUE_CUES` (`understand.ts:24`, « LCK CL » avant « LCK ») ; `CUES` (`metrics.ts:118`, « most specific first ») ; `PHASES` (`query.ts:230`) ; `ROLE_CUES` (`roles.ts:6`).

**Si violé** : un routage différent, sans erreur. Seul l'eval le voit, et il ne tourne en CI que sur une question (`data-release.yml:108`).

**Imposer** :

1. Pour les listes de motifs : choisir la correspondance la plus longue au lieu de la première. L'ordre cesse d'être une convention.
2. Pour `routeByRules` : un test table (question, entités fabriquées, route attendue) qui tourne sans base, la couverture étant un paramètre (`CoverageLookup`).
3. Lancer `bun run eval --deterministic --strict` dans la CI des PR avec la release courante. Il faut `DATA_GITHUB_TOKEN` en secret de CI ; les six cas de timeline demandent R2 et sont à exclure par tag.

### I9. Fuseaux horaires (P3, S)

`games.played_at` suppose que `DateTime_UTC` est en UTC (`build.ts:276`). Le champ n'est utilisé que pour trier (`tools.ts:1053,1216,1577`) et aucune date n'est affichée. Pas de risque aujourd'hui. Si une date est affichée un jour, la formater en UTC explicitement.

### I10. Dénominateur du taux de first blood d'un joueur (P3, S)

`tools.ts:1108` divise par `total.games` (toutes les parties avec données Riot). Le classement divise par `COUNT(colonne)` (`tools.ts:1217`). Si une partie a un drapeau `first_blood_kill` nul, les deux outils donnent des taux différents pour le même joueur. Aligner sur `COUNT(colonne)`.

### I11. Unicité des tags et idempotence des workflows (P3, S)

- Unicité : imposée par GitHub, la boucle de suffixe et le groupe de concurrence. Correct.
- `data:fetch` est reprenable, `data:build` repart de zéro, la suppression des anciennes releases est idempotente, le déploiement aussi.
- La publication n'est pas idempotente par construction : relancer un run publie `-2` avec les mêmes données. Acceptable.
- `manifest.tag` n'est validé que par son préfixe (`artifact.ts:32`). Une regex `^data-\d{8}(-\d+)?$` coûte une ligne.

### I12. Vie privée des traces (P3, vérifié)

`MaskingSpanProcessor` (`langfuse.ts:60`) masque tout attribut texte, et `scripts/tracing.test.ts` le teste (11 cas). L'invariant « ni IP ni cookie » tient parce que le fournisseur de traces n'est pas global (`langfuse.ts:9-11`). Rien à faire.

---

## 4. Méthode `untangle-codebase`

Question posée à chaque morceau : ces pièces doivent-elles changer ensemble ?

### Preuves git

Sur 15 commits : `query.ts` + `understand.ts` 8 fois, `query.ts` + `types.ts` 8 fois, `README.md` + `query.ts` 7 fois, `eval/questions.json` + `query.ts` 6 fois sur 6. Les fichiers les plus modifiés sont `README.md` (10), `query.ts` (9), `AGENTS.md` (9).

### Graphe d'imports

- `scripts/` importe `src/lib/`, jamais l'inverse : la direction est saine.
- `src/lib/agent/types.ts` importe `tools.ts` et `decide.ts`, qui importent `types.ts` : cycle de types.
- `tools.ts` importe `understand.ts` (résolution de noms) et `query.ts` importe les deux.
- `src/lib/tracing/langfuse.ts` importe `agent/trace.ts`, qui importe `tracing/mask.ts` : les deux dossiers dépendent l'un de l'autre.

### Journal de décision : chaque correctif au-dessus des problèmes qu'il résout

- **Mettre le domaine dans `src/lib/domain/` (ligues avec article, famille et motif ; rôles ; stades ; splits ; dictionnaires d'équipes), importé par l'app et par les scripts.**
  - `types.ts:12` recopie les noms de `scope.ts:63`.
  - `understand.ts:567` code les renommages de ligues en dur et tronque les périodes (I3).
  - Huit `=== "Worlds"` pour l'accord français (S1).
  - `query.ts:285,389` et `tools.ts:564` nomment Worlds et MSI en dur.
  - `run.ts:367` et `query.ts:294` récitent le périmètre.
  - Rôles, stades et splits définis trois à cinq fois (S5a-c).
  - Les raccourcis d'équipes sont au milieu de `understand.ts`, sans contrôle (I7).

- **Mettre le schéma dans `src/lib/db/schema.ts` : version, DDL, listes dérivées, vérification à l'ouverture.**
  - `REQUIRED`, `TABLES`, `VIEWS` recopient le DDL (S2).
  - Insertions positionnelles avec le nombre de colonnes en dur.
  - `openDb` ne vérifie rien (I2).
  - `query.ts:301,309` et cinq lignes de `DATA_CONCEPTS` : cas particuliers pour des schémas anciens.
  - Le garde n'est pas testable sans base (I5).
  - `artifact.ts:105` (`schemaVersion >= 4`) et les champs optionnels « absent avant v4 » du manifeste (`artifact.ts:53,56-58`).

- **Un registre d'outils et un registre de métriques, chacun source de tout ce qui parle de l'outil ou de la métrique.**
  - Neuf endroits par outil (S3), deux `switch` de neuf cas identiques.
  - Une dizaine d'endroits par métrique (S4).
  - `leaderboardMetric` avec repli silencieux (M3).
  - Trois définitions de l'aide regex « mot entier » (S5g).
  - `tools.ts` fait 1 838 lignes : neuf outils, leur formatage et le registre. Un fichier par outil sous `agent/tools/`.

- **Un type `Outcome` et un `QueryPlan` en union discriminée ; `build` et `execute` renvoient une valeur au lieu de muter `notes` et `missing`.**
  - L'issue est recalculée à quatre endroits (M3).
  - Un échec d'exécution est présenté comme un résultat vide.
  - `intent` et `tool` redondants, `sql` et `params` copiés.
  - `StepPart.status` sans sens pendant `running` ; étape jamais fermée sur exception.
  - `scripts/eval.ts:40` accepte n'importe quelle chaîne comme route.

- **Faire porter les contrats du pipeline de release par des fichiers, pas par des chaînes.**
  - Noms d'assets et préfixe en dur dans le YAML (S5k).
  - `deploy.yml:84` lit une ligne de log (S5l).
  - Les compteurs `identity` et `ingame` restent dans la console (I6, M5).

- **Une CI sur les PR qui lance lint, typecheck, tests et l'eval déterministe.**
  - Aucun workflow `pull_request`.
  - Garde, routeur, synthèse et `planPull` sans test.
  - Les tests de `src/` vivent dans `scripts/` (`scripts/timeline.test.ts`, `scripts/tracing.test.ts`) parce que `package.json:23` lance `bun test scripts`. Passer à `bun test` et ranger chaque test à côté de son fichier.

### Surplus

| Élément | Lieu | Verdict |
|---|---|---|
| `fetchChampions`, `DdragonChampion` | `src/lib/sources/ddragon.ts:6-33` | Code mort depuis le POC ; seul `DDRAGON_BASE` est utilisé |
| Niveau de décision `"model"` | `decide.ts:18` et son commentaire `:7-8` | Réservé, aucun décideur ne l'utilise |
| `game_riot.json_version` | `build.ts:95` | Colonne lue par aucune vue ni aucun outil, contraire à la règle d'`AGENTS.md` |
| Mode `--incremental` de `data:fetch` | `fetch.ts:369-475`, 107 lignes | Le workflow ne l'utilise pas ; cité seulement dans `README.md:64`. À supprimer ou à garder en connaissance de cause |
| Compatibilité v3 / v4 | `artifact.ts:53,56,105`, `deploy.md:235-254` | Les quatre releases gardées sont en v5 |
| `PRAGMA foreign_key_check` | `package.ts:134` | Ne peut rien détecter (I6) |
| `DATA_CONCEPTS`, lignes 1 à 5 | `query.ts:39-48` | Colonnes présentes en v5 : jamais déclenchées |

### Cas particuliers recensés

| Cas | Lieu | Sort |
|---|---|---|
| `mention === "Vi"` | `understand.ts:474` | Garder : champion de deux lettres, exception au seuil de trois |
| `Nunu`, `Wukong` → `MonkeyKing` | `build.ts:431` | Garder : écart Leaguepedia / Data Dragon, documenté |
| `"None"`, `"Loss of Ban"` | `build.ts:283` | Garder |
| `&amp;` dans un nom de champion | `understand.ts:406` | Symptôme : une entité HTML non décodée à l'ingestion. Corriger dans `leaguepedia.ts:44`, qui décode déjà `&amp;` pour d'autres champs, puis supprimer |
| Huit `=== "Worlds"` | voir S1 | Disparaissent avec le module de ligues |
| `?? "first_blood"`, `?? "solo_kills"` | `tools.ts:1168,1173` | Disparaissent avec l'union `LeaderboardInput` |
| `schema.v_games?.includes("game_n")` | `query.ts:301` | Disparaît avec la vérification de version |
| `catch {}` du cache | `timelines.ts:84,93` | Garder : une panne du cache ne doit coûter qu'une lecture |
| `catch {}` de ligne illisible | `riot.ts:108,184` | Garder, c'est compté et affiché |
| Pause de 5 minutes sur panne du wiki | `riot.ts:377` | Garder : contrainte externe |
| Test désactivé | aucun | — |

---

## 5. Une seule MR de nettoyage : liste ordonnée

L'ordre suit les dépendances : chaque étape rend la suivante plus simple ou la protège.

### Vaut la peine

| # | Changement | Constats | Eff. |
|---|---|---|---|
| 1 | `.github/workflows/ci.yml` sur `pull_request` : lint, typecheck, `bun test`. `deploy.yml` appelle ce workflow au lieu de répéter les trois étapes | CI | S |
| 2 | `src/lib/db/schema.ts` : `SCHEMA_VERSION`, `createSchema`, listes dérivées, insertions nommées. `openDb` vérifie `user_version`. Test d'empreinte du DDL | S2, I2 | M |
| 3 | Supprimer le code rendu mort par 2 : `query.ts:301,309`, cinq lignes de `DATA_CONCEPTS`, compatibilité v3/v4 du manifeste | I2, surplus | S |
| 4 | `src/lib/domain/` : ligues (article, motif, famille), rôles, stades, splits, dictionnaires d'équipes. Filtre `league IN (…)` pour les familles | S1, S5a-c, I3, I7 | M |
| 5 | Bornes d'années uniques, réponse dédiée hors bornes | S5d, I4 | S |
| 6 | `claimsBeyondFacts` : frontière de mot, virgule, ordre des nombres, noms propres ; exportée et testée | I1 | S |
| 7 | `Outcome`, `QueryPlan` et `StepPart` en unions ; phrase propre à l'échec d'exécution ; `try/finally` autour des étapes | M3, M2 | M |
| 8 | Tests sans base : garde (17 cas), routeur (table), `planPull` | I5, I8, M6 | M |
| 9 | Garde : refuser `SQLITE_RECURSIVE`, borner les jointures croisées, lire `WITH c(x)`, retirer `replace` et `release` de `FORBIDDEN`, corriger le commentaire | I5 | S |
| 10 | Registre d'outils, un fichier par outil ; `LeaderboardInput` en union | S3, M3 | M |
| 11 | Registre de métriques : libellés, phrase et motif dans `MetricDef` ; description dérivée | S4 | M |
| 12 | `data:build` compte les résumés d'une autre `DERIVE_VERSION` ; `data:package` les refuse, compare l'in-game à toute release précédente, lit les compteurs `identity`, vérifie les noms écrits à la main | M5, I6, I7 | S |
| 13 | `req.signal` propagé jusqu'aux appels LLM | M2 | S |
| 14 | Front : étape interrompue après `stop()` ou erreur, `maxLength={500}`, `FeedbackState` en union | M1, M4 | S |
| 15 | Contrats de release par fichier : `release-meta` lu par le YAML, tag retenu écrit par `data:pull` | S5k, S5l | S |
| 16 | Test « toute variable lue figure dans `.env.example` » ; ajouter `LANGFUSE_TRACING_ENVIRONMENT` | S6 | S |
| 17 | Seuils de confiance nommés ; aide regex unique ; exemples partagés ; `MAX_ROWS` interpolé | S5e-g, S5i | S |
| 18 | Supprimer `fetchChampions`, le niveau `"model"`, `json_version`, `foreign_key_check` | surplus | S |
| 19 | Doc : 92 → 109, v3 → v5, phrase LangGraph d'`AGENTS.md`, 15 000 → 28 000, sections d'amorçage v4/v5 ; remplacer les chiffres recopiés par des renvois | S8 | S |
| 20 | Eval déterministe en CI des PR, timelines exclues | I8 | S |

Les étapes 1 à 9 forment le cœur. Si la MR devient trop grosse à relire, couper après 9 : le reste (10 à 20) ne change aucun comportement visible.

Les étapes 1 et 20 modifient la CI et l'étape 8 ajoute des tests côté serveur : elles demandent l'accord explicite d'Enzo, la règle par défaut étant de ne pas toucher la CI.

### Ne vaut pas la peine pour un projet portfolio

| Idée | Raison |
|---|---|
| Générer les types de lignes depuis le SQL (Kysely, Drizzle, codegen) | Les schémas zod par outil valident déjà à la frontière ; une dépendance de plus pour neuf requêtes |
| Canonicité des équipes par `TeamRedirects` | Fonctionnalité, effort L. Garder `FRANCHISES` avec le contrôle de l'étape 12 |
| Exécuter le SQL généré dans un thread avec délai | L'étape 9 ferme le cas mesuré ; le SQL vient du modèle, pas du visiteur |
| Bibliothèque de machines à états (XState) | Les unions discriminées suffisent pour six états |
| Module `env.ts` central validé par zod | 20 variables, toutes facultatives ; le test de l'étape 16 couvre le risque réel |
| Plafond de débit décrit en code | Réglé une fois dans le tableau de bord, documenté dans `deploy.md:340` |
| Vérifier que la trace existe avant d'enregistrer un avis | Identifiant de 128 bits, non devinable |
| Réorganiser `src/lib` par domaine | Le registre d'outils (étape 10) règle le seul fichier trop gros |
| Mode `--incremental` | À trancher par Enzo : 107 lignes non utilisées par le workflow, mais utiles en local |
| État global `exhaustedUntil` par instance | Suffisant sur Fluid Compute ; un quota partagé demanderait un stockage externe |
| Supprimer la synthèse LLM | Décision de produit, pas de nettoyage (voir I1) |

---

## 6. Ce qui n'a pas pu être vérifié

- **Aucune base réelle.** Le worktree n'a pas de `data/`, et la base du dépôt principal est un fichier de 5 Mo du POC, en mode WAL. Les preuves viennent d'une base en mémoire de quelques lignes : l'eval n'a pas été lancé, et les tailles, la couverture in-game et les compteurs `identity` n'ont pas été mesurés.
- **Aucun appel LLM.** Les chemins `llmRouter`, text-to-SQL, réparation et synthèse sont audités à la lecture. Les phrases du tableau I1 sont écrites à la main, pas produites par le modèle.
- **Le « bug du first blood »** n'est pas identifiable dans l'historique git ni dans Notion. I1 et I10 décrivent les deux défauts trouvés autour du first blood ; je ne peux pas affirmer que l'un d'eux est celui auquel la demande pense.
- **Configuration hors dépôt** : règle de plafond de débit du firewall Vercel, BotID, variables du projet Vercel, secrets GitHub, contenu du bucket R2, filtres Langfuse. Rien de cela n'a été consulté.
- **Workflows** : lus, pas exécutés. Le comportement de la file de concurrence (M5) vient de la documentation de GitHub, pas d'un essai.
- **`node:sqlite` sous Node 24 sur Vercel** : les essais du garde ont tourné sous Bun 1.4.4. Le comportement de l'`authorizer` y est supposé identique.
- **Interface** : aucune capture. L'étape figée en `running` après `stop()` (M1) est déduite du code.
- **`tools/oxlint/`**, `src/app/game-timeline.tsx`, `src/lib/sources/timeline.ts` et `src/lib/storage/index.ts` n'ont été lus qu'en partie.
