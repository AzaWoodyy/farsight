# QA responsive, tactile et 3G (14 novembre 2026)

Build de production local (`next build` + `next start`), mode déterministe
(sans clé OpenRouter ni R2), Chromium 141 piloté par Playwright. « Avant » :
`main` à 2cacaea ; « après » : la branche `fix/responsive-perf`.

Matrice : 13 écrans (accueil, palmarès, comparaison, duel de joueurs, duel
d'équipes, récap de partie, fiche champion, lanes, classement de champions,
roster, champion pool, classement, tableau triable) × 9 largeurs (320, 375,
390, 414, 768, 1024, 1280, 1440, 1920) × thèmes clair et sombre, soit 234
écrans. Jusqu'à 1024 px, émulation tactile (pointeur grossier, comme un
téléphone ou un iPad).

| | Avant | Après |
|---|---|---|
| Écrans avec scroll horizontal de la page | 16 | 0 |
| Cibles tactiles de moins de 44 px (hors liens dans le texte) | 2 394 | 0 |
| Erreurs console | 0 | 0 |

## Correctifs et captures

| # | Correctif | Largeur, contexte | Avant | Après |
|---|---|---|---|---|
| 01 | Duel de joueurs : la page débordait à droite (en-tête `sr-only` du tableau des parties positionné hors du conteneur scrollable) | 390 px, « Faker contre Chovy » (aussi 320 à 414, comparaison) | [avant](01-avant-duel-joueurs-390.png) | [après](01-apres-duel-joueurs-390.png) |
| 02 | Palmarès : les champions étaient cachés derrière un scroll horizontal ; ils passent sur une ligne pleine largeur, le % sous le bilan | 390 px, « Résultats de Chovy à tous les Worlds » | [avant](02-avant-palmares-390.png) | [après](02-apres-palmares-390.png) |
| 03 | Récap de partie : K/D/A et or hors écran sur téléphone ; repris sous chaque joueur | 320 px, thème sombre, game 5 de la finale des Worlds 2024 | [avant](03-avant-recap-partie-320-sombre.png) | [après](03-apres-recap-partie-320-sombre.png) |
| 04 | Question posée écrasée dans une colonne étroite à côté de « Nouvelle conversation » | 320 px, « Meilleurs mids aux Worlds 2026 » | [avant](04-avant-question-posee-320.png) | [après](04-apres-question-posee-320.png) |
| 05 | Cibles tactiles de 44 px : liens de joueurs, de tournois et de sources, tris, onglets, boutons « vue tableau » / « afficher » | 390 px, « Samsung White roster 2014 » | [avant](05-avant-cibles-tactiles-roster-390.png) | [après](05-apres-cibles-tactiles-roster-390.png) |
| 06 | Tablette tactile : les boutons retombaient à 32-36 px dès 640 px de large ; la taille réduite ne vaut plus que pour une souris | 1024 px tactile, accueil | [avant](06-avant-cibles-tactiles-tablette-1024.png) | [après](06-apres-cibles-tactiles-tablette-1024.png) |
| 07 | 3G bridée : les exemples de l'accueil restaient invisibles jusqu'à l'hydratation (8 s) ; ils sont rendus côté serveur | 390 px, Slow 3G + CPU ×4, capture à 4 s | [avant](07-avant-exemples-3g-4s-390.png) | [après](07-apres-exemples-3g-4s-390.png) |
| 08 | Détail des étapes : étapes non exécutées sous le contraste AA (`text-muted/60`), détail technique en 11 px | 390 px, recherche arrêtée après l'étape 1 | [avant](08-avant-detail-etapes-390.png) | [après](08-apres-detail-etapes-390.png) |
| 09 | Saut de mise en page à l'arrivée de la réponse (CLS 0,61 en 3G) : progression en haut, détail replié au-dessus de la réponse, zone d'au moins un écran | 390 px, « Classement des Worlds 2023 » | [avant](09-avant-ordre-reponse-390.png) | [après](09-apres-ordre-reponse-390.png) |

Les captures « après » des correctifs tactiles sont prises fenêtre agrandie à
la hauteur de la page : une capture pleine page de Chromium perd l'émulation
tactile et montrerait la mise en page « souris ».

## Performance (sans capture)

| Mesure | Avant | Après |
|---|---|---|
| JS chargé avant le premier rendu (accueil, gzip) | ~250 Ko | ~150 Ko |
| Hydratation de l'accueil, Slow 3G + CPU ×4 | 7,4 s | 4,9 s |
| CLS question → réponse, Slow 3G | 0,61 | 0,07 |
| Délai entre la fin du flux et l'affichage de la réponse | ~10 ms | ~10 ms |

- Chat (AI SDK, zod) et vues de réponse hors du premier chargement, chargés
  au repos, au focus du champ ou à la question.
- Geist Sans retirée : préchargée, jamais utilisée.
- zod en mode `jitless` côté client : plus de violation CSP (`eval`)
  signalée par Lighthouse.
- JSON-LD `WebSite` + `WebApplication` : 0 erreur, 0 avertissement sur
  validator.schema.org.

Scores Lighthouse et Core Web Vitals : description de la PR.
