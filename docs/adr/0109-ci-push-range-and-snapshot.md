# CI on main compares a push with the newest validated ancestor

A push on `main` only runs the checks its changed paths select (`scripts/ci/affected.ts`). The range it compares is not the pushed range GitHub reports: it starts at the last commit whose `main` run succeeded, so the paths of a failed or cancelled run are never skipped by the run after it. The same scripts restore the pinned data snapshot the checks load.

## Rules

- `pushBase` (`scripts/ci/affected.ts`) returns the newest commit with a successful `main` run that is an ancestor of the pushed commit, or null, and null means every check runs (`scripts/ci/select.ts`).
- A candidate must be an ancestor of the pushed commit: a commit force-pushed away from `main` is no longer one and cannot be a base.
- The pushed commit itself is never a base (`sha !== after`): a re-run of that commit would otherwise compare it with itself and select nothing.
- A run only proves its own range when it selected its checks with this rule. The run of a commit used that commit's own `select.ts`, so `select.ts` reads `scripts/ci/select.ts` at each candidate (`git show <sha>:scripts/ci/select.ts`) and accepts it only when it calls `pushBase(`. A green run from before the rule may have skipped a failed range, so older runs are never a base and the first push under the rule runs every check. Keep the `pushBase(` call in `select.ts`: removing or renaming it invalidates every earlier run as a base.
- `extractRaw` (`scripts/ci/data.ts`) reads `ci/raw.tar.zst` with its own minimal USTAR reader instead of `tar`: the archive is produced deterministically by the project and only holds regular files whose names are listed with their SHA-256 in `ci/data.json`. Anything else (an unlisted or repeated name, a path prefix, a non-regular entry, a size above 400 MB) is refused, and each file is checked against its hash as it is written.
