# L'anglais devient public (17 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium).

## SEO

| Page | `<html lang>` | Canonical | hreflang | Robots |
|---|---|---|---|---|
| `/` | fr | `https://askfarsight.com` | fr, en, x-default → `/` | indexable |
| `/en` | en | `…/en` | fr, en, x-default → `/` | indexable |
| `/mentions-legales` | fr | `…/mentions-legales` | fr, en, x-default | indexable |
| `/en/legal-notice` | en | `…/en/legal-notice` | fr, en, x-default | indexable |

Le sitemap liste les quatre pages, chacune avec ses alternates. Le bouton de langue apparaît sur les pages
françaises (`EN`) et anglaises (`FR`) et mène à la même page dans l'autre langue.

## Passe sur `/en`

22 questions posées sur `/en`, une par outil et par type de réponse sans tableau (hors périmètre, résultat vide),
panneau des étapes ouvert. Pour chacune, le texte de la page et les attributs `title` / `aria-label` sont
cherchés contre une liste de mots français (noms de joueurs, d'équipes et liens Leaguepedia exclus) : aucun mot
trouvé, aucune erreur, aucun débordement horizontal à 1280 px.

La timeline d'une partie est lue depuis une copie locale des fichiers Riot.

| # | Contexte |
|---|---|
| 01 | « Recap of game 5 of the Worlds 2024 final » : fin de partie et courbe d'or, éléments de dragon en anglais |
| 02 | « Faker vs Chovy » : duel de joueurs |
| 03 | « Worlds 2025 final » : série en BO |
| 04 | « Azir stats at Worlds 2025 » : fiche champion |

## Avec le modèle de langage

Quatre questions anglaises posées à l'agent avec la clé OpenRouter (`sqlAvailable: true`). Le text-to-SQL répond
et se corrige en anglais. La synthèse rédigée par le modèle est rejetée par le garde-fou dès qu'elle reformule
des chiffres, comme en français : la phrase toute faite, en anglais, est alors gardée.
