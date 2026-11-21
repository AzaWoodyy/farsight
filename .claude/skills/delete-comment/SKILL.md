---
name: delete-comment
description: Audit the code comments of the repository or of the paths given, delete them, move decisions to docs/adr, file issues for excuses, and lower the lint baseline.
disable-model-invocation: true
---

# Delete comment

The code carries no comments: `farsight/no-comments` (`tools/oxlint/farsight`) refuses them, except the ones tools read (`tooling-comments.ts`) and the counts still granted per file in `comment-baseline.json`. This skill empties that baseline, or cleans any path where comments came back. Arguments: paths to limit the audit to; none means every tracked `.ts` and `.tsx` file. `tools/oxlint/anti-slop` is outside the audit and the rule: it is a copy of an upstream plugin (`UPSTREAM.md`), kept identical to its source.

Each comment is one of four things, and its category decides what happens to it:

| Category | What it is | Action |
| --- | --- | --- |
| Tautology | repeats what the code shows | delete |
| Stale | describes code that is gone or changed | delete |
| Excuse | lets a hacky implementation stand | delete, and file an issue for the fix |
| Decision record | an important, non-obvious decision | move into `docs/adr`, then delete |

[CLASSIFY.md](CLASSIFY.md) holds the definitions, the bar for each category and the output format. A subagent classifying a slice reads it in full; read it yourself before judging its work.

## Steps

1. **Extract.** On a `<type>/<subject>` branch, run `bun .claude/skills/delete-comment/scripts/extract.ts <work-dir> [path…]` with a new work directory outside the repository (an extraction never reuses one: ids restart at zero). It writes `comments.json` (every comment with its id and position) and `slices/NN.md` (about 200 comments each, whole files). Done when it prints the totals; keep them for the report.

2. **Classify.** Every id gets exactly one category, written to `<work-dir>/out/NN.json` in the format of CLASSIFY.md. One slice: do it yourself. Several: one subagent per slice, in parallel, each given CLASSIFY.md, its slice and its output path, and told to edit nothing. Done when every id of `comments.json` appears once across `out/`, every `D` names an ADR draft or an existing document, and every `E` names an issue draft.

3. **Review the edges.** Read every `S`, `E` and `U` item against the code, and each "doubtful" note the classifiers returned. For a `D` sent to an existing document, open the document: a detail it lacks becomes an ADR rule. `U` stays in the code and in the baseline; say why in the report.

4. **Write the ADRs.** One file per decision area in `docs/adr`, numbered after the highest existing one, title then one to three sentences then `## Rules`. Extend an existing ADR of the same area instead of opening a second one, and merge drafts of two slices that record the same decision. Add each new file to `docs/adr/README.md`. Done when every `D` id is traceable to a sentence of a file under `docs/` or to AGENTS.md.

5. **Delete.** `bun .claude/skills/delete-comment/scripts/apply.ts <work-dir>` removes every `T`, `S`, `E` and `D` comment by position. It writes nothing when an id is missing, classified twice or given an unknown category, or when a file changed since the extraction. Then set `tools/oxlint/farsight/comment-baseline.json` to the counts that remain (a file at zero leaves the list); the rule fails on an entry higher than its file. When a document names a deleted comment as the place a definition lives, point it at the ADR.

6. **File the issues.** One GitHub issue per underlying problem, from the `issues` drafts: where, what the shortcut is, why it is a problem, what the fix looks like. Search the open issues first and comment on a match instead of duplicating it. The repository is public: no personal data, no visitor question.

7. **Verify.** `bun run verify` on a Postgres server (`docs/postgres.md`). A deletion changes no behavior, so a red check points at a comment a tool was reading: restore it and add its marker to `tooling-comments.ts`.

8. **Report.** Counts per category, lines shed (`git diff --shortstat`), the ADRs written, the issues filed with their links, what stays in the baseline and why, and the comments outside the rule's reach (CSS, SQL, YAML, Python; the migrations under `db/migrations` are checksummed and never edited).
