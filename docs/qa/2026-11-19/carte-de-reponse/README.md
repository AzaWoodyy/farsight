# Carte d'une réponse dans l'aperçu d'un lien (19 novembre 2026)

Build de production local (`next build` + `next start`), sans clé LLM. Un lien `/?q=<question>` ou
`/en?q=<question>` porte maintenant, dans ses balises Open Graph et Twitter, le titre de la réponse, sa
première phrase et une image (`/api/card`). Les images de ce dossier sont celles que la route a servies.

| Question | Carte | Fichier |
|---|---|---|
| Finale des Worlds 2025 | score d'une série | `01-serie-fr.png` |
| Faker contre Chovy | victoires face à face | `02-duel-joueurs-fr.png` |
| T1 vs Gen.G in LCK (`/en`) | parties gagnées entre deux équipes | `03-duel-equipes-en.png` |
| Champions les plus bannis en LCK 2025 | tête d'un classement de champions | `04-classement-champions-fr.png` |
| Meilleurs mids aux Worlds 2026 | tête d'un classement de joueurs | `05-classement-joueurs-fr.png` |
| Résultats de Chovy à tous les Worlds | chiffres d'un palmarès | `06-palmares-fr.png` |
| Stats d'Azir aux Worlds 2025 | titre et première phrase | `07-phrase-fr.png` |
| bonjour (hors périmètre) | carte du site, inchangée | `08-hors-perimetre-fr.png` |

Balises lues avec l'agent utilisateur de Discord (`Discordbot/2.0`) :

| Adresse | `og:title` | `og:image` | Canonical |
|---|---|---|---|
| `/?q=Faker%20contre%20Chovy` | `Faker vs Chovy` | `/api/card?l=fr&q=Faker+contre+Chovy` | `/` |
| `/en?q=T1%20vs%20Gen.G%20in%20LCK` | `T1 vs Gen.G — LCK` | `/api/card?l=en&q=T1+vs+Gen.G+in+LCK` | `/en` |
| `/?q=bonjour`, `/?q=a&q=b` | celui de l'accueil | carte du site | `/` |
| `/` , `/?q=`, `/?utm_source=x` | celui de l'accueil, page statique | carte du site | `/` |

`<title>` et la description de la page restent ceux de l'accueil sur un lien : la console pose d'autres
questions sans quitter la page. `?q=Faker%ZZ`, `%E0%A4%A`, `a%00b` et 501 caractères répondent 200 avec les
balises de l'accueil. `/api/card` répond en PNG, `Cache-Control: public, max-age=3600, s-maxage=604800`, en
25 à 390 ms ici.

Build servi sans base (`DATABASE_PATH` vers un fichier absent), avec les agents utilisateur
`Google-InspectionTool` et `Discordbot` : `/?q=Faker contre Chovy`, `/en?q=Faker vs Chovy` et `/` répondent 200
avec les balises de l'accueil, `/api/card` répond 200 avec la carte du site.

Parcours dans le navigateur (Aside, Chromium, 1280 px), sur la page servie par la réécriture :

| Parcours | Résultat |
|---|---|
| Lien ouvert à froid, `/?q=Faker contre Chovy` | la question et sa réponse, un `POST /api/ask` (`09-lien-ouvert-fr-1280.jpg`) |
| Autre question tapée | adresse `/?q=Finale+des+Worlds+2025`, un deuxième `POST /api/ask` |
| Précédent, suivant | les deux réponses dans l'ordre, sans nouvel appel ni requête de page |
| Logo | écran d'accueil, adresse `/` ; précédent ré-affiche la réponse |
| Changement de langue depuis une réponse | `/en?q=…`, question reposée, réponse en anglais ; rechargement identique |

Sur une preview Vercel : mêmes balises et même image que le build local, et l'accueil sans `q` reste servi
depuis le prérendu. L'aperçu réel dans Discord n'a pas été vu : les previews sont derrière l'authentification
Vercel, que le robot de Discord ne passe pas.
