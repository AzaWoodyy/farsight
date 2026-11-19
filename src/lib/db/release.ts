import { z } from "zod";
import { openDb, selectOne } from "./index";

/**
 * Day (UTC, `YYYY-MM-DD`) the shipped database was built: the last `build` run recorded in the file itself.
 * `Data release` builds and publishes in one run, so this is the day of the `data-YYYYMMDD` release the
 * deployment ships, read from the file `data:pull` verified rather than from the clock of the site's build.
 * Null when the file records no build or an unreadable date.
 */
export function dataReleaseDay(db = openDb()): string | null {
  const run = selectOne(db, z.object({ finished_at: z.string() }), "SELECT finished_at FROM ingest_runs WHERE kind = 'build' ORDER BY id DESC LIMIT 1");

  return utcDay(run?.finished_at ?? null);
}

/** The UTC day (`YYYY-MM-DD`) of a recorded time, null when it is missing or unreadable. */
export function utcDay(recorded: string | null): string | null {
  const time = recorded ? Date.parse(recorded) : Number.NaN;

  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}
