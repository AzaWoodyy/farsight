# Plain <img> instead of next/image, in two places

`nextjs/no-img-element` is suppressed on purpose in two places; neither is a shortcut to replace with `next/image`.

Every image an answer shows comes from someone else's CDN: Data Dragon for champion, item, rune and spell icons, Fandom for player photos, team logos and dragon icons. They are small (14 to 56 px), below the fold and lazy-loaded, and the Vercel project is on the Hobby plan, whose image-optimization quota is shared with the portfolio site. They are therefore drawn with a plain `<img>`, and each one carries an `oxlint-disable-next-line nextjs/no-img-element`.

Champion icons come from Data Dragon's CDN and are small (22 px in the versus table). The project is on the Vercel Hobby plan and shares its image optimization quota with another site.

## Rules

- `ResultChampions` in `src/app/answer-view.tsx` draws 20 px Data Dragon champion icons with a plain lazy `<img>`: `next/image` would spend the Vercel Hobby image-optimization quota, which is shared with the portfolio site, for icons that small and without any LCP gain.
- `answerCard` in `src/app/brand/answer-card.tsx` is rendered by `next/og` (`ImageResponse`), which draws plain `<img>` elements only: `next/image` does not exist there.
- `next/image` is not used for these images: it would spend the shared Vercel Hobby image-optimization quota on 20 px icons, without any LCP gain. This governs `ChampionIcon` (`src/app/champion-view.tsx`), `EntityIcon` (`src/app/entity-icon.tsx`), `Icon` and the keystone and rune images of `src/app/game-scoreboard.tsx`, the pick icon of `src/app/series-view.tsx` and `PlayerAvatar` (`src/app/player-avatar.tsx`).
- A player photo is requested as Fandom's own thumbnail at the displayed width (`photo.url`), so no resizing service is needed on our side.
- An image that fails to load never leaves a hole: `ChampionIcon` falls back to the champion's first letters in a box, `PlayerAvatar` to the player's initials, and `EntityIcon` disappears (it is decorative: the name is right beside it, so its `alt` is empty).
- In `PlayerHeader` (`src/app/player-header.tsx`) the photo links to its Leaguepedia file page (`photo.source`), because that page names the photo's author and licence: the photos are fair use, and this link is their attribution.
- A stat shard's icon is nearly white all over, so it would disappear on a light page: `toneOf` (`src/app/player-runes-view.tsx`) gives shards the tone `light`, and `ChampionIcon` then takes the `.entity-icon` class and `data-tone`, which draw the contrasting plate of `globals.css` on a page of the same tone only. This is the same mechanism as the team logos' `tone`; no icon is special-cased in the views.
- Data Dragon icons (`Side` in `src/app/versus.tsx`, and the other views that draw them) use a plain `<img>` with explicit `width`, `height` and `loading="lazy"`: `next/image` would spend the shared Vercel Hobby image quota for no LCP gain, since these icons are never the largest element. The `oxlint-disable-next-line nextjs/no-img-element` above each one is deliberate; do not "fix" it by switching to `next/image`.
