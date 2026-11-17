# Français à la racine, anglais sous /en (17 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium).

| Page | Statut | `<html lang>` | Canonical | Robots |
|---|---|---|---|---|
| `/` | 200 | fr | `https://askfarsight.com` | indexable |
| `/mentions-legales` | 200 | fr | `…/mentions-legales` | indexable |
| `/en` | 200 | en | `…/en` | `noindex, nofollow` |
| `/en/legal-notice` | 200 | en | `…/en/legal-notice` | `noindex, nofollow` |
| `/nope`, `/en/nope`, `/api/nope` | 404 | fr | aucun | `noindex` |

Le sitemap garde ses deux URL françaises. Le sélecteur de langue n'apparaît pas sur les pages françaises tant que
l'anglais n'est pas dans `PUBLIC_LOCALES` ; depuis `/en`, il ramène à la même page en français.

| # | Contexte |
|---|---|
| 01 | `/en/legal-notice`, 1280 px : en-tête avec le retour au français, page légale en anglais |
| 02 | `/en`, 390 px : en-tête et pied traduits, console encore en français (PR suivante) |
| 03 | URL inconnue, 1280 px : 404 rendue côté serveur, dans les deux langues |
