# Classifying a slice of comments

Read AGENTS.md first: it records the project's decisions.

You get one slice file listing code comments: `[id] L<line>` followed by the comment text, grouped by file. Classify EVERY id. Do NOT edit any file in the repository; deletions are applied later by a script from your JSON. Do not spawn subagents. Do not run tests/builds.

Read the code around each comment (read each file of your slice; for a large file read it in parts) so that the judgment rests on the code, not on the comment alone.

## Categories (exactly one per id)

- `T` Tautology: says what the name, signature, types or the next lines already show. Includes section dividers, "what this function/field is" doc comments a reader gets from the code, test comments that restate the fixture or the assertion, and worked arithmetic a reader can redo from the fixture.
- `S` Stale: refers to code, names, files, tables, tools or behavior that no longer exist or no longer work that way (check: grep the identifiers it names; e.g. SQLite files, data releases, `data:build`, `data:package`, `data:pull` are gone per AGENTS.md).
- `E` Excuse: justifies a shortcut, workaround, duplicated logic, magic value, swallowed error, lint suppression or known gap that should be fixed in the code rather than explained ("for now", "good enough", "simpler than", a type assertion or a disable that hides a design problem). Only when a real, fixable implementation problem stands behind it.
- `D` Decision record: an important, non-obvious decision or constraint the code cannot show: why this way and not the obvious way, a fact about external data or systems (Leaguepedia, Riot JSON, Postgres, Vercel, Next, crawlers, Langfuse…) that forced the code, a rule of the domain that a later change would silently break. The bar: a competent reader of the code would get it wrong or "fix" it without this knowledge.
- `U` Unsure: only when you truly cannot decide after reading the code. Keep it rare (it stays in the code).

When a comment mixes a restatement and a real reason, the reason wins: `D`. When a doc comment only describes what something is or returns, it is `T` even if well written. Be honest rather than generous: most "what" comments are `T`; do not inflate `D`, and do not deflate it either — a lost constraint is a real loss.

## For D: where the knowledge goes

Each `D` id needs an `adr` field:
- `"existing:<path>"` when AGENTS.md or a file under docs/ (the ADRs of `docs/adr` included) already records that same knowledge, every detail of it (name the file, e.g. `existing:AGENTS.md`, `existing:docs/adr/0009-first-blood-definition.md`). Open the file and check before claiming it; a detail it lacks goes into an ADR.
- otherwise the slug of an ADR you draft in `adrs`.

ADR drafts: group the decisions of your slice by theme, one ADR per coherent decision area (typically 4–12 ADRs for a slice, not one per comment, not one giant dump). Format, in English, plain and concrete, in the voice of AGENTS.md:

```
# <Short title of the decision>

<1–3 sentences: the context, what was decided, and why.>

## Rules
- <one bullet per recorded constraint that came from a comment: the fact and its reason, naming the file and symbol it governs in backticks, with the comment's example when it had one ("Zoe", "Sion")>
```

Every D comment with a slug must be traceable to a sentence or bullet of that ADR, with its substance kept (the examples, numbers and names in the comment are the valuable part; do not water them down). Write for someone who has not seen the comment. No mention of "the comment" or of this audit.

## For E: issues

Each `E` id needs an `issue` key, defined once in `issues`: a title, and a body with: where (file and symbol), what the shortcut is, why it is a problem, and what a proper fix looks like. One issue per underlying problem; several comments can share one. English. The repository is public: no personal data.

## Output

Write ONE JSON file at the output path you were given, valid JSON, exactly this shape:

```json
{
  "items": [
    { "id": 12, "cat": "T" },
    { "id": 13, "cat": "D", "adr": "player-identity-merge" },
    { "id": 14, "cat": "D", "adr": "existing:AGENTS.md" },
    { "id": 15, "cat": "E", "issue": "sql-timeout-magic", "why": "magic timeout" },
    { "id": 16, "cat": "S", "why": "names data:package, removed" }
  ],
  "adrs": [ { "slug": "player-identity-merge", "title": "…", "body": "<markdown after the title line>" } ],
  "issues": [ { "key": "sql-timeout-magic", "title": "…", "body": "…" } ]
}
```

`why` (a few words) is required for `S`, `E` and `U`, optional otherwise. Every id of the slice must appear exactly once. Validate the file parses as JSON and check the id count against the slice before finishing.

Final message: counts per category, the ADR slugs, the issue titles, and anything you found doubtful. Nothing else.
