# Console et vues de réponse en anglais (17 novembre 2026)

Build de production local (`next build` + `next start`), navigateur Aside (Chromium), sans clé LLM.

Les 20 exemples d'accueil anglais prennent la même route, avec les mêmes arguments et le même nombre de lignes,
que leur équivalent français (comparaison de `answer.meta` question par question).

| # | Contexte |
|---|---|
| 01 | `/en`, 1280 px : accueil, exemples et crédits en anglais |
| 02 | `/en`, « Faker's champion pool » : vue champion pool, nombres en notation anglaise (`71.6%`) |
| 03 | `/en`, récap de partie : tableau de fin de partie en anglais ; le titre, le résumé, les sources et les suites viennent de l'agent, encore en français (PR suivantes) |
| 04 | `/en`, 390 px, « Faker vs Chovy » : duel de joueurs, sans débordement |
| 05 | `/`, « Champion pool de Faker » : la vue française, inchangée (`71,6 %`) |
