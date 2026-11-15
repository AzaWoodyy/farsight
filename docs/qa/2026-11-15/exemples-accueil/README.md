# Exemples de l'accueil : clignotement et animation (15 novembre 2026)

Build de production local (`next build` + `next start`), Chromium 141 piloté par Playwright, cache désactivé,
rechargement forcé (`Page.reload` avec `ignoreCache`). « Avant » : `main` à 6991e25 (#31) ; « après » : la
branche `fix/examples-animation-flash` rebasée sur 65f9237 (#32). Chaque bande montre les images du screencast
avec leur temps depuis le rechargement.

Un `MutationObserver` (plus une lecture à chaque frame) relève les textes visibles des quatre exemples :

| Cas | Avant | Après |
|---|---|---|
| Desktop 1280, réseau rapide | 2 états : 1er exemple, puis tirage (≈ 20 ms plus tard) | 1 état, tiré au hasard |
| Desktop 1280, CPU ×4 | 2 états (≈ 50 ms d'écart) | 1 état, tiré au hasard |
| 390 px, réseau rapide | 2 états | 1 état, tiré au hasard |
| 390 px, CPU ×4 | 2 états | 1 état, tiré au hasard |
| Desktop et 390 px, 3G (750 kb/s, 300 ms) | 1 état, toujours le 1er exemple (hydratation > 1,5 s : tirage abandonné) | 1 état, tiré au hasard |

| # | Contexte | Avant | Après |
|---|---|---|---|
| 01 | 390 px, CPU ×4 | [avant](01-avant-exemples-390-cpu4.png) | [après](01-apres-exemples-390-cpu4.png) |
| 02 | 390 px, 3G | [avant](02-avant-exemples-390-3g.png) | [après](02-apres-exemples-390-3g.png) |
| 03 | Desktop 1280, CPU ×4 | [avant](03-avant-exemples-1280-cpu4.png) | [après](03-apres-exemples-1280-cpu4.png) |

Lighthouse sur l'accueil, médiane de 3 passes, même machine :

| | Perf | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|
| Mobile avant | 98 | 0,91 s | 2,33 s | 24 ms | 0,0007 |
| Mobile après | 98 | 0,91 s | 2,33 s | 25 ms | 0 |
| Desktop avant | 100 | 0,25 s | 0,50 s | 0 ms | 0,0001 |
| Desktop après | 100 | 0,25 s | 0,50 s | 0 ms | 0 |

HTML de l'accueil : + 0,7 Ko gzip (tous les exemples, le script de tirage et la règle CSS qui masque les autres).

Hors périmètre, relevé en 3G : la page s'affiche d'abord dans la police de secours (Arial ajustée), puis passe
en Geist Mono à son arrivée. Ce changement de police touche toute la page, existait avant et n'est pas
corrigé ici.
