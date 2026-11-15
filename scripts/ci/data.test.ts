import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { rawTar } from "../data/artifact";
import { extractRaw, restoreSnapshot } from "./data";

function fixture(name: string, type = "0", content = "{}") {
  const header = Buffer.alloc(512);

  header.write(name, 0);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  header.write(type, 156);

  return Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
}

const hash = createHash("sha256").update("{}").digest("hex");

test("raw extraction rejects traversal, symlinks, incomplete datasets and altered content", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-raw-"));
  const tar = join(directory, "raw.tar");
  const out = join(directory, "out");

  try {
    for (const [name, type] of [["../games.json", "0"], ["games.json", "2"]]) {
      writeFileSync(tar, fixture(name, type));
      expect(() => extractRaw(tar, out, { "games.json": hash })).toThrow("Unexpected file");
    }

    writeFileSync(tar, fixture("games.json"));
    expect(() => extractRaw(tar, out, { "games.json": hash, "players.json": hash })).toThrow("Missing raw datasets");
    writeFileSync(tar, fixture("games.json", "0", "[]"));
    expect(() => extractRaw(tar, out, { "games.json": hash })).toThrow("checksum mismatch");
    writeFileSync(tar, fixture("games.json"));
    extractRaw(tar, out, { "games.json": hash });
    expect(readFileSync(join(out, "games.json"), "utf8")).toBe("{}");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * A checkout whose release assets are already in the CI cache, so `restoreSnapshot` never calls `gh`: the raw
 * datasets are either committed (`ci/raw.tar.zst`) or a fourth release asset.
 */
function checkout(form: "file" | "asset") {
  const root = mkdtempSync(join(tmpdir(), "ci-snapshot-"));
  const cache = join(root, ".ci-data");
  mkdirSync(join(root, "ci"));
  mkdirSync(cache);

  const sqlite = join(root, "built.sqlite");
  const db = new DatabaseSync(sqlite);
  db.exec("PRAGMA user_version = 6; CREATE TABLE t (x);");
  db.close();
  const database = readFileSync(sqlite);
  const compressed = zstdCompressSync(database);
  writeFileSync(join(cache, "lol.sqlite.zst"), compressed);
  const ingame = zstdCompressSync(Buffer.from('{"game":"a"}\n'));
  writeFileSync(join(cache, "ingame.jsonl.zst"), ingame);

  const datasets = { "games.json": Buffer.from('[{"id":1}]'), "runs.json": Buffer.from("[]") };
  const archive = zstdCompressSync(rawTar(Object.entries(datasets).map(([name, data]) => ({ name, data }))));
  const files = Object.fromEntries(Object.entries(datasets).map(([name, data]) => [name, sha(data)]));
  writeFileSync(form === "file" ? join(root, "ci/raw.tar.zst") : join(cache, "raw.tar.zst"), archive);

  writeFileSync(join(root, "ci/data.json"), JSON.stringify({
    repository: "AzaWoodyy/farsight",
    tag: "data-20261115",
    schemaVersion: 6,
    database: { asset: "lol.sqlite.zst", sha256: sha(compressed), uncompressedSha256: sha(database) },
    ingame: { asset: "ingame.jsonl.zst", sha256: sha(ingame) },
    raw: form === "file" ? { file: "ci/raw.tar.zst", sha256: sha(archive), files } : { asset: "raw.tar.zst", sha256: sha(archive), files },
  }));

  return { root, cache };
}

for (const form of ["file", "asset"] as const) {
  test(`the rebuild inputs restore from a raw archive given as a ${form === "file" ? "committed file" : "release asset"}`, async () => {
    const { root, cache } = checkout(form);

    try {
      await restoreSnapshot(true, cache, root);
      expect(readFileSync(join(root, "data/raw/games.json"), "utf8")).toBe('[{"id":1}]');
      expect(readFileSync(join(root, "data/raw/runs.json"), "utf8")).toBe("[]");
      expect(readFileSync(join(root, "data/raw/ingame.jsonl"), "utf8")).toBe('{"game":"a"}\n');
      expect(readFileSync(join(root, "data/lol.sqlite"))).toEqual(readFileSync(join(root, "built.sqlite")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a raw release asset whose bytes differ from the pinned hash is refused", async () => {
  const { root, cache } = checkout("asset");

  try {
    writeFileSync(join(cache, "raw.tar.zst"), zstdCompressSync(Buffer.from("other")));
    await expect(restoreSnapshot(true, cache, root)).rejects.toThrow("Snapshot checksum mismatch: raw.tar.zst");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a raw entry naming both a committed file and a release asset is refused", async () => {
  const { root, cache } = checkout("asset");

  try {
    const snapshot = JSON.parse(readFileSync(join(root, "ci/data.json"), "utf8"));
    writeFileSync(join(root, "ci/data.json"), JSON.stringify({ ...snapshot, raw: { ...snapshot.raw, file: "ci/raw.tar.zst" } }));
    await expect(restoreSnapshot(true, cache, root)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
