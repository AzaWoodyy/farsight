# Lien partageable vers une réponse (19 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium), réponses calculées sans clé
LLM (mode règles). `/?q=<question>` en français, `/en?q=<question>` en anglais.

| Page | `x-nextjs-prerender` | Canonical |
|---|---|---|
| `/` | 1 | `https://askfarsight.com` |
| `/?q=Faker%20contre%20Chovy` | 1 | `https://askfarsight.com` |
| `/en` | 1 | `https://askfarsight.com/en` |
| `/en?q=Faker+vs+Chovy` | 1 | `https://askfarsight.com/en` |

Le sitemap garde ses quatre URL, `robots.txt` interdit toujours `/api/`. `Referrer-Policy: strict-origin` : les
requêtes de la page, même vers le site lui-même, n'emportent que l'origine, jamais `?q=`.

| Parcours | Résultat |
|---|---|
| Question tapée (« Faker   contre Chovy ») | adresse `/?q=Faker+contre+Chovy`, un `POST /api/ask` |
| Clic sur un exemple | adresse `/?q=…` de l'exemple, un `POST /api/ask` |
| Lien ouvert à froid, `/` et `/en` | la question et sa réponse, un `POST /api/ask`, CLS 0, pas d'écran d'accueil avant |
| Copier le lien | presse-papiers : l'adresse absolue de la réponse ; le bouton dit « Lien copié » |
| Nouvelle conversation, logo | écran d'accueil, adresse sans `q`, une entrée d'historique de plus |
| Précédent / suivant | accueil et réponses dans l'ordre, sans nouvel appel à `/api/ask` ni requête au serveur |
| Changement de langue depuis une réponse | `/en?q=Faker+contre+Chovy` : la question est reposée, réponse en anglais |
| Page légale puis retour | la réponse est toujours là, sans nouvel appel |
| Page légale ouverte pendant qu'une question tourne, puis retour | la question est reposée, sa réponse s'affiche |
| Page légale puis logo | écran d'accueil, adresse sans `q` ; la question suivante part de zéro |
| `?q=` vide, espaces seuls, 501 caractères, `%E0%A4%A`, `Faker%ZZ`, `a%00b` | écran d'accueil, `q` retiré de l'adresse, aucun appel |
| `?q=100%25` | la question « 100% » est posée |
| `?utm_source=x` | écran d'accueil, adresse inchangée |

Non vérifié ici : BotID et la règle du pare-feu, qui n'existent que sur Vercel. Le lien passe par le même
`POST /api/ask` que la question tapée, et le client BotID attend son défi avant d'envoyer la requête.

| # | Contexte |
|---|---|
| 01 | `/?q=Faker%20contre%20Chovy` ouvert à froid, 1280 px, thème clair |
| 02 | même page, thème sombre, après « Copier le lien » |
| 03 | après le changement de langue : `/en?q=Faker+contre+Chovy`, thème sombre |
| 04 | `/?q=` de 501 caractères : écran d'accueil |
| 05 | lien ouvert à froid, 390 px, thème clair : les deux actions passent ensemble sous la question |
| 06 | 390 px, thème sombre, après « Copier le lien » |
| 07 | `/en?q=Faker+vs+Chovy`, 320 px, thème sombre |
