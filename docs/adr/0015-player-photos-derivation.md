# Which Leaguepedia headshots become a player's photos

`player_images` holds, for each player, headshot file names dated by the start of the tournament they were taken for, so an answer shows the photo of its period (`src/lib/domain/player-photos.ts`). The Cargo table `PlayerImages` is noisier than that: links are not always player pages, dates are missing and the image type is free text.

## Rules

- `fetchPlayerImages` (`scripts/data/fetch.ts`) saves the whole `PlayerImages` table (about 30 000 rows, a handful of requests) rather than the images of the players in scope: an image's link may differ in case from the player page or be an older handle, and it can only be resolved in the derivation, like a scoreboard link (`canonical`).
- An undated headshot is kept only for a player who has no dated one, and is stored at the oldest possible date (`UNDATED_PHOTO`): any dated photo wins over it, and the page shows it without a year. Several undated files for one player: see the determinism rule (first by name).
- `ImageType` is free text (Headshot, headshot, Portrait, Profile, Bodyshot, Stageshot...). The derivation excludes by pattern rather than by an allow-list: types matching `WIDE_SHOT` (`body`, `full`, `stage`, `tilt`, `valentine`) are dropped because wide shots crop badly into an avatar; every other type, and a row without a type, is kept.
- A raw cache without `player_images.json` gives players no photo, with a warning.
