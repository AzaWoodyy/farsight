/** Restore the immutable eval snapshot; rebuild inputs never contact the wiki or R2. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sha256File } from "../data/artifact";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Asset = z.object({ asset: z.enum(["lol.sqlite.zst", "ingame.jsonl.zst"]), sha256: Sha });

const Snapshot = z.object({
  repository: z.literal("AzaWoodyy/lol-esports-agent"),
  tag: z.string().regex(/^data-\d{8}(-\d+)?$/),
  schemaVersion: z.number().int().positive(),
  database: Asset.extend({ uncompressedSha256: Sha }),
  ingame: Asset,
  raw: z.object({ file: z.literal("ci/raw.tar.zst"), sha256: Sha, files: z.record(z.string().regex(/^[a-z_]+\.json$/), Sha) }),
});

async function checked(file: string, hash: string) {
  if (await sha256File(file) !== hash) throw new Error(`Snapshot checksum mismatch: ${basename(file)}`);
}

/** Our deterministic USTAR archive only contains regular files with explicitly allowed names. */
export function extractRaw(tar: string, destination: string, hashes: Record<string, string>) {
  const fd = openSync(tar, "r");
  const header = Buffer.alloc(512);
  const chunk = Buffer.alloc(1024 * 1024);
  const seen = new Set<string>();
  let position = 0;
  mkdirSync(destination, { recursive: true });

  try {
    while (readSync(fd, header, 0, 512, position) === 512 && header.some(byte => byte !== 0)) {
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
      const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, "");

      if (!(name in hashes) || seen.has(name) || prefix || ![0, 48].includes(header[156]) || !Number.isSafeInteger(size) || size < 0 || size > 400e6) {
        throw new Error("Unexpected file in the raw snapshot archive");
      }

      const hash = createHash("sha256");
      const target = openSync(resolve(destination, name), "w");
      position += 512;

      try {
        let remaining = size;

        while (remaining > 0) {
          const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), position + size - remaining);

          if (!bytes) throw new Error("Truncated raw snapshot archive");
          hash.update(chunk.subarray(0, bytes));
          writeSync(target, chunk, 0, bytes);
          remaining -= bytes;
        }
      } finally {
        closeSync(target);
      }

      if (hash.digest("hex") !== hashes[name]) throw new Error(`Raw dataset checksum mismatch: ${name}`);
      seen.add(name);
      position += Math.ceil(size / 512) * 512;
    }

    if (seen.size !== Object.keys(hashes).length) throw new Error("Missing raw datasets in the snapshot archive");
  } finally {
    closeSync(fd);
  }
}

export async function restoreSnapshot(raw: boolean, cache = ".ci-data") {
  const snapshot = Snapshot.parse(JSON.parse(readFileSync("ci/data.json", "utf8")));
  const directory = resolve(cache);
  mkdirSync(directory, { recursive: true });
  mkdirSync("data", { recursive: true });

  for (const asset of [snapshot.database, ...(raw ? [snapshot.ingame] : [])]) {
    const file = resolve(directory, asset.asset);

    if (!existsSync(file)) {
      execFileSync("gh", ["release", "download", snapshot.tag, "--repo", snapshot.repository, "--pattern", asset.asset, "--dir", directory], { stdio: "inherit" });
    }

    await checked(file, asset.sha256);
  }

  const database = resolve(directory, "lol.sqlite");
  execFileSync("zstd", ["-d", "-q", "-f", resolve(directory, snapshot.database.asset), "-o", database]);
  await checked(database, snapshot.database.uncompressedSha256);
  const db = new DatabaseSync(database, { readOnly: true });

  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const journal = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;

    if (version !== snapshot.schemaVersion || journal !== "delete" || integrity !== "ok") throw new Error("Invalid SQLite snapshot");
  } finally {
    db.close();
  }

  copyFileSync(database, "data/lol.sqlite");

  if (raw) {
    await checked(snapshot.raw.file, snapshot.raw.sha256);
    const tar = resolve(directory, "raw.tar");
    execFileSync("zstd", ["-d", "-q", "-f", snapshot.raw.file, "-o", tar]);

    try {
      extractRaw(tar, resolve("data/raw"), snapshot.raw.files);
    } finally {
      rmSync(tar, { force: true });
    }

    execFileSync("zstd", ["-d", "-q", "-f", resolve(directory, snapshot.ingame.asset), "-o", resolve("data/raw/ingame.jsonl")]);
  }

  const summary = `CI snapshot: ${snapshot.repository}@${snapshot.tag}, schema ${snapshot.schemaVersion}, SHA-256 verified${raw ? ", offline rebuild inputs restored" : ""}\n`;
  console.log(summary.trim());

  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
}

if (import.meta.main) await restoreSnapshot(process.argv.includes("--raw"));
