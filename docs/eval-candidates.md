# Candidats d'eval tirés des traces

`eval/questions.json` est écrit à la main. Les vraies questions des visiteurs montrent où le routeur a des trous :
celles qui sont parties en SQL généré (aucun outil typé n'a répondu), celles qui ont reçu un pouce bas, celles qui
finissent sur `missing_data` et celles qui laissent des mots non lus. `bun run eval:candidates`
(`scripts/eval-candidates.ts`) les relève dans Langfuse et les propose. Il n'ajoute jamais de cas lui-même.

```sh
bun run eval:candidates                  # 30 derniers jours de production
bun run eval:candidates --days=90        # une fenêtre plus longue
bun run eval:candidates --env=preview    # un autre environnement Langfuse
bun run eval:candidates --no-replay      # sans base : seulement la route d'alors
bun run eval:candidates --out=DIR        # un autre dossier de sortie
```

## Règle de confidentialité

Le dépôt est public, et un visiteur peut taper n'importe quoi.

- Rien de ce qu'un visiteur a écrit n'est commité, poussé, ni cité dans une PR, un message de commit ou un
  commentaire GitHub : ni le texte des questions, ni les identifiants de trace ou de session, ni une URL du tableau de
  bord.
- Le rapport est écrit hors du dépôt, dans `~/.farsight/eval-candidates/` (dossier 0700, fichiers 0600). Un `--out`
  dans le dépôt est refusé si git ne l'ignore pas (`git check-ignore`).
- Les questions sont masquées une deuxième fois (`src/lib/tracing/mask.ts`). Ce masquage ne remplace pas une relecture :
  le script propose, Enzo décide de ce qui devient un cas d'eval, reformulé au besoin.
- Les tests (`scripts/eval-candidates.test.ts`) n'utilisent que des traces synthétiques, jamais de vraies questions.
- Le terminal n'affiche que des comptes. Les questions restent dans le rapport.

## Ce que fait le script

1. Il lit en lecture seule les observations racines `answer-question` (`GET /api/public/v2/observations` ; l'API
   `/api/public/traces` a été retirée de Langfuse Cloud le 16/11/2026) et les scores `response_rating`
   (`GET /api/public/v3/scores`) de l'environnement demandé. Il n'écrit rien dans Langfuse : ni score, ni suppression.
2. Il garde les traces qui ont au moins un motif : route `sql`, pouce bas, route `missing_data`, mots non lus
   (`metadata.unread`).
3. Il fusionne les questions identiques à la casse, aux accents, à la ponctuation et aux espaces près, langue par
   langue.
4. Il retire les questions qu'`eval/questions.json` pose déjà dans la même langue.
5. Il rejoue chaque question avec `runAgent`, sur les règles seules (sans clé OpenRouter, comme
   `bun run eval --deterministic`) et dans sa langue, pour donner la route d'aujourd'hui et les mots encore non lus.
6. Il écrit `candidates-<date>.json` et `candidates-<date>.md` : question, langue, motifs, route alors et aujourd'hui,
   mots non lus alors et aujourd'hui, avis (pouces), nombre de traces, dates, et l'id de la dernière trace pour
   l'ouvrir dans Langfuse.

Statut d'un candidat après le rejeu : `still-sql` (toujours en SQL généré), `fixed` (un outil typé répond sans mot non
lu), `changed` (une autre route, encore imparfaite), `same` (même route qu'alors), `not-replayed` (rejeu en erreur ou
`--no-replay`).

Langue : depuis cette version, la trace garde la langue de la page (`metadata.locale`). Pour une trace plus ancienne,
le script la devine d'après la langue de la réponse et la marque d'un `?` dans le rapport.

## Prérequis

- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` et `LANGFUSE_BASE_URL`, lues dans `.env`, `.env.local` ou
  `~/.farsight/langfuse.env`. Sur Vercel, la clé secrète est sensible et ne se relit pas : il faut la recopier depuis
  Langfuse. Le script ne l'affiche jamais et la retire de l'environnement avant le rejeu.
- `DATABASE_URL` pour le rejeu, comme pour l'eval ([postgres.md](postgres.md)).
