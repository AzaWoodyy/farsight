# Nettoyage des audits — décisions et preuves

Les trois rapports voisins sont les originaux du 14 novembre 2026, conservés sans modification. Ce bilan décrit leur application ; les conclusions historiques ne sont pas des garanties nouvelles.

## Architecture : plan en vingt étapes

| Étape | Décision |
|---|---|
| 1, 20 — CI et eval | CI de PR et de main ; sélection conservatrice, deux workers, eval déterministe hors timeline, snapshot avec hashes, rebuild offline. Deploy attend le succès CI sur le SHA main courant. |
| 2 — contrat SQL | DDL/version partagés, insertions nommées, empreinte tables/vues par version, vérification à l’ouverture. Un index n’exige pas une nouvelle version. |
| 3 — compatibilité | Détections de colonnes v5 devenues inutiles retirées du routeur. Champs facultatifs du manifeste conservés pour lire les releases existantes. |
| 4 — domaine | Ligues, noms, reconnaissance par correspondance la plus longue et familles datées dans un module commun. Les périodes LCS/LEC/LCK traversant les renommages lisent tous leurs membres ; note et cas d’eval. Sans période explicite, le nom de compétition garde son sens courant. Rôles/dictionnaires supplémentaires restent à leur emplacement. |
| 5 — années | Années hors couverture signalées avant construction d’outil, borne haute liée à l’horloge de la question. |
| 6 — synthèse | Virgule normalisée, ordre des nombres, noms, métriques et interprétations contrôlés. Pour une phrase chiffrée, seule une formulation présente dans les faits est acceptée : une permutation sémantique ne se prouve pas avec un ensemble de nombres. Repli sur les faits déterministes. |
| 7 — issue | Erreurs, rejets, délais dépassés et résultat vide distingués dans l’exécution et la réponse. Étapes encore ouvertes clôturées en erreur. Refonte complète des unions QueryPlan/Outcome/StepPart reportée : elle modifierait simultanément trace, eval et rendu sans nécessité pour les défauts retenus. |
| 8, 9 — tests et garde | Tests garde/routeur/pull/synthèse, commentaire ouvert refusé, récursivité refusée, limites de taille et délai réel. Pas d’heuristique interdisant toutes les jointures croisées : le processus enfant apporte une borne fiable, contrairement à une regex de coût. |
| 10 — outils | Registre unique des schémas/définitions ; types de noms/appels, SDK, binding et normalisation dérivés. Pas d’éclatement en neuf fichiers : évite le déplacement massif dans cette MR. Les motifs du routeur restent un Record exhaustif vérifié par TypeScript. Une métrique incompatible ne devient plus silencieusement une autre métrique. |
| 11 — métriques | Registre complet de calcul/libellés/motifs reporté : pas de changement de définition in-game ici ; refonte transversale trop large. |
| 12 — publication | Dérivations périmées comptées et refusées, comparaison de couverture précédente indépendante du schéma, override explicite pour baisse voulue. Un corpus Riot supplémentaire serait nécessaire si les définitions changeaient ; elles restent identiques ici. Les contrôles supplémentaires de tous les noms et compteurs d’identité restent une suite. |
| 13 — annulation | Signal de la requête propagé au SQL enfant et aux appels LLM via contexte asynchrone local à la question. |
| 14 — front | Champ limité à 500 caractères, étapes interrompues après arrêt/erreur, avis précédent conservé lors d’un échec. Pas de bibliothèque de machine à états. |
| 15 — contrats de release | Snapshot CI explicite ; extraction des métadonnées générales de release et remplacement du log de data:pull par fichier reportés. Aucun bug bloquant démontré dans ces deux contrats existants. |
| 16 — environnement | LANGFUSE_TRACING_ENVIRONMENT et FEEDBACK_SECRET documentés, test des variables applicatives. |
| 17 — petites constantes | LIMIT du prompt dérivé du garde ; autres seuils/exemples/helpers gardés pour limiter la refonte non fonctionnelle. |
| 18 — surplus | json_version et forme v5 conservés : leur retrait imposerait une nouvelle release compatible. Autres suppressions cosmétiques reportées. |
| 19 — docs | README produit/local/sources/limites réécrit ; AGENTS aligné sur l’implémentation, sans liste de ligues recopiée. |

## Sécurité

B1 est couvert par un processus distinct tué à quatre secondes, connexion en lecture seule, version vérifiée, SQLite length 1 Mo, résultat limité à 200 lignes et 2 Mo. Le test fait tourner une vraie jointure coûteuse et vérifie que la boucle principale reste disponible. Un test exécute aussi le fichier enfant via Node, pas seulement Bun.

Le contournement du LIMIT par commentaire ouvert est rejeté. Les avis exigent une signature HMAC expirante émise avec la trace ; sans secret de signature, aucun avis n’est accepté. Les deux routes contrôlent débit, type de contenu et contexte cross-site. Les limites en code sont par instance ; le pare-feu Vercel reste nécessaire pour un plafond partagé.

CSP statique compatible avec le bootstrap Next (`unsafe-inline` nécessaire), frame-ancestors, nosniff, referrer et permissions ajoutés. Une CSP à nonces demanderait du rendu dynamique et est reportée. L’interface annonce OpenRouter/fournisseur du modèle. Secrets R2/GitHub limités aux étapes utiles, CLI Vercel épinglé au lockfile et jeton transmis par environnement.

B2 (e-mail historique) : décision d’Enzo du 15 novembre 2026, l’adresse reste dans l’historique, sans réécriture. Le rapport de sécurité est publié tel quel avec le dépôt ; sa mention « à ne pas pousser » valait tant que B1 et B2 étaient ouverts. Aucun changement des réglages OpenRouter, R2, Langfuse ou Vercel hors dépôt.

## Performance et identités

- Index additionnel `(champion_id, kind, game_id)` ; clé primaire du draft préservée. Sur la base réelle, mêmes résultats Ahri/Worlds, lecture chaude ~38–39,5 → 11–11,4 ms ; base ~108,8 Mo.
- Agrégation d’apparitions d’équipes par UNION ALL, sans double compter une partie dont les deux côtés portent le même id. Comparaison des comptes de chaque équipe requise dans la vérification finale.
- Aucun regroupement physique des objets par joueur : suite possible pour la taille, avec risque de ralentir certaines lectures.
- GeekGoneMad → GeekGoneMAD : William Lyall, [Team Tempest](https://lol.fandom.com/wiki/Team_Tempest), [roster Team Shy Nuns](https://lol.fandom.com/wiki/NA_LCS/2014_Season/Spring_Promotion/Qualifiers/WellPlayed_2/Team_Rosters).
- minde → Minde : unique support de bleiz dans les quatre scoreboards, [roster du tournoi](https://lol.fandom.com/wiki/EU_LCS/2014_Season/Spring_Promotion/Qualifiers/WellPlayed_2). Fusion ciblée aux noms connus sans page exacte concurrente, tests conservant les homonymes réels. Deux lignes joueurs en moins, aucune ligne scoreboard perdue.

## Périmètre de vérification

Les résultats finaux des commandes et de la CI sont dans la description de PR. Les tests et l’eval ne prouvent pas les appels au modèle de production, les dashboards, les clés R2, le pare-feu distribué, BotID ou le déploiement Vercel. La démo et la production ne sont pas déployées par cette MR. Les cas LLM sont annoncés comme non vérifiés ; les timelines réelles sont exclues de la CI sans secrets, leurs parseurs et le stockage ont des tests synthétiques.

### Vérifications locales finales

Code fonctionnel vérifié à `0a511a9`, permissions finales de workflow à `085c447` : lint sans warnings, typecheck, 83 tests / 333 assertions en ordre normal et aux seeds 2380133667, 0, 1, 42, 2026, 4294967295 ; eval déterministe hors timeline, 97/97 cas entièrement vérifiés (12 autres nécessitent le modèle, 52 assertions ignorées) ; build complet et mesure 143,3 Mo de fonction / 108,8 Mo de base. Les trois rapports copiés ont été comparés octet pour octet aux originaux.

Node 24.22.3 a exécuté le SQL enfant et l’application compilée. Parcours réel `/api/ask` : années 2010 et 2031 → message de couverture ; UI « palmarès LCS depuis 2015 » → 31 éditions de 2015 à 2026, titre correct, note de fusion, sources. Champ HTML limité à 500 caractères, aucune erreur JavaScript observée. [Capture de ce parcours](lcs-2015.png).

Les 832 comptes d’équipes ont été comparés ligne par ligne entre l’ancienne et la nouvelle agrégation : identiques, somme 78 192. La revue indépendante a fermé deux constats sur le contrôle du déploiement (tous les chemins doivent vérifier la CI du SHA checkouté ; permission `actions: read` aussi sur l’appelant réutilisable). Trois passages, aucun constat restant.

L’API GitHub de protection de branche a répondu 403 : le plan actuel demande GitHub Pro ou un dépôt public pour cette fonctionnalité. Aucun réglage n’a été modifié ; `PR checks` reste informatif tant que cette protection ne peut pas être activée. Les validations CI à distance ne remplacent pas la vérification d’un déploiement ; aucun merge ni déploiement n’est autorisé ici.
