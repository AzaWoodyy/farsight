# Police des images de partage (19 novembre 2026)

Build de production local (`next build` + `next start`), sans clé LLM. La carte du site et la carte d'une réponse
(`/api/card`) sont maintenant en Geist Mono, la police des pages. Avant, elles étaient dans la police par défaut
du moteur d'images (Geist Sans).

| Carte | Fichier |
|---|---|
| Carte du site, français et anglais | `01-carte-du-site-fr.png`, `02-carte-du-site-en.png` |
| Finale des Worlds 2025 | `03-serie.png` |
| KC contre MKOI : les noms passent sur deux lignes | `04-duel-equipes.png` |
| Meilleurs mids aux Worlds 2026 | `05-classement-joueurs.png` |
| Champions les plus bannis en LCK 2025 | `06-classement-champions.png` |
| Résultats de Chovy à tous les Worlds | `07-palmares.png` |
| Azir stats at Worlds 2025 (`/en`) | `08-phrase-en.png` |

Cas limites, dessinés avec des données fabriquées (le plus long nom d'équipe de la base, un libellé de place
long, des scores à trois chiffres) :

| Cas | Résultat | Fichier |
|---|---|---|
| Classement, nom de 29 caractères en tête | coupé par des points de suspension, la valeur reste dans l'image | `09-limite-classement.png` |
| Palmarès, « Huitième de finale 2024 » | le troisième chiffre passe à la ligne | `10-limite-palmares.png` |
| Duel, deux noms longs et scores à trois chiffres | noms sur trois et quatre lignes, rien ne sort de l'image | `11-limite-duel.png` |

Une question hors périmètre (`/api/card?q=bonjour`) renvoie exactement la carte du site (fichiers identiques).
Le fichier de police est dans la trace de `/api/card` et des deux routes `opengraph-image` sans réglage
supplémentaire dans `next.config.ts`.
