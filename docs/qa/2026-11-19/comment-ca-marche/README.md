# Page « Comment ça marche » (19 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium), base `data-20261117-2`.

## SEO

| Page | `<html lang>` | Canonical | hreflang | Rendu |
|---|---|---|---|---|
| `/comment-ca-marche` | fr | `https://askfarsight.com/comment-ca-marche` | fr, en, x-default → `/comment-ca-marche` | statique (○) |
| `/en/how-it-works` | en | `…/en/how-it-works` | fr, en, x-default → `/comment-ca-marche` | statique (○) |

Le sitemap liste six pages : les deux nouvelles y sont, chacune avec ses alternates. Chaque page a son titre et
sa description. Le bouton de langue de l'en-tête mène à la même page dans l'autre langue.

## Liens

Lus dans le HTML servi, ce sont de vrais `<a href>` :

| Depuis | Texte du lien |
|---|---|
| Accueil `/`, sous le titre | « Comment Farsight trouve ses réponses » |
| Accueil `/en`, sous le titre | « How Farsight finds its answers » |
| Pied de page des six pages | « Comment Farsight fonctionne » / « How Farsight works » |

## Affichage

Page entière capturée dans les deux langues, en clair et en sombre, à 1280 px et à 390 px : aucun débordement
horizontal (`scrollWidth` égal à `clientWidth` dans les six cas), le tableau de couverture tient à 390 px.

Les chiffres de la page (date, parties par compétition, parties avec détail Riot, première saison avec un
fichier Riot) sont lus dans la base au build : 17 novembre 2026, 39 100 parties dont 28 331 avec détail Riot.

| # | Contexte |
|---|---|
| 01 | `/comment-ca-marche`, clair, 1280 px |
| 02 | `/comment-ca-marche`, sombre, 390 px |
| 03 | `/en/how-it-works`, sombre, 1280 px |
| 04 | `/en/how-it-works`, clair, 390 px |
| 05 | Accueil `/`, clair, 1280 px : lien sous le titre et dans le pied de page |
| 06 | Accueil `/en`, sombre, 390 px : idem |
