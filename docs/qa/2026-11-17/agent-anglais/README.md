# L'agent répond dans la langue de la page, hors outils (17 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium), sans clé LLM. La page envoie
sa langue avec la question ; le panneau des étapes est ouvert à la main pour la capture.

| # | Contexte |
|---|---|
| 01 | `/en`, « Faker's champion pool » : les quatre étapes en anglais (`Entities recognized`, `Typed tool`, `Attempt 1: guard OK`, `Summary`) |
| 02 | `/en`, « Faker's results at Worlds 2031 » : réponse hors périmètre en anglais, sans tableau, avec ses questions de suivi anglaises |
| 03 | `/`, « Champion pool de Faker » : les mêmes étapes en français, inchangées |

Restent en français sur `/en` : les raisons du routeur (`src/lib/agent/query.ts`) et ce que les outils écrivent
(titres, résumés, notes, questions de suivi des réponses avec tableau).
