# URLs of the images Leaguepedia hosts

Player photos, team logos and dragon icons are fair use: the database keeps file names only and the browser loads each image from Fandom's CDN. The URL is therefore built in code from the file name alone, following MediaWiki's own storage rules.

Player photos and team logos are loaded by the browser from Fandom's CDN, from the file name alone. `wikiImageUrl` (`src/lib/domain/wiki-images.ts`) rebuilds the path MediaWiki uses.

## Rules

- MediaWiki stores a file under two directories taken from the md5 of its name (spaces written as underscores): the first hex digit, then the first two. `wikiImageUrl` in `src/lib/domain/wiki-images.ts` rebuilds that path (`/<md5[0]>/<md5[0..2]>/<name>/revision/latest/scale-to-width-down/<width>`); the name must be the exact one the wiki stores, or the hash points nowhere.
- The wiki reads a space and an underscore alike in a file name, so a logo file is looked up in the hand-kept tone list (`team-logo-tones.json`) by a key with underscores turned into spaces (`key` in `src/lib/domain/team-logos.ts`): an entry written either way matches.
- A team logo is requested at 64 px (`WIDTH` in `src/lib/domain/team-logos.ts`): twice the largest size a logo is shown at (32 px), for high-density screens. Raise it when a view shows a larger logo.
- The path is `/images/<h1>/<h1h2>/<File_name>` where `h1h2` are the first two hex digits of the md5 of the file name with spaces replaced by underscores, not of the name as stored with spaces.
- The reference case is checked against the wiki's own URL: md5("Faker_Summer_2016.png") starts with 19, and the wiki serves that file at `https://static.wikia.nocookie.net/lolesports_gamepedia_en/images/1/19/Faker_Summer_2016.png/revision/latest/scale-to-width-down/200` (`scripts/scoreboard.test.ts`).
