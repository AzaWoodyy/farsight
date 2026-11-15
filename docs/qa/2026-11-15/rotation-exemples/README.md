# Exemples de l'accueil qui tournent tout seuls (15 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium). L'accueil est chargé dans
une iframe d'une page du même origine (les en-têtes `X-Frame-Options` et `frame-ancestors` retirés par un proxy
local, pour la mesure seulement) ; la page parente relève à chaque frame les questions visibles, la hauteur de la
liste, la position des boutons du dessous et la classe d'animation, et l'iframe compte les `layout-shift`.

| Cas | Résultat |
|---|---|
| 390 px, premier rendu | 1 état dès la première frame (≈ 90 ms), tiré au hasard, gardé jusqu'à la rotation |
| 390 px, 22 s | 3 rotations, ≈ 7,0 s d'écart ; sortie `ex-out` ≈ 275 ms puis entrée `ex-in`, aucun lot répété d'affilée |
| Hauteur | liste 380 px (390 px) et 190 px (1280 px) à chaque tirage, boutons du dessous immobiles, CLS 0 |
| Survol d'un exemple, 10 s | aucune rotation ; reprise ≈ 7 s après la sortie du pointeur |
| Focus clavier (Tab) sur un exemple, 10 s | aucune rotation |
| `visibilitychange` avec `document.hidden` vrai, 11 s | aucune rotation ; reprise ≈ 7 s après le retour |
| `prefers-reduced-motion: reduce`, 16 s | aucune rotation, aucune animation |
| Clic sur un exemple après une rotation | la question cliquée (« KC contre MKOI ») est posée et répondue |

| # | Contexte |
|---|---|
| 01 | [390 px, un tirage](01-tirage-a-390.png) |
| 02 | [390 px, tirage suivant](02-tirage-b-390.png) : même hauteur, boutons au même endroit |
