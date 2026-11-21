# Static SQL guard: read as Postgres reads, refuse what it would read otherwise

`guardQuery` in `src/lib/agent/guard.ts` is the static pass a query goes through before it runs. It is a text scan, not a parser, so it is only safe as long as it reads strings, comments and names exactly as Postgres does; every form where the two could disagree is refused rather than interpreted, since Postgres could then run what the pass took for text. No question needs those forms.

## Rules

- `ALLOWED_OBJECTS`: generated (text-to-SQL) queries may read the `v_*` views only; typed tools may also read small lookup tables (`leagues`, `teams`, `champions`, `players`, `game_riot`: champion icons, a game's Riot key).
- `FORBIDDEN` lists statements and clauses a read-only query never needs, including some that look harmless inside a SELECT: `SELECT … INTO` creates a table, `FOR UPDATE` locks rows.
- `DENIED_NAMES`: functions that read files, run SQL of their own, sleep, signal the server or read its settings are never allowed in a generated query, whatever the role allows. The static pass is the only barrier for the built-in functions `PUBLIC` may execute (`current_setting`…): `db/roles.sql` does not revoke them from `farsight_sql`. SQLite's file functions (`load_extension`, `readfile`, `writefile`, `fts3_tokenizer`…) are refused too, because a model may still write that dialect.
- Unicode-escaped names and strings (`U&"…"`) are refused: `U&"set_confi\0067"` is `set_config` written so that the static checks cannot read it.
- `scanSql` strips literals and comments before the checks and rejects an unfinished token: a trailing comment or unclosed literal would otherwise swallow the forced `LIMIT` the wrapper appends.
- `scanSql` reads plain strings (`''` doubles a quote) and line comments. It refuses escape strings (in `E'\''` Postgres ends the string after the second quote, the scan would end it after the first), dollar-quoted strings (any `$`) and block comments (Postgres nests them).
- Only Postgres' own quotes (`'` and `"`) open a literal or a quoted name. Square brackets are not quotes: in Postgres they are arrays and subscripts, and are read as code (SQLite accepted `[name]`).
- A line comment ends at a carriage return as well as at a line feed, because Postgres ends it there too: code after a lone CR still runs, so the scan must not treat it as comment.
- `referencedTables` reads every table named after `FROM` (each one of a comma list) or `JOIN`, with its alias; a subquery is read by its own `FROM`. `EXTRACT(… FROM x)` and `IS DISTINCT FROM x` read a value, not a table, and are masked first so they are not reported as unknown tables.
- The tables are returned in the order of the text, so that when two tables share an alias the later one wins in the alias map, as the pass has always resolved them; changing the order changes which columns are accepted.
