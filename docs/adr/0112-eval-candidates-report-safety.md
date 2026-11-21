# eval:candidates: keeping visitor questions and keys out of the repository and the logs

`scripts/eval-candidates.ts` reads what visitors typed from Langfuse. The repository is public, so the script is built so that neither the questions nor the Langfuse keys can reach a commit, a log or a model call by accident. `docs/eval-candidates.md` describes the workflow; these are the implementation constraints behind it.

## Rules

- Git is asked where the output directory is with every `GIT_*` variable removed from its environment (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`…): only the path decides the repository, so an inherited override cannot hide a checkout.
- `checkOutDir` works on the physical path (symlinks resolved, `physical`). The report goes into a git checkout (this repository, another worktree of it, any repository) only when git ignores each report file there, and outside a checkout only when git itself says "not a git repository": any other failure of git refuses the directory.
- The report files are created with the `wx` flag: never written through a file or a symlink already there.
- The terminal gets the counts only (`summary`); the questions stay in the report files.
- The `LANGFUSE_*` variables are deleted from `process.env` as soon as they are read, before the agent is imported: the replay never needs them, and with them gone the replayed questions are not traced.
- `OPENROUTER_API_KEY` is deleted before `src/lib/agent/run` is imported (a dynamic import placed after the delete, like `bun run eval --deterministic`): the replay never calls a model. Do not hoist that import.
- A Langfuse API error names the path and the HTTP status, never the request (its URL, query or headers).
- The question is taken from the root observation's input, which is the whole question; the trace metadata keeps only its first 200 characters and is the fallback.
