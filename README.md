# Farsight

Un agent de recherche sur l’esport League of Legends (LoL), disponible sur [askfarsight.com](https://askfarsight.com).

Pose une question comme « Résultats de Chovy à tous les Worlds », « T1 contre Gen.G en LCK » ou « Qui prend le plus souvent le premier dragon au MSI 2023 ? ». L’interface montre quatre étapes : compréhension des noms et alias, construction d’une requête, exécution avec correction éventuelle, puis tableau triable, synthèse et liens vers les sources. Une timeline montre aussi l’or et les événements d’une partie lorsque la source existe.

## Stack

Next.js App Router et React, TypeScript, AI SDK 7 avec OpenRouter, SQLite en lecture seule et Node **26** sur Vercel. Bun gère les dépendances et les scripts locaux. Langfuse est facultatif ; Cloudflare R2 conserve les JSON Riot utilisés pour les timelines.

Les questions courantes passent par des outils SQL typés et paramétrés. Le modèle intervient lorsque les règles ne suffisent pas. Le SQL généré passe par une liste blanche de vues, un contrôle de lecture seule et une limite de lignes, puis tourne dans un processus isolé arrêté après quatre secondes. Les chaînes SQLite sont limitées à 1 Mo. Les réponses en erreur et les données absentes ont des messages distincts.

## Lancer en local

Installer la version de Bun indiquée dans `package.json`, Node 26 et `zstd`, puis :

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run data:pull
bun run dev
```

`data:pull` télécharge la base publiée dans les [releases](https://github.com/AzaWoodyy/farsight/releases) du dépôt, sans jeton. Un `DATA_GITHUB_TOKEN` sans aucune permission n’est utile que pour dépasser le quota anonyme de l’API GitHub (60 requêtes par heure et par IP). Il vérifie le manifeste, le SHA-256, la version du schéma et le mode de journal SQLite. Une base locale utilisable est conservée ; `--force` la remplace. `DATA_RELEASE` épingle une release particulière.

Sans clé OpenRouter, les outils déterministes restent utilisables et le secours text-to-SQL est explicitement indisponible. Pour activer le modèle, renseigner `OPENROUTER_API_KEY` avec une clé plafonnée ; `OPENROUTER_MODEL` peut remplacer le modèle par défaut. Les valeurs restent exclusivement dans `.env` et ne doivent pas être commitées.

Les variables facultatives et leur rôle sont dans [.env.example](.env.example). Les trois variables `LANGFUSE_*` de connexion activent le traçage ; `FEEDBACK_SECRET` (au moins 32 caractères aléatoires) active les avis signés. Les clés `R2_READ_*` sont les seules clés R2 utilisées par l’application ; les clés d’écriture sont réservées à l’ingestion.

## Données et sources

- [Leaguepedia](https://lol.fandom.com/wiki/League_of_Legends_Esports_Wiki) fournit tournois, scoreboards, joueurs, alias, classements et liens vers les JSON Riot, sous [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Les réponses citent les pages concernées. La base et les fixtures dérivées de Leaguepedia conservent cette attribution et cette licence.
- [Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon) fournit les noms et icônes des champions, objets et runes. League of Legends et ses éléments appartiennent à Riot Games ; ce projet indépendant n’est pas affilié à Riot Games.
- Le périmètre exact est défini dans [leagues.ts](src/lib/domain/leagues.ts) : Worlds et MSI, ligues majeures coréennes, chinoise, européenne et nord-américaines, ligues japonaise, pacifique, vietnamienne et brésilienne avec leurs successeurs (LCP, LTA South), plusieurs ligues de développement, France et deuxième division espagnole. Les périodes datées qui traversent un renommage incluent les noms historiques et affichent une note.

Une seule base versionnée est utilisée dans les environnements de déploiement. Le workflow hebdomadaire collecte les nouvelles données et publie une release. Pour reconstruire localement depuis les sources :

```sh
bun run data:fetch
bun run data:build
bun run data:package --tag=data-20000101
```

`data:fetch` respecte le throttle Leaguepedia et reprend depuis son cache. Le détail est dans [AGENTS.md](AGENTS.md) et [docs/deploy.md](docs/deploy.md). Un changement de schéma demande une reconstruction ; il n’y a pas de migration. Une modification des définitions in-game exige d’incrémenter `DERIVE_VERSION` et de recalculer les résumés. Le packaging refuse de mélanger plusieurs versions.

## Vérifier une modification

```sh
bun run verify
```

La commande lance dans l’ordre le lint, les types, les tests en ordre normal et aléatoire, l’eval déterministe hors timeline (après avoir récupéré la base si elle manque) et le build, et s’arrête au premier échec. Pour la lancer à chaque push : `git config core.hooksPath .githooks` (optionnel ; `git push --no-verify` le saute une fois).

Les tests sont côté serveur. L’interface se vérifie dans l’application. L’eval lit [eval/questions.json](eval/questions.json), avec une date figée et des attentes attachées au snapshot. Les cas qui nécessitent un modèle sont signalés comme non vérifiés en mode déterministe ; les timelines demandent le JSON local ou R2 et sont exclues de la CI sans secrets.

La CI des PR sélectionne les contrôles selon les fichiers modifiés, lance les commandes indépendantes avec deux workers et collecte chaque statut. Un chemin inconnu déclenche tous les contrôles de code. La reconstruction est réservée aux données, au schéma et à leurs dépendances ; les autres changements utilisent la base épinglée. Les changements d’ingestion reconstruisent et contrôlent la base hors réseau à partir du [snapshot épinglé](ci/data.json). Les contrôles de publication tournent sans compression en CI ; les archives zstd niveau 19 sont créées lors des releases de données. Le cache est revérifié après restauration ; les PR ne sauvegardent pas de cache partagé. La protection de branche doit rendre `PR checks` requis ; le workflow seul n’impose pas cette protection.

## Limites et confidentialité

La couverture dépend de Leaguepedia et n’est pas exhaustive ni en temps réel. Les statistiques in-game ne couvrent qu’une partie des matchs ; **aucune donnée Riot in-game n’est disponible pour la LPL** dans cette source. L’agent indique cette absence plutôt que de produire un chiffre. Les années antérieures à 2011 et les années futures reçoivent une réponse dédiée. Les noms homonymes peuvent nécessiter une précision et les filtres retirés lors d’une correction sont signalés.

Les questions peuvent être envoyées à OpenRouter et au fournisseur du modèle, et, si activé, à Langfuse. Le traçage masque certaines données personnelles courantes ; il ne faut pas saisir de renseignements sensibles. Aucun identifiant de visiteur ni IP n’est envoyé dans une trace. Les avis portent une signature expirante ; les compteurs de débit dans le code sont par instance et complètent les règles du pare-feu Vercel.

Les contrôles de taille gardent la base sous 190 Mo et la fonction sous 250 Mo non compressés. Les quotas Hobby et le plafond de clé peuvent rendre le modèle temporairement indisponible. Les synthèses chiffrées sont conservatrices : une reformulation qui ne préserve pas le texte des faits est remplacée par la phrase déterministe.

## Licence

Le code est sous licence [MIT](LICENSE). La base, les releases de données et les fixtures dérivées de Leaguepedia restent sous [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), avec attribution à Leaguepedia. Les noms et icônes de League of Legends appartiennent à Riot Games et ne sont pas couverts par ces licences.

## Audits

Les [audits](docs/audits/) et le [bilan des décisions](docs/audits/cleanup.md) consignent les correctifs, exclusions et vérifications. Le regroupement physique des objets par joueur reste une optimisation de taille possible, hors de ce nettoyage.
