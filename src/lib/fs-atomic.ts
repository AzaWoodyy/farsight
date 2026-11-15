import { renameSync, writeFileSync } from "node:fs";

/**
 * Writes a temporary file next to `file`, then renames it over `file`: an
 * interrupted run leaves either the previous file or the complete new one,
 * never half a file. The directory must exist.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
