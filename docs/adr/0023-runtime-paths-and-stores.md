# Paths chosen at runtime and what a store may log

The object store has a local implementation (`FsStore`) whose root is only known at runtime, and the app is deployed as traced Vercel functions under a size budget. Next's file tracer follows `path.resolve` calls it can see.

## Rules

- Every `resolve` on a runtime-chosen root carries the `/*turbopackIgnore: true*/` magic comment: `FsStore.path` and `FsStore.list` in `src/lib/storage/index.ts`, and `LOCAL_DIR` in `src/lib/storage/timelines.ts` (`process.cwd()`). Without it the tracer cannot tell which files the call reaches and ships the whole project with the `/api/ask` function, far over the size budget `bun run size` enforces.
- `LOCAL_DIR` (`data/raw/riot`, the ingestion cache) is read only in local runs, when R2 is not configured and `VERCEL` is not `1`. It is never shipped: `next.config.ts` excludes `./data/**` from the traced functions (`outputFileTracingExcludes`).
- `ObjectStore.label` is the short description a store gives for logs and traces (`fs:<root>`, `r2:<bucket>`). It must never contain a secret: no access key, no signed URL.
