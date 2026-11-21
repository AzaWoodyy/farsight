-- Schema v12 (src/lib/db/schema.ts): each team's square logo file on Leaguepedia (scripts/data/team-logos.ts), the file
-- name only: the image stays on Fandom's CDN (fair use, not CC BY-SA). NULL when the wiki has none. It only adds a
-- column: the code of migration 2 reads a database at this migration unchanged, and the code of this one reads a
-- database at migration 2 without logos (PG_MIGRATION_READ).

ALTER TABLE teams ADD COLUMN logo text COLLATE "C";
